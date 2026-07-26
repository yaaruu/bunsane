import db from "../../database";
import { timedUnsafe } from "../../database/instrumentedDb";
import { logger } from "../../core/Logger";
import type { ProjectionStatus } from "../../database/projection/types";

interface CachedState {
    status: ProjectionStatus;
    shapeVersion: number;
    shapeHash: string;
    fieldState: Record<string, 'FILLING' | 'READY'>;
}

const TTL_MS = 30_000;

/**
 * Wall clock for the refresh query itself. This is a single unindexed read of a
 * table with one row per archetype — generous at 5 s, and no new env knob:
 * anything slower than this is a symptom to surface, not a value to tune.
 */
const REFRESH_TIMEOUT_MS = 5_000;

/** Consecutive failures before the log level escalates from warn to error. */
const FAILURES_BEFORE_ERROR = 3;

/**
 * `field_state` is jsonb, but depending on driver/column typing it can arrive as a JSON STRING
 * rather than a parsed object. Every consumer does key lookups on it (`fieldState[columnName]`),
 * and those return undefined on a string — silently reporting every column READY and defeating
 * the FILLING gate for filtering, sorting AND hydration. Normalize once, here.
 */
function parseFieldState(raw: unknown): Record<string, 'FILLING' | 'READY'> {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            logger.warn({ scope: 'qsp.cache' }, 'Unparseable projection_state.field_state; treating as empty');
            return {};
        }
    }
    return typeof raw === 'object' ? (raw as Record<string, 'FILLING' | 'READY'>) : {};
}

export class PlannerCache {
    static #instance: PlannerCache | null = null;

    static get instance(): PlannerCache {
        return (this.#instance ??= new PlannerCache());
    }

    private states = new Map<string, CachedState>();
    private lastRefresh = 0;
    private inFlight: Promise<void> | null = null;
    private consecutiveFailures = 0;

    private constructor() {}

    /**
     * Refresh is called fire-and-forget from `getState()` on the read hot path,
     * so it must be bounded and single-flight:
     *
     *   - BOUNDED: it used to run `db.unsafe(...)` with no signal and no
     *     timeout. A hung refresh held a pool slot indefinitely, from a code
     *     path nobody awaits.
     *   - SINGLE-FLIGHT: without this, every query arriving while a slow
     *     refresh is outstanding starts another one, so a slow projection_state
     *     read amplifies into one query per request.
     *   - LOUD: failure used to log at `warn` and return, leaving the planner
     *     serving a silently stale map. In production this failed 523/523 times
     *     from boot and read as noise. Repeated failure is now an `error` with
     *     the consecutive count and how stale the map is.
     */
    async refresh(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async doRefresh(): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new Error(`PlannerCache refresh timeout after ${REFRESH_TIMEOUT_MS}ms`)),
            REFRESH_TIMEOUT_MS,
        );
        (timer as unknown as { unref?: () => void }).unref?.();
        try {
            const rows = await timedUnsafe<any[]>(
                db,
                `SELECT archetype, status, shape_version, shape_hash, field_state FROM projection_state`,
                [],
                controller.signal,
            );
            this.states.clear();
            for (const row of rows) {
                this.states.set(row.archetype, {
                    status: (row.status as ProjectionStatus) ?? 'DISABLED',
                    shapeVersion: row.shape_version ?? 1,
                    shapeHash: row.shape_hash ?? '',
                    fieldState: parseFieldState(row.field_state),
                });
            }
            if (this.consecutiveFailures > 0) {
                logger.info(
                    { scope: 'qsp.cache', afterFailures: this.consecutiveFailures },
                    'PlannerCache refresh recovered',
                );
            }
            this.consecutiveFailures = 0;
            this.lastRefresh = Date.now();
        } catch (err) {
            this.consecutiveFailures++;
            const staleForMs = this.lastRefresh === 0 ? null : Date.now() - this.lastRefresh;
            const details = {
                scope: 'qsp.cache',
                err,
                consecutiveFailures: this.consecutiveFailures,
                staleForMs,
                neverLoaded: this.lastRefresh === 0,
            };
            if (this.consecutiveFailures >= FAILURES_BEFORE_ERROR) {
                logger.error(
                    details,
                    'PlannerCache refresh failing repeatedly — projection routing decisions are ' +
                    'being made from a stale (or empty) projection_state map',
                );
            } else {
                logger.warn(details, 'PlannerCache refresh failed');
            }
        } finally {
            clearTimeout(timer);
        }
    }

    getState(archetype: string): CachedState | undefined {
        const now = Date.now();
        if (now - this.lastRefresh > TTL_MS) {
            void this.refresh();
        }
        return this.states.get(archetype);
    }

    getStatus(archetype: string): ProjectionStatus {
        return this.getState(archetype)?.status ?? 'DISABLED';
    }

    invalidate(archetype?: string): void {
        if (archetype) {
            this.states.delete(archetype);
        } else {
            this.states.clear();
        }
        this.lastRefresh = 0;
    }

    static reset(): void {
        this.#instance = null;
    }

    // SEAM (P4): cross-instance invalidation via Redis pub/sub plugs in here — call invalidate() on a projection_state change event.
}
