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
                    fieldState: (row.field_state as Record<string, 'FILLING' | 'READY'>) ?? {},
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
