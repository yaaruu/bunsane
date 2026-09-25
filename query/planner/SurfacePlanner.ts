import type { CoverageRequest } from "./CoverageRequest";
import { ProjectionManager } from "../../database/projection/ProjectionManager";
import { deriveProjectedColumns } from "../../database/projection/ProjectionMetadata";
import { qspActive, qspInScope } from "../../database/projection/qspConfig";
import { getMetadataStorage } from "../../core/metadata";
import type { ProjectedColumn, ProjectionStatus } from "../../database/projection/types";
import { PlannerCache } from "./PlannerCache";

export interface PlanResolution {
    surface: 'rm' | 'legacy';
    archetype?: string;
    status?: ProjectionStatus;
    triggerArchetype?: string;
}

export class SurfacePlanner {
    static #instance: SurfacePlanner | null = null;

    static get instance(): SurfacePlanner {
        return (this.#instance ??= new SurfacePlanner());
    }

    /**
     * Pure coverage predicate over an archetype's projected columns - independent of whether an
     * rm_ table exists yet (used both for READY/SHADOW routing and for NONE lazy-trigger detection).
     */
    private isCovered(
        columns: ProjectedColumn[],
        req: CoverageRequest,
        fieldState: Record<string, 'FILLING' | 'READY'>
    ): boolean {
        const archetypeComponentSet = new Set(columns.map(c => c.component));
        const reqSet = new Set(req.requiredComponentNames);
        // Exact component-set match guarantees rm_ membership == legacy membership.
        if (reqSet.size !== archetypeComponentSet.size) return false;
        for (const n of reqSet) if (!archetypeComponentSet.has(n)) return false;

        const columnLookup = new Map<string, ProjectedColumn>();
        for (const col of columns) columnLookup.set(`${col.component}:${col.field}`, col);

        const supportedOps = new Set(['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN']);
        for (const f of req.filters) {
            if (!supportedOps.has(f.operator)) return false;
            const col = columnLookup.get(`${f.component}:${f.field}`);
            if (!col) return false;
            const fs = fieldState[col.columnName] ?? fieldState[col.field] ?? fieldState[`${col.component}:${col.field}`];
            if (fs === 'FILLING') return false;
            if ((f.operator === 'IN' || f.operator === 'NOT IN') && (!Array.isArray(f.value) || f.value.length === 0)) return false;
        }

        if (req.sorts.length > 1) return false;
        if (req.sorts.length === 1) {
            const s = req.sorts[0]!;
            if (s.kind === 'component') {
                const col = columnLookup.get(`${s.component}:${s.field}`);
                if (!col) return false;
                // uuid __cid columns are hydration ids, not sort keys.
                if (col.sqlType === 'uuid' || col.kind === 'component_id') return false;
                const fs = fieldState[col.columnName] ?? fieldState[col.field] ?? fieldState[`${col.component}:${col.field}`];
                if (fs === 'FILLING') return false;
            }
        }

        if (req.cursor) {

            if (req.cursor.kind === 'keyset') { if (req.sorts.length !== 1) return false; }
            else if (req.cursor.kind === 'id') { if (req.sorts.length !== 0) return false; }
        }
        return true;
    }

    resolve(req: CoverageRequest): PlanResolution {
        if (!qspActive()) return { surface: 'legacy' };
        if (req.hasOrQuery || req.withId || req.excludedComponentIds.length > 0 || req.excludedEntityIds.length > 0) {
            return { surface: 'legacy' };
        }

        // 1) Active projections known to this instance (SHADOW/READY) - route READY, report SHADOW.
        for (const archetype of ProjectionManager.instance.getArchetypeNames()) {
            if (!qspInScope(archetype)) continue;
            const descriptor = ProjectionManager.instance.getDescriptor(archetype);
            if (!descriptor) continue;
            const status = PlannerCache.instance.getStatus(archetype);
            if (status !== 'READY' && status !== 'SHADOW') continue;
            const fieldState = PlannerCache.instance.getState(archetype)?.fieldState ?? {};
            if (this.isCovered(descriptor.columns, req, fieldState)) {
                return { surface: 'rm', archetype, status };
            }
        }

        // 2) Lazy trigger: an in-scope registered archetype that WOULD cover this query but has no
        //    active projection yet. Coverage derives columns from archetype metadata - no rm_ needed.
        const storage = getMetadataStorage();
        for (const a of storage.archetypes) {
            const name = a.name;
            if (!qspInScope(name)) continue;
            const status = PlannerCache.instance.getStatus(name);
            if (status === 'BACKFILLING' || status === 'SHADOW' || status === 'READY') continue; // already handled/active
            let columns: ProjectedColumn[];
            try { columns = deriveProjectedColumns(name, storage); } catch { continue; }
            if (columns.length === 0) continue;
            if (this.isCovered(columns, req, {})) {
                return { surface: 'legacy', triggerArchetype: name };
            }
        }

        return { surface: 'legacy' };
    }

    static reset(): void {
        this.#instance = null;
    }
}
