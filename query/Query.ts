import type { BaseComponent, ComponentDataType } from "../core/Components";
import { Entity } from "../core/Entity";
import ComponentRegistry from "../core/ComponentRegistry";
import { logger } from "../core/Logger";
import db from "../database";
import { timed } from "../core/Decorators";
import { inList } from "../database/sqlHelpers";
import { QueryContext, QueryDAG, SourceNode, ComponentInclusionNode } from "./index";
import { OrQuery } from "./OrQuery";
import { OrNode } from "./OrNode";
import { preparedStatementCache } from "../database/PreparedStatementCache";

export type FilterOperator = "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE" | "IN" | "NOT IN" | string;

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

export interface ComponentWithFilters {
    component: new (...args: any[]) => BaseComponent;
    filters?: QueryFilter[];
}

/**
 * New Query class that uses DAG internally for better modularity and extensibility
 */
class Query {
    private context: QueryContext;
    private debug: boolean = false;
    private orQuery: OrQuery | null = null;

    constructor() {
        this.context = new QueryContext();
    }

    public findById(id: string) {
        this.context.withId = id;
        return this;
    }

    public async findOneById(id: string): Promise<Entity | null> {
        const entities = await this.findById(id).exec();
        return entities.length > 0 ? entities[0]! : null;
    }

    public with<T extends BaseComponent>(componentCtor: new (...args: any[]) => T, options?: QueryFilterOptions): this;
    public with(components: ComponentWithFilters[]): this;
    public with(orQuery: OrQuery): this;
    public with<T extends BaseComponent>(
        componentCtorOrComponentsOrOrQuery: (new (...args: any[]) => T) | ComponentWithFilters[] | OrQuery,
        options?: QueryFilterOptions
    ): this {
        if (componentCtorOrComponentsOrOrQuery instanceof OrQuery) {
            // Handle OR query
            this.orQuery = componentCtorOrComponentsOrOrQuery;
            return this;
        }

        if (Array.isArray(componentCtorOrComponentsOrOrQuery)) {
            // Handle array of components with filters
            for (const item of componentCtorOrComponentsOrOrQuery) {
                const typeId = this.context.getComponentId(item.component);
                if (!typeId) {
                    throw new Error(`Component ${item.component.name} is not registered.`);
                }
                this.context.componentIds.add(typeId);

                if (item.filters && item.filters.length > 0) {
                    this.context.componentFilters.set(typeId, item.filters);
                }
            }
        } else {
            // Handle single component
            const typeId = this.context.getComponentId(componentCtorOrComponentsOrOrQuery);
            if (!typeId) {
                throw new Error(`Component ${componentCtorOrComponentsOrOrQuery.name} is not registered.`);
            }
            this.context.componentIds.add(typeId);

            if (options?.filters && options.filters.length > 0) {
                this.context.componentFilters.set(typeId, options.filters);
            }
        }

        return this;
    }

    public without<T extends BaseComponent>(ctor: new (...args: any[]) => T) {
        const type_id = this.context.getComponentId(ctor);
        if (!type_id) {
            throw new Error(`Component ${ctor.name} is not registered.`);
        }
        this.context.excludedComponentIds.add(type_id);
        return this;
    }

    public excludeEntityId(entityId: string): this {
        this.context.excludedEntityIds.add(entityId);
        return this;
    }

    public populate(): this {
        // TODO: Implement populate functionality
        return this;
    }

    public take(limit: number): this {
        this.context.limit = limit;
        return this;
    }

    public offset(offset: number): this {
        this.context.offsetValue = offset;
        return this;
    }

    public sortBy<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        property: keyof ComponentDataType<T>,
        direction: SortDirection = "ASC",
        nullsFirst: boolean = false
    ): this {
        const componentName = componentCtor.name;
        const typeId = this.context.getComponentId(componentCtor);

        if (!typeId) {
            throw new Error(`Component ${componentName} is not registered.`);
        }

        // Validate that the component is required in this query
        if (!this.context.componentIds.has(typeId)) {
            throw new Error(`Cannot sort by component ${componentName} that is not included in the query. Use .with(${componentName}) first.`);
        }

        this.context.sortOrders.push({
            component: componentName,
            property: property as string,
            direction,
            nullsFirst
        });

        return this;
    }

    public debugMode(enabled: boolean = true): this {
        this.debug = enabled;
        return this;
    }

    public count(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`Query count execution timeout`);
                reject(new Error(`Query count execution timeout after 30 seconds`));
            }, 30000);
            this.doCount()
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

    private async doCount(): Promise<number> {
        // Build the DAG
        const dag = new QueryDAG();

        // Check if we have an OR query
        if (this.orQuery) {
            // For OR queries, we need to ensure entities have all required components first
            if (this.context.componentIds.size > 0) {
                // ComponentInclusionNode is the root, OrNode is the leaf
                const componentNode = new ComponentInclusionNode();
                dag.setRootNode(componentNode);

                // OrNode filters on top of the base requirements
                const orNode = new OrNode(this.orQuery);
                orNode.addDependency(componentNode);
                dag.addNode(orNode);
            } else {
                // No base requirements, OrNode is both root and leaf
                const orNode = new OrNode(this.orQuery);
                dag.setRootNode(orNode);
            }
        } else {
            // Use buildBasicQuery for regular AND logic (includes CTE optimization)
            const optimizedDag = QueryDAG.buildBasicQuery(this.context);
            // Copy nodes from optimized DAG to our DAG
            for (const node of optimizedDag.getNodes()) {
                dag.addNode(node);
            }
            if (optimizedDag.getRootNode()) {
                dag.setRootNode(optimizedDag.getRootNode()!);
            }
        }

        // Execute the DAG
        const result = dag.execute(this.context);

        // Modify SQL for count
        const countSql = `SELECT COUNT(*) as count FROM (${result.sql}) AS subquery`;

        // Check prepared statement cache
        const cacheKey = this.context.generateCacheKey();
        const { statement, isHit } = await preparedStatementCache.getOrCreate(countSql, cacheKey, db);

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Count Debug:');
            console.log('SQL:', countSql);
            console.log('Params:', result.params);
            console.log('Cache Hit:', isHit);
            console.log('---');
        }

        // Execute the count query using prepared statement
        const countResult = await preparedStatementCache.execute(statement, result.params, db);

        // Ensure count is returned as a number (PostgreSQL may return as string)
        const count = countResult[0].count;
        return typeof count === 'string' ? parseInt(count, 10) : count;
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
        // Build the DAG
        const dag = new QueryDAG();

        // Check if we have an OR query
        if (this.orQuery) {
            // For OR queries, we need to ensure entities have all required components first
            if (this.context.componentIds.size > 0) {
                // ComponentInclusionNode is the root, OrNode is the leaf
                const componentNode = new ComponentInclusionNode();
                dag.setRootNode(componentNode);

                // OrNode filters on top of the base requirements
                const orNode = new OrNode(this.orQuery);
                orNode.addDependency(componentNode);
                dag.addNode(orNode);
            } else {
                // No base requirements, OrNode is both root and leaf
                const orNode = new OrNode(this.orQuery);
                dag.setRootNode(orNode);
            }
        } else {
            // Use buildBasicQuery for regular AND logic (includes CTE optimization)
            const optimizedDag = QueryDAG.buildBasicQuery(this.context);
            // Copy nodes from optimized DAG to our DAG
            for (const node of optimizedDag.getNodes()) {
                dag.addNode(node);
            }
            if (optimizedDag.getRootNode()) {
                dag.setRootNode(optimizedDag.getRootNode()!);
            }
        }

        // Execute the DAG
        const result = dag.execute(this.context);

        // Check prepared statement cache
        const cacheKey = this.context.generateCacheKey();
        const { statement, isHit } = await preparedStatementCache.getOrCreate(result.sql, cacheKey, db);

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Debug:');
            console.log('SQL:', result.sql);
            console.log('Params:', result.params);
            console.log('Cache Hit:', isHit);
            console.log('---');
        }

        // Execute the query using prepared statement
        const entities = await preparedStatementCache.execute(statement, result.params, db);

        // Convert to Entity objects
        const entityIds: string[] = entities.map((row: any) => row.id);

        if (entityIds.length === 0) {
            return [];
        }

        // TODO: Handle populate functionality
        // For now, return basic Entity objects
        return entityIds.map((id: string) => {
            const entity = new Entity(id);
            entity.setPersisted(true);
            entity.setDirty(false);
            return entity;
        });
    }

    /**
     * Execute query with EXPLAIN ANALYZE for performance debugging
     * Returns the query plan and execution statistics
     */
    public async explainAnalyze(buffers: boolean = true): Promise<string> {
        // Build the DAG (same as exec)
        const dag = new QueryDAG();

        if (this.orQuery) {
            if (this.context.componentIds.size > 0) {
                const componentNode = new ComponentInclusionNode();
                dag.setRootNode(componentNode);

                const orNode = new OrNode(this.orQuery);
                orNode.addDependency(componentNode);
                dag.addNode(orNode);
            } else {
                const orNode = new OrNode(this.orQuery);
                dag.setRootNode(orNode);
            }
        } else {
            const optimizedDag = QueryDAG.buildBasicQuery(this.context);
            for (const node of optimizedDag.getNodes()) {
                dag.addNode(node);
            }
            if (optimizedDag.getRootNode()) {
                dag.setRootNode(optimizedDag.getRootNode()!);
            }
        }

        // Execute the DAG
        const result = dag.execute(this.context);

        // Create EXPLAIN ANALYZE query
        const explainSql = `EXPLAIN (ANALYZE${buffers ? ', BUFFERS' : ''}) ${result.sql}`;

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query EXPLAIN ANALYZE Debug:');
            console.log('SQL:', explainSql);
            console.log('Params:', result.params);
            console.log('---');
        }

        // Execute the EXPLAIN ANALYZE query
        const explainResult = await db.unsafe(explainSql, result.params);

        // Format the result
        return explainResult.map((row: any) => row['QUERY PLAN']).join('\n');
    }

    /**
     * Get prepared statement cache statistics
     */
    public static getCacheStats() {
        return preparedStatementCache.getStats();
    }

    static filterOp = FilterOp;

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
}

/**
 * OR function for combining component filters
 * Creates an OrQuery that matches entities satisfying ANY of the branches
 */
export function or(branches: ComponentWithFilters[]): OrQuery {
    return new OrQuery(branches);
}

export { Query };