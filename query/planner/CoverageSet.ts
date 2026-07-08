import type { QueryContext } from "../QueryContext";
import { ComponentRegistry } from "../../core/components";
import type { CoverageRequest, CoverageFilter, CoverageSort, CoverageCursor } from "./CoverageRequest";

export function buildCoverageRequest(context: QueryContext): CoverageRequest {
    const requiredComponentIds = Array.from(context.componentIds);
    const requiredComponentNames = requiredComponentIds
        .map(id => ComponentRegistry.getComponentName(id))
        .filter((name): name is string => Boolean(name));

    const filters: CoverageFilter[] = [];
    for (const [typeId, flts] of context.componentFilters.entries()) {
        const component = ComponentRegistry.getComponentName(typeId) ?? '';
        for (const f of flts) {
            filters.push({
                typeId,
                component,
                field: f.field,
                operator: f.operator,
                value: f.value,
            });
        }
    }

    const sorts: CoverageSort[] = [];
    for (const s of context.sortOrders) {
        sorts.push({
            kind: 'component',
            component: s.component,
            field: s.property,
            direction: s.direction,
            nullsFirst: !!s.nullsFirst,
        });
    }
    for (const s of context.entitySortOrders) {
        sorts.push({
            kind: 'entity',
            field: s.field,
            direction: s.direction,
            nullsFirst: !!s.nullsFirst,
        });
    }

    let cursor: CoverageCursor | undefined;
    if (context.compositeCursor) {
        cursor = {
            kind: 'keyset',
            v: context.compositeCursor.v,
            id: context.compositeCursor.id,
            direction: context.cursorDirection,
        };
    } else if (context.cursorId) {
        cursor = {
            kind: 'id',
            id: context.cursorId,
            direction: context.cursorDirection,
        };
    }

    return {
        requiredComponentIds,
        requiredComponentNames,
        filters,
        sorts,
        cursor,
        excludedComponentIds: Array.from(context.excludedComponentIds),
        excludedEntityIds: Array.from(context.excludedEntityIds),
        withId: context.withId,
        hasOrQuery: context.hasOrQuery,
        limit: context.limit,
        offset: context.offsetValue,
    };
}
