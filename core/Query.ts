import type { BaseComponent, ComponentDataType } from "./Components";
import { Entity } from "./Entity";
import ComponentRegistry from "./ComponentRegistry";
import { logger } from "./Logger";
import { sql } from "bun";
import db from "database";
import { timed } from "./Decorators";
import { inList } from "../database/sqlHelpers";

export type FilterOperator = "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE" | "IN" | "NOT IN";

export const FilterOp = {
    EQ: "=" as FilterOperator,
    GT: ">" as FilterOperator,
    LT: "<" as FilterOperator,
    GTE: ">=" as FilterOperator,
    LTE: "<=" as FilterOperator,
    NEQ: "!=" as FilterOperator,
    LIKE: "LIKE" as FilterOperator,
    IN: "IN" as FilterOperator,
    NOT_IN: "NOT IN" as FilterOperator
}
export interface QueryFilter {
    field: string;
    operator: FilterOperator;
    value: any;
}

export interface QueryFilterOptions {
    filters: QueryFilter[];
}

export type SortDirection = "ASC" | "DESC";

export interface SortOrder {
    component: string;
    property: string;
    direction: SortDirection;
    nullsFirst?: boolean;
}

class Query {
    private requiredComponents: Set<string> = new Set<string>();
    private excludedComponents: Set<string> = new Set<string>();
    private componentFilters: Map<string, QueryFilter[]> = new Map();
    private populateComponents: boolean = false;
    private withId: string | null = null;
    private limit: number | null = null;
    private offsetValue: number = 0;
    private eagerComponents: Set<string> = new Set<string>();
    private sortOrders: SortOrder[] = [];

    static filterOp = FilterOp;

    public findById(id: string) {
        this.withId = id;
        return this;
    }

    public async findOneById(id: string): Promise<Entity | null> {
        const entities = await this.findById(id).exec();
        return entities.length > 0 ? entities[0]! : null;
    }

    public with<T extends BaseComponent>(ctor: new (...args: any[]) => T, options?: QueryFilterOptions) {
        const type_id = ComponentRegistry.getComponentId(ctor.name);
        if(!type_id) {
            throw new Error(`Component ${ctor.name} is not registered.`);
        }
        this.requiredComponents.add(type_id);
        
        if (options?.filters && options.filters.length > 0) {
            this.componentFilters.set(type_id, options.filters);
        }
        
        return this;
    }

    public eagerLoad<T extends BaseComponent>(ctors: (new (...args: any[]) => T)[]): this {
        for (const ctor of ctors) {
            const type_id = ComponentRegistry.getComponentId(ctor.name);
            if (!type_id) {
                throw new Error(`Component ${ctor.name} is not registered.`);
            }
            this.eagerComponents.add(type_id);
        }
        return this;
    }

    public eagerLoadComponents(ctors: Array<new () => BaseComponent>): this {
        for (const ctor of ctors) {
            const type_id = ComponentRegistry.getComponentId(ctor.name);
            if (!type_id) {
                throw new Error(`Component ${ctor.name} is not registered.`);
            }
            this.eagerComponents.add(type_id);
        }
        return this;
    }

    public static filter(field: string, operator: FilterOperator, value: any): QueryFilter {
        return { field, operator, value };
    }

    public static typedFilter<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>,
        operator: FilterOperator,
        value: any
    ): QueryFilter {
        return { field: field as string, operator, value };
    }

    public static filters(...filters: QueryFilter[]): QueryFilterOptions {
        return { filters };
    }

    private buildFilterCondition(filter: QueryFilter, alias: string, paramIndex: number): { sql: string, params: any[], newParamIndex: number } {
        const { field, operator, value } = filter;
        switch (operator) {
            case "=":
            case ">":
            case "<":
            case ">=":
            case "<=":
            case "!=":
                if (typeof value === "string") {
                    return { sql: `${alias}.data->>'${field}' ${operator} $${paramIndex}`, params: [value], newParamIndex: paramIndex + 1 };
                } else {
                    return { sql: `(${alias}.data->>'${field}')::numeric ${operator} $${paramIndex}`, params: [value], newParamIndex: paramIndex + 1 };
                }
            case "LIKE":
                return { sql: `${alias}.data->>'${field}' LIKE $${paramIndex}`, params: [value], newParamIndex: paramIndex + 1 };
            case "IN":
                if (Array.isArray(value)) {
                    const placeholders = Array.from({length: value.length}, (_, i) => `$${paramIndex + i}`).join(', ');
                    return { sql: `${alias}.data->>'${field}' IN (${placeholders})`, params: value, newParamIndex: paramIndex + value.length };
                }
                throw new Error("IN operator requires an array of values");
            case "NOT IN":
                if (Array.isArray(value)) {
                    const placeholders = Array.from({length: value.length}, (_, i) => `$${paramIndex + i}`).join(', ');
                    return { sql: `${alias}.data->>'${field}' NOT IN (${placeholders})`, params: value, newParamIndex: paramIndex + value.length };
                }
                throw new Error("NOT IN operator requires an array of values");
            default:
                throw new Error(`Unsupported operator: ${operator}`);
        }
    }

    private buildFilterWhereClause(typeId: string, filters: QueryFilter[], alias: string, paramIndex: number): { sql: string, params: any[], newParamIndex: number } {
        if (filters.length === 0) return { sql: '', params: [], newParamIndex: paramIndex };
        
        const conditions: string[] = [];
        const allParams: any[] = [];
        let currentIndex = paramIndex;
        for (const filter of filters) {
            const { sql, params, newParamIndex } = this.buildFilterCondition(filter, alias, currentIndex);
            conditions.push(sql);
            allParams.push(...params);
            currentIndex = newParamIndex;
        }
        const sql = conditions.join(' AND ');
        return { sql, params: allParams, newParamIndex: currentIndex };
    }


    public without<T extends BaseComponent>(ctor: new (...args: any[]) => T) {
        const type_id = ComponentRegistry.getComponentId(ctor.name);
        if(!type_id) {
            throw new Error(`Component ${ctor.name} is not registered.`);
        }
        this.excludedComponents.add(type_id);
        return this;
    }

    public populate(): this {
        this.populateComponents = true;
        return this;
    }

    public take(limit: number): this {
        this.limit = limit;
        return this;
    }

    public offset(offset: number): this {
        this.offsetValue = offset;
        return this;
    }

    public sortBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        property: keyof ComponentDataType<T>,
        direction: SortDirection = "ASC",
        nullsFirst: boolean = false
    ): this {
        const componentName = componentCtor.name;
        const typeId = ComponentRegistry.getComponentId(componentName);
        
        if (!typeId) {
            throw new Error(`Component ${componentName} is not registered.`);
        }

        // Validate that the component is required in this query
        if (!this.requiredComponents.has(typeId)) {
            throw new Error(`Cannot sort by component ${componentName} that is not included in the query. Use .with(${componentName}) first.`);
        }

        this.sortOrders.push({
            component: componentName,
            property: property as string,
            direction,
            nullsFirst
        });

        return this;
    }

    public orderBy(orders: SortOrder[]): this {
        // Validate each sort order
        for (const order of orders) {
            const typeId = ComponentRegistry.getComponentId(order.component);
            if (!typeId) {
                throw new Error(`Component ${order.component} is not registered.`);
            }
            if (!this.requiredComponents.has(typeId)) {
                throw new Error(`Cannot sort by component ${order.component} that is not included in the query. Use .with(${order.component}) first.`);
            }
        }

        this.sortOrders = orders;
        return this;
    }

    @timed("Query.exec")
    public async exec(): Promise<Entity[]> {
        return new Promise<Entity[]>((resolve, reject) => {
            // Add timeout to prevent hanging queries
            const timeout = setTimeout(() => {
                logger.error(`Query execution timeout`);
                reject(new Error(`Query execution timeout after 30 seconds`));
            }, 30000); // 30 second timeout

            this.doExec()
                .then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    }

    private async doExec(): Promise<Entity[]> {
        const componentIds = Array.from(this.requiredComponents);
        const excludedIds = Array.from(this.excludedComponents);
        const componentCount = componentIds.length;
        const hasRequired = componentCount > 0;
        const hasExcluded = excludedIds.length > 0;
        const hasFilters = this.componentFilters.size > 0;
        const hasWithId = this.withId !== null;
        
        let ids: string[] = [];
        
        switch (true) {
            case !hasRequired && !hasExcluded && !hasWithId:
                return [];
            case !hasRequired && !hasExcluded && hasWithId:
                let query = db`SELECT id FROM entities WHERE id = ${this.withId} AND deleted_at IS NULL ORDER BY id`;
                if (this.limit !== null) {
                    query = db`${query} LIMIT ${this.limit}`;
                }
                if (this.offsetValue > 0) {
                    query = db`${query} OFFSET ${this.offsetValue}`;
                }
                const result = await query;
                ids = result.map((row: any) => row.id);
                break;
            case hasRequired && hasExcluded && hasFilters:
                ids = await this.getIdsWithFiltersAndExclusions(componentIds, excludedIds, componentCount, this.limit, this.offsetValue);
                break;
            case hasRequired && hasExcluded:
                const componentIdsString = inList(componentIds, 1);
                const excludedIdsString = inList(excludedIds, componentIdsString.newParamIndex);
                let excludedQuery = db`
                    SELECT ec.entity_id as id
                    FROM entity_components ec
                    WHERE ec.type_id IN ${db.unsafe(componentIdsString.sql, componentIdsString.params)} AND ec.deleted_at IS NULL
                    ${this.withId ? db`AND ec.entity_id = ${this.withId}` : db``}
                    AND NOT EXISTS (
                        SELECT 1 FROM entity_components ec_ex 
                        WHERE ec_ex.entity_id = ec.entity_id AND ec_ex.type_id IN ${db.unsafe(excludedIdsString.sql, excludedIdsString.params)} AND ec_ex.deleted_at IS NULL
                    )
                    GROUP BY ec.entity_id
                    HAVING COUNT(DISTINCT ec.type_id) = ${componentCount}
                    ORDER BY ec.entity_id
                `;
                if (this.limit !== null) {
                    excludedQuery = db`${excludedQuery} LIMIT ${this.limit}`;
                }
                if (this.offsetValue > 0) {
                    excludedQuery = db`${excludedQuery} OFFSET ${this.offsetValue}`;
                }
                const excludedQueryResult = await excludedQuery;
                ids = excludedQueryResult.map((row: any) => row.id);
                break;
            case hasRequired && hasFilters:
                ids = await this.getIdsWithFilters(componentIds, componentCount, this.limit, this.offsetValue);
                break;
            case hasRequired:
                let queryStr: any;
                let requiredOnlyQueryResult: any;
                if (componentCount === 1) {
                    // Phase 2A: Optimize single component sorting with JOIN
                    if (this.sortOrders.length > 0) {
                        const typeId = componentIds[0]!;
                        const sortExpression = this.buildSortExpressionForSingleComponent(typeId, "c");
                        queryStr = db`SELECT DISTINCT ec.entity_id as id ${db.unsafe(sortExpression.select)} FROM entity_components ec JOIN components c ON ec.entity_id = c.entity_id AND c.type_id = ${typeId} AND c.deleted_at IS NULL WHERE ec.type_id = ${typeId} ${this.withId ? db`AND ec.entity_id = ${this.withId}` : db``} AND ec.deleted_at IS NULL ${db.unsafe(sortExpression.orderBy)}`;
                    } else {
                        queryStr = db`SELECT entity_id as id FROM entity_components WHERE type_id = ${componentIds[0]} ${this.withId ? db`AND entity_id = ${this.withId}` : db``} AND deleted_at IS NULL ORDER BY entity_id`;
                    }
                    if (this.limit !== null) {
                        queryStr = db`${queryStr} LIMIT ${this.limit}`;
                    }
                    if (this.offsetValue > 0) {
                        queryStr = db`${queryStr} OFFSET ${this.offsetValue}`;
                    }
                    requiredOnlyQueryResult = await queryStr;
                } else {
                    // Phase 2A: Optimize multi-component sorting with JOINs instead of subqueries
                    if (this.sortOrders.length > 0) {
                        const compIds = inList(componentIds, 1);
                        let orderByClause = "ORDER BY ";
                        const orderClauses: string[] = [];

                        for (const order of this.sortOrders) {
                            const typeId = ComponentRegistry.getComponentId(order.component);
                            if (typeId && componentIds.includes(typeId)) {
                                const direction = order.direction.toUpperCase();
                                const nullsClause = order.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
                                // Use JOIN-based sorting instead of subquery
                                const subquery = `(SELECT (c.data->>'${order.property}')::numeric FROM components c WHERE c.entity_id = base_query.id AND c.type_id = '${typeId}' AND c.deleted_at IS NULL LIMIT 1)`;
                                orderClauses.push(`${subquery} ${direction} ${nullsClause}`);
                            }
                        }
                        orderClauses.push("base_query.id ASC");
                        orderByClause += orderClauses.join(", ");

                        queryStr = db`SELECT * FROM (SELECT DISTINCT entity_id as id FROM entity_components WHERE type_id IN ${db.unsafe(compIds.sql, compIds.params)} ${this.withId ? db`AND entity_id = ${this.withId}` : db``} AND deleted_at IS NULL GROUP BY entity_id HAVING COUNT(DISTINCT type_id) = ${componentCount}) base_query ${db.unsafe(orderByClause)}`;
                    } else {
                        const compIds = inList(componentIds, 1);
                        queryStr = db`SELECT DISTINCT entity_id as id FROM entity_components WHERE type_id IN ${db.unsafe(compIds.sql, compIds.params)} ${this.withId ? db`AND entity_id = ${this.withId}` : db``} AND deleted_at IS NULL GROUP BY entity_id HAVING COUNT(DISTINCT type_id) = ${componentCount} ORDER BY entity_id`;
                    }
                    if (this.limit !== null) {
                        queryStr = db`${queryStr} LIMIT ${this.limit}`;
                    }
                    if (this.offsetValue > 0) {
                        queryStr = db`${queryStr} OFFSET ${this.offsetValue}`;
                    }
                    requiredOnlyQueryResult = await queryStr;
                }
                ids = requiredOnlyQueryResult.map((row: any) => row.id);
                break;
            case hasExcluded:
                const onlyExcludedIdsString = inList(excludedIds, 1);
                let onlyExcludedQuery = db`
                    SELECT DISTINCT ec.entity_id as id
                    FROM entity_components ec 
                    WHERE ${this.withId ? db`ec.entity_id = ${this.withId} AND ` : db``} NOT EXISTS (
                        SELECT 1 FROM entity_components ec_ex 
                        WHERE ec_ex.entity_id = ec.entity_id AND ec_ex.type_id IN ${db.unsafe(onlyExcludedIdsString.sql, onlyExcludedIdsString.params)} AND ec_ex.deleted_at IS NULL
                    )
                    AND ec.deleted_at IS NULL
                    ORDER BY ec.entity_id
                `;
                if (this.limit !== null) {
                    onlyExcludedQuery = db`${onlyExcludedQuery} LIMIT ${this.limit}`;
                }
                if (this.offsetValue > 0) {
                    onlyExcludedQuery = db`${onlyExcludedQuery} OFFSET ${this.offsetValue}`;
                }
                const onlyExcludedQueryResult = await onlyExcludedQuery;
                ids = onlyExcludedQueryResult.map((row: any) => row.id);
                break;
            default:
                return [];
        }
        
        if (this.populateComponents) {
            return await Entity.LoadMultiple(ids);
        } else {
            const len = ids.length;
            const entities = new Array(len);
            for (let i = 0; i < len; i += 4) {
                if (i < len) {
                    const entity = new Entity(ids[i]);
                    entity.setPersisted(true);
                    entity.setDirty(false);
                    entities[i] = entity;
                }
                if (i + 1 < len) {
                    const entity = new Entity(ids[i + 1]);
                    entity.setPersisted(true);
                    entity.setDirty(false);
                    entities[i + 1] = entity;
                }
                if (i + 2 < len) {
                    const entity = new Entity(ids[i + 2]);
                    entity.setPersisted(true);
                    entity.setDirty(false);
                    entities[i + 2] = entity;
                }
                if (i + 3 < len) {
                    const entity = new Entity(ids[i + 3]);
                    entity.setPersisted(true);
                    entity.setDirty(false);
                    entities[i + 3] = entity;
                }
            }
            if (this.eagerComponents.size > 0) {
                await Entity.LoadComponents(entities, Array.from(this.eagerComponents));
            }
            return entities;
        }
    }

    private buildOrderByClause(): string {
        if (this.sortOrders.length === 0) {
            return 'ORDER BY ec.entity_id';
        }

        const orderClauses: string[] = [];
        for (const order of this.sortOrders) {
            const typeId = ComponentRegistry.getComponentId(order.component);
            if (!typeId) continue;

            // For now, assume we have a component alias. In practice, we'd need to map component types to aliases
            // This is a simplified implementation - in a full implementation, we'd need to track aliases per component
            const componentAlias = `c_${typeId}`;
            const direction = order.direction.toUpperCase();
            const nulls = order.nullsFirst ? 'NULLS FIRST' : 'NULLS LAST';
            orderClauses.push(`(${componentAlias}.data->>'${order.property}')::text ${direction} ${nulls}`);
        }

        // Always include entity_id as final tiebreaker for consistent ordering
        orderClauses.push('ec.entity_id ASC');

        return `ORDER BY ${orderClauses.join(', ')}`;
    }

    private buildOrderByClauseWithJoinData(componentIds: string[], joinCount: number): string {
        if (this.sortOrders.length === 0) {
            return `ORDER BY id`;
        }

        const orderClauses: string[] = [];

        for (let i = 0; i < this.sortOrders.length; i++) {
            const order = this.sortOrders[i];
            if (!order) continue;

            const typeId = ComponentRegistry.getComponentId(order.component);
            if (!typeId || !componentIds.includes(typeId)) {
                continue; // Skip if component not in query
            }

            const direction = order.direction.toUpperCase();
            const nullsClause = order.nullsFirst ? "NULLS FIRST" : "NULLS LAST";

            // For subquery approach, use correlated subquery for sorting
            const sortExpression = `(SELECT (c.data->>'${order.property}')::numeric FROM components c WHERE c.entity_id = filtered_entities.id AND c.type_id = '${typeId}' AND c.deleted_at IS NULL LIMIT 1)`;

            orderClauses.push(`${sortExpression} ${direction} ${nullsClause}`);
        }

        // Always include entity_id as final tiebreaker for consistent ordering
        orderClauses.push(`id ASC`);

        return `ORDER BY ${orderClauses.join(", ")}`;
    }

    private buildSortExpressionForSingleComponent(typeId: string, alias: string): { select: string, orderBy: string } {
        if (this.sortOrders.length === 0) {
            return { select: "", orderBy: "ORDER BY ec.entity_id" };
        }

        const order = this.sortOrders[0]; // For single component, we only support single sort
        if (!order) {
            return { select: "", orderBy: "ORDER BY ec.entity_id" };
        }

        const direction = order.direction.toUpperCase();
        const nullsClause = order.nullsFirst ? "NULLS FIRST" : "NULLS LAST";

        const selectExpr = `, (${alias}.data->>'${order.property}')::numeric as sort_val`;
        const orderByExpr = `ORDER BY sort_val ${direction} ${nullsClause}, ec.entity_id ASC`;

        return { select: selectExpr, orderBy: orderByExpr };
    }

    private async getIdsWithFilters(componentIds: string[], componentCount: number, limit?: number | null, offset?: number): Promise<string[]> {
        let params: any[] = [];
        let paramIndex = 1;
        const compIds = inList(componentIds, paramIndex);
        params.push(...compIds.params);
        paramIndex = compIds.newParamIndex;

        const joins: string[] = [];
        let joinIndex = 0;
        for (const [typeId, filters] of this.componentFilters.entries()) {
            if (componentIds.includes(typeId)) {
                const alias = `c${joinIndex}`;
                joins.push(`JOIN components ${alias} ON ec.entity_id = ${alias}.entity_id AND ${alias}.type_id = $${paramIndex} AND ${alias}.deleted_at IS NULL`);
                params.push(typeId);
                paramIndex++;
                joinIndex++;
            }
        }

        let sql: string;

        // For sorting, use a CTE approach to avoid GROUP BY conflicts
        if (this.sortOrders.length > 0) {
            let selectColumns = `ec.entity_id as id`;

            // Add sort columns using window functions
            const sortColumns: string[] = [];
            for (let i = 0; i < this.sortOrders.length; i++) {
                const order = this.sortOrders[i];
                if (!order) continue;

                const typeId = ComponentRegistry.getComponentId(order.component);
                if (!typeId || !componentIds.includes(typeId)) {
                    continue; // Skip if component not in query
                }

                // Find the join alias for this component
                let sortAlias = '';
                let aliasIndex = 0;
                for (const [filterTypeId, filters] of Array.from(this.componentFilters.entries())) {
                    if (componentIds.includes(filterTypeId) && filterTypeId === typeId) {
                        sortAlias = `c${aliasIndex}`;
                        break;
                    }
                    if (componentIds.includes(filterTypeId)) {
                        aliasIndex++;
                    }
                }

                if (sortAlias) {
                    sortColumns.push(`FIRST_VALUE((${sortAlias}.data->>'${order.property}')::numeric) OVER (PARTITION BY ec.entity_id ORDER BY ${sortAlias}.created_at DESC) as sort_val_${i}`);
                }
            }
            if (sortColumns.length > 0) {
                selectColumns += `, ${sortColumns.join(', ')}`;
            }

            // Use CTE to get filtered entities with sort values
            sql = `WITH filtered_entities AS (
                SELECT ${selectColumns}
                FROM entity_components ec ${joins.join(' ')}
                WHERE ec.type_id IN ${compIds.sql} AND ec.deleted_at IS NULL`;

            if (this.withId) {
                sql += ` AND ec.entity_id = $${paramIndex}`;
                params.push(this.withId);
                paramIndex++;
            }

            joinIndex = 0;
            for (const [typeId, filters] of this.componentFilters.entries()) {
                if (componentIds.includes(typeId)) {
                    const alias = `c${joinIndex}`;
                    const filterConditions = this.buildFilterWhereClause(typeId, filters, alias, paramIndex);
                    if (filterConditions.sql) {
                        sql += ` AND ${filterConditions.sql}`;
                        params.push(...filterConditions.params);
                        paramIndex = filterConditions.newParamIndex;
                    }
                    joinIndex++;
                }
            }

            sql += `
            )
            SELECT DISTINCT fe.id, ${sortColumns.length > 0 ? sortColumns.map((_, i) => `fe.sort_val_${i}`).join(', ') : ''}
            FROM filtered_entities fe
            WHERE (SELECT COUNT(DISTINCT ec.type_id) FROM entity_components ec WHERE ec.entity_id = fe.id AND ec.deleted_at IS NULL) = $${paramIndex}`;

            params.push(componentCount);
            paramIndex++;

            // Build ORDER BY clause using the selected sort values
            const orderClauses: string[] = [];
            for (let i = 0; i < this.sortOrders.length; i++) {
                const order = this.sortOrders[i];
                if (!order) continue;

                const direction = order.direction.toUpperCase();
                const nullsClause = order.nullsFirst ? "NULLS FIRST" : "NULLS LAST";
                orderClauses.push(`sort_val_${i} ${direction} ${nullsClause}`);
            }
            // Always include entity_id as final tiebreaker for consistent ordering
            orderClauses.push(`id ASC`);
            sql += ` ORDER BY ${orderClauses.join(", ")}`;
        } else {
            // No sorting - use simpler approach
            sql = `SELECT DISTINCT ec.entity_id as id FROM entity_components ec ${joins.join(' ')} WHERE ec.type_id IN ${compIds.sql} AND ec.deleted_at IS NULL`;

            if (this.withId) {
                sql += ` AND ec.entity_id = $${paramIndex}`;
                params.push(this.withId);
                paramIndex++;
            }

            joinIndex = 0;
            for (const [typeId, filters] of this.componentFilters.entries()) {
                if (componentIds.includes(typeId)) {
                    const alias = `c${joinIndex}`;
                    const filterConditions = this.buildFilterWhereClause(typeId, filters, alias, paramIndex);
                    if (filterConditions.sql) {
                        sql += ` AND ${filterConditions.sql}`;
                        params.push(...filterConditions.params);
                        paramIndex = filterConditions.newParamIndex;
                    }
                    joinIndex++;
                }
            }

            sql += ` GROUP BY ec.entity_id HAVING COUNT(DISTINCT ec.type_id) = $${paramIndex}`;
            params.push(componentCount);
            paramIndex++;
            sql += ` ORDER BY ec.entity_id`;
        }

        if (limit !== null && limit !== undefined) {
            sql += ` LIMIT $${paramIndex}`;
            params.push(limit);
            paramIndex++;
        }
        if (offset && offset > 0) {
            sql += ` OFFSET $${paramIndex}`;
            params.push(offset);
            paramIndex++;
        }

        const filteredResult = await db.unsafe(sql, params);
        return filteredResult.map((row: any) => row.id);
    }    private async getIdsWithFiltersAndExclusions(componentIds: string[], excludedIds: string[], componentCount: number, limit?: number | null, offset?: number): Promise<string[]> {
        const entityIds = await this.getIdsWithFilters(componentIds, componentCount);
        
        if (entityIds.length === 0) {
            return [];
        }
        
        const idsList = sql(entityIds);
        const excludedList = inList(excludedIds, 1);
        let query = db`
            WITH entity_list AS (
                SELECT unnest(${idsList}) as id
            )
            SELECT el.id
            FROM entity_list el
            WHERE NOT EXISTS (
                SELECT 1 FROM entity_components ec 
                WHERE ec.entity_id = el.id AND ec.type_id IN ${db.unsafe(excludedList.sql, excludedList.params)} AND ec.deleted_at IS NULL
            )
            ORDER BY el.id
        `;
        if (limit !== null && limit !== undefined) {
            query = db`${query} LIMIT ${limit}`;
        }
        if (offset && offset > 0) {
            query = db`${query} OFFSET ${offset}`;
        }
        const exclusionResult = await query;
        return exclusionResult.map((row: any) => row.id);
    }
}

export default Query;