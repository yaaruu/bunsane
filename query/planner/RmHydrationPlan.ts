import { fullyColumnarComponents } from "../../database/projection/ProjectionMetadata";
import { COMPONENT_ID_FIELD } from "../../database/projection/types";
import type { ProjectedColumn, ProjectionDescriptor, FieldReadiness } from "../../database/projection/types";

/**
 * Which components of an `rm_` row may be rebuilt from that row alone, and the columns needed
 * to do it. Everything not listed here still comes from `components`.
 *
 * The set is computed ONCE and drives both the SELECT list and the hydration loop, so the
 * columns fetched and the columns consumed can never disagree.
 */
export interface RmHydrationPlan {
    /** component name -> the columns that rebuild it. Empty map = hydrate nothing from the row. */
    components: Map<string, ProjectedColumn[]>;
    /** Flat column list for the SELECT. Empty = select entity_id only, exactly as before. */
    columns: ProjectedColumn[];
    /**
     * component name -> the column carrying that component's `components.id`.
     * A component missing an entry here may be COMPARED but never SERVED: without its real id
     * a mutate-and-save would insert a duplicate `components` row instead of updating.
     * Populated once component ids are projected.
     */
    idColumns: Map<string, string>;
}

export const EMPTY_HYDRATION_PLAN: RmHydrationPlan = {
    components: new Map(),
    columns: [],
    idColumns: new Map(),
};

/** F1 gate is metadata-derived and stable for a given shape; fieldState is not, so only this is cached. */
const fullyColumnarCache = new Map<string, Set<string>>();

function cachedFullyColumnar(archetype: string, shapeHash: string): Set<string> {
    const key = `${archetype}:${shapeHash}`;
    let set = fullyColumnarCache.get(key);
    if (!set) {
        set = fullyColumnarComponents(archetype);
        fullyColumnarCache.set(key, set);
    }
    return set;
}

export function resetHydrationPlanCache(): void {
    fullyColumnarCache.clear();
}

/**
 * Build the hydration plan for an archetype.
 *
 * Two gates, both per-COMPONENT rather than per-query — a query over {Order, Customer} where
 * only Customer is hydratable still serves Customer from the row and reads only Order:
 *
 *   F1  the component's entire @CompData surface must be projected (see fullyColumnarComponents).
 *   F3  none of its columns may be FILLING. `isCovered` checks readiness only for FILTER and SORT
 *       columns; a column needed purely to REBUILD a component is unchecked there, so mid-backfill
 *       it would hydrate stale/NULL data into a served component while the query still routes.
 *       A FILLING column drops its component from the plan — it does NOT un-route the query.
 */
export function resolveHydrationPlan(
    archetype: string,
    descriptor: ProjectionDescriptor,
    fieldState: Record<string, FieldReadiness> = {}
): RmHydrationPlan {
    const fullyColumnar = cachedFullyColumnar(archetype, descriptor.shapeHash);
    if (fullyColumnar.size === 0) return EMPTY_HYDRATION_PLAN;

    const byComponent = new Map<string, ProjectedColumn[]>();
    const idColumnByComponent = new Map<string, string>();
    for (const col of descriptor.columns) {
        if (!fullyColumnar.has(col.component)) continue;
        if (col.kind === 'component_id') {
            idColumnByComponent.set(col.component, col.columnName);
            continue; // carried separately — it is not a @CompData field
        }
        let cols = byComponent.get(col.component);
        if (!cols) {
            cols = [];
            byComponent.set(col.component, cols);
        }
        cols.push(col);
    }

    // Same triple-key lookup as SurfacePlanner.isCovered — field_state keys are not normalized.
    const isFilling = (col: ProjectedColumn): boolean => {
        const fs = fieldState[col.columnName]
            ?? fieldState[col.field]
            ?? fieldState[`${col.component}:${col.field}`];
        return fs === 'FILLING';
    };

    const components = new Map<string, ProjectedColumn[]>();
    const idColumns = new Map<string, string>();
    const columns: ProjectedColumn[] = [];
    for (const [component, cols] of byComponent) {
        if (cols.some(isFilling)) continue;
        components.set(component, cols);
        columns.push(...cols);

        // Carry the id column so the hydrated component can be mutated and saved. Without it
        // hydrateEntityFromRow skips the component rather than risk a duplicate insert.
        const idColumn = idColumnByComponent.get(component);
        if (idColumn) {
            idColumns.set(component, idColumn);
            columns.push({
                component,
                field: COMPONENT_ID_FIELD,
                sqlType: 'uuid',
                columnName: idColumn,
                kind: 'component_id',
            });
        }
    }

    if (components.size === 0) return EMPTY_HYDRATION_PLAN;
    return { components, columns, idColumns };
}
