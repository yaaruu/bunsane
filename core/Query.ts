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
class Query {
    private requiredComponents: Set<string> = new Set<string>();
    private excludedComponents: Set<string> = new Set<string>();
    private componentFilters: Map<string, QueryFilter[]> = new Map();
    private populateComponents: boolean = false;
    private withId: string | null = null;

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
        switch (operator) {
            case "=":
            case ">":
            case "<":
            case ">=":
            case "<=":
            case "!=":
                if (typeof value === "string") {
                    return `data->>'${field}' ${operator} '${value}'`;
                } else {
                    return `(data->>'${field}')::numeric ${operator} ${value}`;
                }
            case "LIKE":
                return `data->>'${field}' LIKE '${value}'`;
            case "IN":
                if (Array.isArray(value)) {
                    const valueList = value.map(v => typeof v === "string" ? `'${v}'` : v).join(", ");
                    return `data->>'${field}' IN (${valueList})`;
                }
                throw new Error("IN operator requires an array of values");
            case "NOT IN":
                if (Array.isArray(value)) {
                    const valueList = value.map(v => typeof v === "string" ? `'${v}'` : v).join(", ");
                    return `data->>'${field}' NOT IN (${valueList})`;
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

    @timed
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
                const result = await db`SELECT id FROM entities WHERE id = ${this.withId!}`;
                ids = result.map((row: any) => row.id);
                break;
            case hasRequired && hasExcluded && hasFilters:
                ids = await this.getIdsWithFiltersAndExclusions(componentIds, excludedIds, componentCount);
                break;
            case hasRequired && hasExcluded:
                const componentIdsString = componentIds.map(id => `'${id}'`).join(', ');
                const excludedIdsString = excludedIds.map(id => `'${id}'`).join(', ');
                const excludedQuery = `
                    SELECT ec.entity_id as id
                    FROM entity_components ec
                    WHERE ec.type_id IN (${componentIdsString})
                    ${this.withId ? `AND ec.entity_id = '${this.withId}'` : ''}
                    AND NOT EXISTS (
                        SELECT 1 FROM entity_components ec_ex 
                        WHERE ec_ex.entity_id = ec.entity_id AND ec_ex.type_id IN (${excludedIdsString})
                    )
                    GROUP BY ec.entity_id
                    HAVING COUNT(DISTINCT ec.type_id) = ${componentCount}
                `;
                wrapLog(`Executing query: ${excludedQuery}`);
                const excludedQueryResult = await db.unsafe(excludedQuery);
                ids = excludedQueryResult.map((row: any) => row.id);
                break;
            case hasRequired && hasFilters:
                ids = await this.getIdsWithFilters(componentIds, componentCount);
                break;
            case hasRequired:
                let queryStr: string;
                let requiredOnlyQueryResult: any;
                if (componentCount === 1) {
                    // Optimize for single component: no need for GROUP BY, HAVING, or DISTINCT
                    queryStr = `SELECT entity_id as id FROM entity_components WHERE type_id = '${componentIds[0]}' ${this.withId ? `AND entity_id = '${this.withId}'` : ''}`;
                    wrapLog(`Executing optimized query: ${queryStr}`);
                    requiredOnlyQueryResult = await db.unsafe(queryStr);
                } else {
                    queryStr = `SELECT DISTINCT entity_id as id FROM entity_components WHERE type_id IN (${componentIds.map(id => `'${id}'`).join(', ')}) ${this.withId ? `AND entity_id = '${this.withId}'` : ''} GROUP BY entity_id HAVING COUNT(DISTINCT type_id) = ${componentCount}`;
                    wrapLog(`Executing query: ${queryStr}`);
                    requiredOnlyQueryResult = await db`
                        SELECT DISTINCT entity_id as id FROM entity_components
                        WHERE type_id IN ${sql(componentIds)}
                        ${this.withId ? sql`AND entity_id = ${this.withId}` : sql``}
                        GROUP BY entity_id
                        HAVING COUNT(DISTINCT type_id) = ${componentCount}
                    `;
                }
                ids = requiredOnlyQueryResult.map((row: any) => row.id);
                break;
            case hasExcluded:
                const onlyExcludedIdsString = excludedIds.map(id => `'${id}'`).join(', ');
                const onlyExcludedQuery = `
                    SELECT DISTINCT ec.entity_id as id
                    FROM entity_components ec
                    WHERE ${this.withId ? `ec.entity_id = '${this.withId}' AND ` : ''} NOT EXISTS (
                        SELECT 1 FROM entity_components ec_ex 
                        WHERE ec_ex.entity_id = ec.entity_id AND ec_ex.type_id IN (${onlyExcludedIdsString})
                    )
                `;
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

    private async getIdsWithFilters(componentIds: string[], componentCount: number): Promise<string[]> {
        let query = `
            SELECT DISTINCT ec.entity_id as id 
            FROM entity_components ec
        `;
        
        const joins: string[] = [];
        const whereConditions: string[] = [`ec.type_id IN (${componentIds.map(id => `'${id}'`).join(', ')})`];
        if (this.withId) {
            whereConditions.push(`ec.entity_id = '${this.withId}'`);
        }
        
        let joinIndex = 0;
        for (const [typeId, filters] of this.componentFilters.entries()) {
            if (componentIds.includes(typeId)) {
                const alias = `c${joinIndex}`;
                joins.push(`JOIN components ${alias} ON ec.entity_id = ${alias}.entity_id AND ${alias}.type_id = '${typeId}'`);
                
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
        
        wrapLog(`Executing filtered query: ${query}`);
        const filteredResult = await db.unsafe(query);
        return filteredResult.map((row: any) => row.id);
    }

    private async getIdsWithFiltersAndExclusions(componentIds: string[], excludedIds: string[], componentCount: number): Promise<string[]> {
        const entityIds = await this.getIdsWithFilters(componentIds, componentCount);
        
        if (entityIds.length === 0) {
            return [];
        }
        
        const idsString = entityIds.map(id => `'${id}'`).join(', ');
        const excludedString = excludedIds.map(id => `'${id}'`).join(', ');
        const query = `
            WITH entity_list AS (
                SELECT unnest(ARRAY[${idsString}]) as id
            )
            SELECT el.id
            FROM entity_list el
            WHERE NOT EXISTS (
                SELECT 1 FROM entity_components ec 
                WHERE ec.entity_id = el.id AND ec.type_id IN (${excludedString})
            )
        `;
        const exclusionResult = await db.unsafe(query);
        return exclusionResult.map((row: any) => row.id);
    }
}

export default Query;