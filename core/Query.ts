import type { BaseComponent } from "./Components";
import { Entity } from "./Entity";
import ComponentRegistry from "./ComponentRegistry";
import { logger } from "./Logger";
import { sql } from "bun";
import db from "database";
import { timed } from "./Decorators";

export type FilterOperator = "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE" | "IN" | "NOT IN";
export interface QueryFilter {
    field: string;
    operator: FilterOperator;
    value: any;
}

export type QueryFilterOptions = {
    filters?: QueryFilter[];
};

function wrapLog(str: string) {
    // console.log(str);
}

function escapeSqlString(str: string): string {
    return str.replace(/'/g, "''");
}

class Query {
    private requiredComponents: Set<string> = new Set<string>();
    private excludedComponents: Set<string> = new Set<string>();
    private componentFilters: Map<string, QueryFilter[]> = new Map();
    private populateComponents: boolean = false;
    private withId: string | null = null;
    private limit: number | null = null;
    private offsetValue: number = 0;

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

    
    public static filter(field: string, operator: FilterOperator, value: any): QueryFilter {
        return { field, operator, value };
    }

    public static filters(...filters: QueryFilter[]): QueryFilterOptions {
        return { filters };
    }

    private buildFilterCondition(filter: QueryFilter): string {
        const { field, operator, value } = filter;
        const escapedField = field.replace(/'/g, "''");
        switch (operator) {
            case "=":
            case ">":
            case "<":
            case ">=":
            case "<=":
            case "!=":
                if (typeof value === "string") {
                    const escapedValue = value.replace(/'/g, "''");
                    return `data->>'${escapedField}' ${operator} '${escapedValue}'`;
                } else {
                    return `(data->>'${escapedField}')::numeric ${operator} ${value}`;
                }
            case "LIKE":
                const escapedValue = value.replace(/'/g, "''");
                return `data->>'${escapedField}' LIKE '${escapedValue}'`;
            case "IN":
                if (Array.isArray(value)) {
                    const valueList = value.map(v => typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v).join(", ");
                    return `data->>'${escapedField}' IN (${valueList})`;
                }
                throw new Error("IN operator requires an array of values");
            case "NOT IN":
                if (Array.isArray(value)) {
                    const valueList = value.map(v => typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v).join(", ");
                    return `data->>'${escapedField}' NOT IN (${valueList})`;
                }
                throw new Error("NOT IN operator requires an array of values");
            default:
                throw new Error(`Unsupported operator: ${operator}`);
        }
    }

    private buildFilterWhereClause(typeId: string, filters: QueryFilter[]): string {
        if (filters.length === 0) return "";
        
        const conditions = filters.map(filter => this.buildFilterCondition(filter));
        return conditions.join(" AND ");
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
                let withIdQuery = `SELECT id FROM entities WHERE id = '${escapeSqlString(this.withId!)}' AND deleted_at IS NULL ORDER BY id`;
                if (this.limit !== null) {
                    withIdQuery += ` LIMIT ${this.limit}`;
                }
                if (this.offsetValue > 0) {
                    withIdQuery += ` OFFSET ${this.offsetValue}`;
                }
                const result = await db.unsafe(withIdQuery);
                ids = result.map((row: any) => row.id);
                break;
            case hasRequired && hasExcluded && hasFilters:
                ids = await this.getIdsWithFiltersAndExclusions(componentIds, excludedIds, componentCount, this.limit, this.offsetValue);
                break;
            case hasRequired && hasExcluded:
                const componentIdsString = componentIds.map(id => `'${escapeSqlString(id)}'`).join(', ');
                const excludedIdsString = excludedIds.map(id => `'${escapeSqlString(id)}'`).join(', ');
                let excludedQuery = `
                    SELECT ec.entity_id as id
                    FROM entity_components ec
                    WHERE ec.type_id IN (${componentIdsString}) AND ec.deleted_at IS NULL
                    ${this.withId ? `AND ec.entity_id = '${escapeSqlString(this.withId)}'` : ''}
                    AND NOT EXISTS (
                        SELECT 1 FROM entity_components ec_ex 
                        WHERE ec_ex.entity_id = ec.entity_id AND ec_ex.type_id IN (${excludedIdsString}) AND ec_ex.deleted_at IS NULL
                    )
                    GROUP BY ec.entity_id
                    HAVING COUNT(DISTINCT ec.type_id) = ${componentCount}
                    ORDER BY ec.entity_id
                `;
                if (this.limit !== null) {
                    excludedQuery += ` LIMIT ${this.limit}`;
                }
                if (this.offsetValue > 0) {
                    excludedQuery += ` OFFSET ${this.offsetValue}`;
                }
                wrapLog(`Executing query: ${excludedQuery}`);
                const excludedQueryResult = await db.unsafe(excludedQuery);
                ids = excludedQueryResult.map((row: any) => row.id);
                break;
            case hasRequired && hasFilters:
                ids = await this.getIdsWithFilters(componentIds, componentCount, this.limit, this.offsetValue);
                break;
            case hasRequired:
                let queryStr: string;
                let requiredOnlyQueryResult: any;
                if (componentCount === 1) {
                    // Optimize for single component: no need for GROUP BY, HAVING, or DISTINCT
                    queryStr = `SELECT entity_id as id FROM entity_components WHERE type_id = '${escapeSqlString(componentIds[0]!)}' ${this.withId ? `AND entity_id = '${escapeSqlString(this.withId)}'` : ''} AND deleted_at IS NULL ORDER BY entity_id`;
                    if (this.limit !== null) {
                        queryStr += ` LIMIT ${this.limit}`;
                    }
                    if (this.offsetValue > 0) {
                        queryStr += ` OFFSET ${this.offsetValue}`;
                    }
                    wrapLog(`Executing optimized query: ${queryStr}`);
                    requiredOnlyQueryResult = await db.unsafe(queryStr);
                } else {
                    queryStr = `SELECT DISTINCT entity_id as id FROM entity_components WHERE type_id IN (${componentIds.map(id => `'${escapeSqlString(id)}'`).join(', ')}) ${this.withId ? `AND entity_id = '${escapeSqlString(this.withId)}'` : ''} AND deleted_at IS NULL GROUP BY entity_id HAVING COUNT(DISTINCT type_id) = ${componentCount} ORDER BY entity_id`;
                    if (this.limit !== null) {
                        queryStr += ` LIMIT ${this.limit}`;
                    }
                    if (this.offsetValue > 0) {
                        queryStr += ` OFFSET ${this.offsetValue}`;
                    }
                    wrapLog(`Executing query: ${queryStr}`);
                    requiredOnlyQueryResult = await db.unsafe(queryStr);
                }
                ids = requiredOnlyQueryResult.map((row: any) => row.id);
                break;
            case hasExcluded:
                const onlyExcludedIdsString = excludedIds.map(id => `'${escapeSqlString(id)}'`).join(', ');
                let onlyExcludedQuery = `
                    SELECT DISTINCT ec.entity_id as id
                    FROM entity_components ec 
                    WHERE ${this.withId ? `ec.entity_id = '${escapeSqlString(this.withId)}' AND ` : ''} NOT EXISTS (
                        SELECT 1 FROM entity_components ec_ex 
                        WHERE ec_ex.entity_id = ec.entity_id AND ec_ex.type_id IN (${onlyExcludedIdsString}) AND ec_ex.deleted_at IS NULL
                    )
                    AND ec.deleted_at IS NULL
                    ORDER BY ec.entity_id
                `;
                if (this.limit !== null) {
                    onlyExcludedQuery += ` LIMIT ${this.limit}`;
                }
                if (this.offsetValue > 0) {
                    onlyExcludedQuery += ` OFFSET ${this.offsetValue}`;
                }
                wrapLog(`Executing query: ${onlyExcludedQuery}`);
                const onlyExcludedQueryResult = await db.unsafe(onlyExcludedQuery);
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
            return entities;
        }
    }

    private async getIdsWithFilters(componentIds: string[], componentCount: number, limit?: number | null, offset?: number): Promise<string[]> {
        let query = `
            SELECT DISTINCT ec.entity_id as id 
            FROM entity_components ec
        `;
        
        const joins: string[] = [];
        const whereConditions: string[] = [`ec.type_id IN (${componentIds.map(id => `'${escapeSqlString(id)}'`).join(', ')})`, `ec.deleted_at IS NULL`];
        if (this.withId) {
            whereConditions.push(`ec.entity_id = '${escapeSqlString(this.withId)}'`);
        }
        
        let joinIndex = 0;
        for (const [typeId, filters] of this.componentFilters.entries()) {
            if (componentIds.includes(typeId)) {
                const alias = `c${joinIndex}`;
                joins.push(`JOIN components ${alias} ON ec.entity_id = ${alias}.entity_id AND ${alias}.type_id = '${escapeSqlString(typeId)}' AND ${alias}.deleted_at IS NULL`);
                
                const filterCondition = this.buildFilterWhereClause(typeId, filters);
                if (filterCondition) {
                    whereConditions.push(filterCondition.replace(/data->/g, `${alias}.data->`));
                }
                joinIndex++;
            }
        }
        
        query += joins.join(' ');
        query += ` WHERE ${whereConditions.join(' AND ')}`;
        query += ` GROUP BY ec.entity_id HAVING COUNT(DISTINCT ec.type_id) = ${componentCount}`;
        query += ` ORDER BY ec.entity_id`;
        if (limit !== null && limit !== undefined) {
            query += ` LIMIT ${limit}`;
        }
        if (offset && offset > 0) {
            query += ` OFFSET ${offset}`;
        }
        
        wrapLog(`Executing filtered query: ${query}`);
        const filteredResult = await db.unsafe(query);
        return filteredResult.map((row: any) => row.id);
    }

    private async getIdsWithFiltersAndExclusions(componentIds: string[], excludedIds: string[], componentCount: number, limit?: number | null, offset?: number): Promise<string[]> {
        const entityIds = await this.getIdsWithFilters(componentIds, componentCount);
        
        if (entityIds.length === 0) {
            return [];
        }
        
        const idsString = entityIds.map(id => `'${escapeSqlString(id)}'`).join(', ');
        const excludedString = excludedIds.map(id => `'${escapeSqlString(id)}'`).join(', ');
        let query = `
            WITH entity_list AS (
                SELECT unnest(ARRAY[${idsString}]) as id
            )
            SELECT el.id
            FROM entity_list el
            WHERE NOT EXISTS (
                SELECT 1 FROM entity_components ec 
                WHERE ec.entity_id = el.id AND ec.type_id IN (${excludedString}) AND ec.deleted_at IS NULL
            )
            ORDER BY el.id
        `;
        if (limit !== null && limit !== undefined) {
            query += ` LIMIT ${limit}`;
        }
        if (offset && offset > 0) {
            query += ` OFFSET ${offset}`;
        }
        const exclusionResult = await db.unsafe(query);
        return exclusionResult.map((row: any) => row.id);
    }
}

export default Query;