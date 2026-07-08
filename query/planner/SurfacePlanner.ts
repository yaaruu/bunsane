import type { CoverageRequest } from "./CoverageRequest";
import { ProjectionManager } from "../../database/projection/ProjectionManager";
import type { ProjectedColumn, ProjectionStatus } from "../../database/projection/types";
import { PlannerCache } from "./PlannerCache";

export interface PlanResolution {
    surface: 'rm' | 'legacy';
    archetype?: string;
    status?: ProjectionStatus;
}

export class SurfacePlanner {
    static #instance: SurfacePlanner | null = null;

    static get instance(): SurfacePlanner {
        return (this.#instance ??= new SurfacePlanner());
    }

    resolve(req: CoverageRequest): PlanResolution {
        if (!ProjectionManager.enabled) {
            return { surface: 'legacy' };
        }
        if (req.hasOrQuery || req.withId || req.excludedComponentIds.length > 0 || req.excludedEntityIds.length > 0) {
            return { surface: 'legacy' };
        }

        const candidates = ProjectionManager.instance.getArchetypeNames();
        for (const archetype of candidates) {
            const descriptor = ProjectionManager.instance.getDescriptor(archetype);
            if (!descriptor) continue;

            const archetypeComponentSet = new Set(descriptor.columns.map(c => c.component));
            const reqSet = new Set(req.requiredComponentNames);
            // P3: exact component-set match guarantees rm_ membership == legacy membership. RFC's superset rule is unsafe until membership-aware routing lands in P4.
            if (reqSet.size !== archetypeComponentSet.size) continue;
            let setsEqual = true;
            for (const n of reqSet) {
                if (!archetypeComponentSet.has(n)) {
                    setsEqual = false;
                    break;
                }
            }
            if (!setsEqual) continue;

            const status = PlannerCache.instance.getStatus(archetype);
            if (status !== 'READY') continue;

            const columnLookup = new Map<string, ProjectedColumn>();
            for (const col of descriptor.columns) {
                columnLookup.set(`${col.component}:${col.field}`, col);
            }
            const fieldState = PlannerCache.instance.getState(archetype)?.fieldState ?? {};

            // Filters
            let filtersOk = true;
            const supportedOps = new Set(['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN']);
            for (const f of req.filters) {
                if (!supportedOps.has(f.operator)) {
                    filtersOk = false;
                    break;
                }
                const col = columnLookup.get(`${f.component}:${f.field}`);
                if (!col) {
                    filtersOk = false;
                    break;
                }
                const fs = fieldState[col.columnName] ?? fieldState[col.field] ?? fieldState[`${col.component}:${col.field}`];
                if (fs === 'FILLING') {
                    filtersOk = false;
                    break;
                }
                if ((f.operator === 'IN' || f.operator === 'NOT IN') && (!Array.isArray(f.value) || f.value.length === 0)) {
                    filtersOk = false;
                    break;
                }
            }
            if (!filtersOk) continue;

            // Sorts: P3 at most one
            if (req.sorts.length > 1) continue;
            if (req.sorts.length === 1) {
                const s = req.sorts[0]!;
                if (s.kind === 'component') {
                    const col = columnLookup.get(`${s.component}:${s.field}`);
                    if (!col) continue;
                    const fs = fieldState[col.columnName] ?? fieldState[col.field] ?? fieldState[`${col.component}:${col.field}`];
                    if (fs === 'FILLING') continue;
                }
                // entity kind always ok (created_at/updated_at)
                if (req.cursor && req.cursor.kind === 'keyset' && s.nullsFirst) continue;
            }

            // Cursor
            if (req.cursor) {
                if (req.cursor.direction !== 'after') continue;
                if (req.cursor.kind === 'keyset') {
                    if (req.sorts.length !== 1) continue;
                } else if (req.cursor.kind === 'id') {
                    if (req.sorts.length !== 0) continue;
                }
            }

            return { surface: 'rm', archetype, status: 'READY' };
        }

        return { surface: 'legacy' };
    }

    static reset(): void {
        this.#instance = null;
    }
}
