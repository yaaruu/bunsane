import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { getMembershipSource, getMembershipTable } from "./membershipSource";
import { shouldUseDirectPartition } from "../core/Config";
import { ComponentRegistry } from "../core/components";
import { buildComponentFilterGroup } from "./FilterBuilder";

export class CTENode extends QueryNode {
    /**
     * Resolve the table to scan for a membership (+ optional field-filter) branch.
     * Non-legacy: components or per-type partition (has `data` → filters pushable).
     * Legacy: entity_components only (no `data` → filters stay outer EXISTS).
     */
    private membershipTableFor(compId: string): { table: string; canPushFilters: boolean } {
        const source = getMembershipSource();
        if (source.isLegacy) {
            return { table: source.table, canPushFilters: false };
        }
        if (shouldUseDirectPartition()) {
            const partition = ComponentRegistry.getPartitionTableName(compId);
            if (partition) {
                return { table: partition, canPushFilters: true };
            }
        }
        return { table: getMembershipTable(), canPushFilters: true };
    }

    public execute(context: QueryContext): QueryResult {
        const componentIds = Array.from(context.componentIds);
        const excludedIds = Array.from(context.excludedComponentIds);

        if (componentIds.length === 0) {
            throw new Error("CTENode requires at least one component type to filter on");
        }

        let anyFilterPushed = false;

        let cursorCondition = "";
        if (context.cursorId !== null) {
            const operator = context.cursorDirection === 'after' ? '>' : '<';
            cursorCondition = ` AND ec.entity_id ${operator} $${context.addParam(context.cursorId)}`;
        }

        let exclusionCondition = "";
        if (excludedIds.length > 0) {
            const membershipTable = getMembershipTable();
            const excludedPlaceholders = excludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            exclusionCondition = ` AND NOT EXISTS (
                SELECT 1 FROM ${membershipTable} ec_ex
                WHERE ec_ex.entity_id = ec.entity_id
                AND ec_ex.type_id IN (${excludedPlaceholders})
                AND ec_ex.deleted_at IS NULL
            )`;
        }

        let entityExclusionCondition = "";
        if (context.excludedEntityIds.size > 0) {
            const entityExcludedIds = Array.from(context.excludedEntityIds);
            const entityPlaceholders = entityExcludedIds.map((id) => `$${context.addParam(id)}`).join(', ');
            entityExclusionCondition = ` AND ec.entity_id NOT IN (${entityPlaceholders})`;
        }

        const buildBranch = (compId: string): string => {
            const { table, canPushFilters } = this.membershipTableFor(compId);
            const paramIdx = context.addParam(compId);
            let subquery =
                `SELECT ec.entity_id FROM ${table} ec WHERE ec.type_id = $${paramIdx}::text AND ec.deleted_at IS NULL`;
            if (canPushFilters) {
                const filters = context.componentFilters.get(compId) ?? [];
                const group = buildComponentFilterGroup(filters, 'ec', context);
                if (group) {
                    subquery += ` AND ${group}`;
                    anyFilterPushed = true;
                }
            }
            if (cursorCondition) subquery += cursorCondition;
            if (exclusionCondition) subquery += exclusionCondition;
            if (entityExclusionCondition) subquery += entityExclusionCondition;
            return subquery;
        };

        let cteSql = "WITH base_entities AS (\n";

        if (componentIds.length === 1) {
            const { table, canPushFilters } = this.membershipTableFor(componentIds[0]!);
            const paramIdx = context.addParam(componentIds[0]!);
            cteSql += `    SELECT DISTINCT ec.entity_id\n`;
            cteSql += `    FROM ${table} ec\n`;
            cteSql += `    WHERE ec.type_id = $${paramIdx}::text\n`;
            cteSql += `    AND ec.deleted_at IS NULL\n`;
            if (canPushFilters) {
                const filters = context.componentFilters.get(componentIds[0]!) ?? [];
                const group = buildComponentFilterGroup(filters, 'ec', context);
                if (group) {
                    cteSql += `    AND ${group}\n`;
                    anyFilterPushed = true;
                }
            }
            if (cursorCondition) cteSql += `    ${cursorCondition.trim()}\n`;
            if (exclusionCondition) cteSql += `    ${exclusionCondition.trim()}\n`;
            if (entityExclusionCondition) cteSql += `    ${entityExclusionCondition.trim()}\n`;
        } else {
            const intersectQueries = componentIds.map((compId) => `(${buildBranch(compId)})`);
            cteSql += `    SELECT entity_id FROM (\n`;
            cteSql += `        ${intersectQueries.join('\n        INTERSECT\n        ')}\n`;
            cteSql += `    ) AS intersected\n`;
        }

        if (anyFilterPushed) {
            context.filtersAppliedInMembership = true;
        }

        // LIMIT/OFFSET + ORDER BY entity_id only when the CTE is the final
        // ordering authority. Outer component/entity sorts re-order the full
        // id set after the CTE — applying LIMIT or an inner ORDER BY here is
        // wasted (or wrong). RP-07: do not emit ORDER BY when pagination is
        // deferred to the outer query.
        const filtersRemainOuter =
            context.componentFilters.size > 0 && !context.filtersAppliedInMembership;
        const hasOuterSort =
            context.sortOrders.length > 0 || context.entitySortOrders.length > 0;

        if (!filtersRemainOuter && !hasOuterSort) {
            const orderDirection = context.cursorDirection === 'before' ? 'DESC' : 'ASC';
            const orderColumn = componentIds.length === 1 ? 'ec.entity_id' : 'entity_id';
            cteSql += `    ORDER BY ${orderColumn} ${orderDirection}\n`;
            if (context.limit !== null) {
                cteSql += `    LIMIT $${context.addParam(context.limit)}\n`;
            }
            if (context.cursorId === null && (context.offsetValue > 0 || context.limit !== null)) {
                cteSql += `    OFFSET $${context.addParam(context.offsetValue)}\n`;
            }
            context.paginationAppliedInCTE = true;
        } else {
            context.paginationAppliedInCTE = false;
        }

        cteSql += ")";

        context.hasCTE = true;
        context.cteName = "base_entities";

        return {
            sql: cteSql,
            params: context.params,
            context
        };
    }

    public getNodeType(): string {
        return "CTENode";
    }
}
