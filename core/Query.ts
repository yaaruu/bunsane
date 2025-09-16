import type { BaseComponent } from "./Components";
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

export type QueryFilterOptions = {
    filters?: QueryFilter[];
};

function wrapLog(str: string) {
    console.log(str);
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

    @timed("Query.exec")
    public async exec(): Promise<Entity[]> {
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
                wrapLog('Executing excluded query');
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
                    // Optimize for single component: no need for GROUP BY, HAVING, or DISTINCT
                    queryStr = db`SELECT entity_id as id FROM entity_components WHERE type_id = ${componentIds[0]} ${this.withId ? db`AND entity_id = ${this.withId}` : db``} AND deleted_at IS NULL ORDER BY entity_id`;
                    if (this.limit !== null) {
                        queryStr = db`${queryStr} LIMIT ${this.limit}`;
                    }
                    if (this.offsetValue > 0) {
                        queryStr = db`${queryStr} OFFSET ${this.offsetValue}`;
                    }
                    wrapLog('Executing optimized query');
                    requiredOnlyQueryResult = await queryStr;
                } else {
                    const compIds = inList(componentIds, 1);
                    queryStr = db`SELECT DISTINCT entity_id as id FROM entity_components WHERE type_id IN ${db.unsafe(compIds.sql, compIds.params)} ${this.withId ? db`AND entity_id = ${this.withId}` : db``} AND deleted_at IS NULL GROUP BY entity_id HAVING COUNT(DISTINCT type_id) = ${componentCount} ORDER BY entity_id`;
                    if (this.limit !== null) {
                        queryStr = db`${queryStr} LIMIT ${this.limit}`;
                    }
                    if (this.offsetValue > 0) {
                        queryStr = db`${queryStr} OFFSET ${this.offsetValue}`;
                    }
                    wrapLog('Executing query');
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
                wrapLog('Executing only excluded query');
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
        
        let sql = `SELECT DISTINCT ec.entity_id as id FROM entity_components ec ${joins.join(' ')} WHERE ec.type_id IN ${compIds.sql} AND ec.deleted_at IS NULL`;
        
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
        
        wrapLog(`Executing filtered query: ${sql}`);
        const filteredResult = await db.unsafe(sql, params);
        return filteredResult.map((row: any) => row.id);
    }

    private async getIdsWithFiltersAndExclusions(componentIds: string[], excludedIds: string[], componentCount: number, limit?: number | null, offset?: number): Promise<string[]> {
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