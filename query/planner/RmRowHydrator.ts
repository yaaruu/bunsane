import ComponentRegistry from "../../core/components/ComponentRegistry";
import { addComponent } from "../../core/entity/componentAccess";
import { coerceProjectedValue } from "../../database/projection/projectEntity";
import type { Entity } from "../../core/Entity";
import type { BaseComponent } from "../../core/components/BaseComponent";
import type { ProjectedColumn } from "../../database/projection/types";
import type { RmHydrationPlan } from "./RmHydrationPlan";

/**
 * Rebuilds components from an `rm_` row instead of re-reading `components`.
 *
 * Deliberately mirrors the legacy loader (`core/entity/finders.ts` loadComponents) step for
 * step — construct, assign, set id, setPersisted(true), setDirty(false), addComponent — so a
 * row-hydrated component is indistinguishable from a JSONB-loaded one. Any divergence here
 * shows up as a mutate-and-save bug far from this file, so keep the two in sync.
 */
export function buildComponentFromRow(
    componentName: string,
    columns: ProjectedColumn[],
    row: Record<string, any>
): BaseComponent | null {
    const ctor = ComponentRegistry.getConstructorByName(componentName);
    if (!ctor) return null;

    const comp = new ctor();
    for (const col of columns) {
        (comp as any)[col.field] = coerceProjectedValue(row[col.columnName], col.sqlType);
    }
    return comp as BaseComponent;
}

/**
 * Attach every component the plan covers to `entity`, sourced entirely from `row`.
 * Returns the component names actually hydrated so the caller can compute the populate delta.
 *
 * `comp.id` MUST already be present on the row (a `component_id` column). A component with no
 * id that is later mutated and saved takes the insert branch, mints a fresh uuid, and misses
 * the `(id, type_id)` upsert conflict target — permanently duplicating its `components` row.
 * Rather than risk that silently, a component whose id is absent is skipped and left to the
 * legacy loader.
 */
export function hydrateEntityFromRow(
    entity: Entity,
    row: Record<string, any>,
    plan: RmHydrationPlan
): string[] {
    const hydrated: string[] = [];

    for (const [componentName, columns] of plan.components) {
        const idColumn = plan.idColumns.get(componentName);
        if (!idColumn) continue;

        const componentId = row[idColumn];
        if (!componentId) continue; // never serve a component that cannot be safely re-saved

        const comp = buildComponentFromRow(componentName, columns, row);
        if (!comp) continue;

        comp.id = String(componentId);
        comp.setPersisted(true);
        comp.setDirty(false);
        addComponent(entity, comp);
        hydrated.push(componentName);
    }

    return hydrated;
}
