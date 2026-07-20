import db from "../../database";
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

    private constructor() {}

    async refresh(): Promise<void> {
        try {
            const rows = await db.unsafe(
                `SELECT archetype, status, shape_version, shape_hash, field_state FROM projection_state`
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
            this.lastRefresh = Date.now();
        } catch (err) {
            logger.warn({ scope: 'qsp.cache', err }, 'PlannerCache refresh failed');
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
