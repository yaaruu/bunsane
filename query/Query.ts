import {ComponentRegistry , type BaseComponent, type ComponentDataType } from "../core/components";
import { Entity } from "../core/Entity";
import { logger } from "../core/Logger";
import db from "../database";
import { timed } from "../core/Decorators";
import { inList } from "../database/sqlHelpers";
import { QueryContext, QueryDAG, SourceNode, ComponentInclusionNode } from "./index";
import { OrQuery } from "./OrQuery";
import { OrNode } from "./OrNode";
import { preparedStatementCache } from "../database/PreparedStatementCache";
import { getMetadataStorage } from "../core/metadata";
import { shouldUseDirectPartition } from "../core/Config";
import type { SQL } from "bun";

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
    private shouldPopulate: boolean = false;
    private trx: SQL | undefined;

    constructor(trx?: SQL) {
        this.trx = trx;
        this.context = new QueryContext(trx);
    }

    /**
     * Get the database connection to use (transaction or default db)
     */
    private getDb(): SQL {
        return this.trx ?? db;
    }

    public findById(id: string) {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            throw new Error(`Query.findById called with invalid id: "${id}"`);
        }
        this.context.withId = id;
        return this;
    }

    public async findOneById(id: string): Promise<Entity | null> {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            return null;
        }
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
        this.shouldPopulate = true;
        return this;
    }

    /**
     * Eagerly load specific components after query execution.
     * This preloads components into entities to avoid N+1 queries when accessing them later.
     * @param ctors Array of component constructors to eagerly load
     */
    public eagerLoadComponents(ctors: Array<new () => BaseComponent>): this {
        for (const ctor of ctors) {
            const type_id = this.context.getComponentId(ctor);
            if (!type_id) {
                throw new Error(`Component ${ctor.name} is not registered.`);
            }
            this.context.eagerComponents.add(type_id);
        }
        return this;
    }

    /**
     * Alias for eagerLoadComponents for backward compatibility
     */
    public eagerLoad<T extends BaseComponent>(ctors: (new (...args: any[]) => T)[]): this {
        return this.eagerLoadComponents(ctors);
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

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Check prepared statement cache
        const cacheKey = this.context.generateCacheKey();
        const { statement, isHit } = await preparedStatementCache.getOrCreate(countSql, cacheKey, dbConn);

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Count Debug:');
            console.log('SQL:', countSql);
            console.log('Params:', result.params);
            console.log('Cache Hit:', isHit);
            console.log('Using Transaction:', !!this.trx);
            console.log('---');
        }

        // Validate params before execution to catch UUID errors early
        for (let i = 0; i < result.params.length; i++) {
            const param = result.params[i];
            if (param === '' || (typeof param === 'string' && param.trim() === '')) {
                logger.error(`Empty string parameter detected at position ${i + 1} in count query`);
                throw new Error(`Query count parameter $${i + 1} is an empty string. This will cause PostgreSQL UUID parsing errors.`);
            }
        }

        // Execute the count query using prepared statement
        const countResult = await preparedStatementCache.execute(statement, result.params, dbConn);

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
        // Reset context for fresh execution
        this.context.reset();

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

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Debug:');
            console.log('SQL:', result.sql);
            console.log('Params:', result.params);
            console.log('OR Query:', !!this.orQuery);
            console.log('Using Transaction:', !!this.trx);
            console.log('---');
        }

        // Validate params before execution to catch UUID errors early
        for (let i = 0; i < result.params.length; i++) {
            const param = result.params[i];
            if (param === '' || (typeof param === 'string' && param.trim() === '')) {
                logger.error(`Empty string parameter detected at position ${i + 1}: SQL=${result.sql.substring(0, 200)}`);
                throw new Error(`Query parameter $${i + 1} is an empty string. This will cause PostgreSQL UUID parsing errors. SQL: ${result.sql.substring(0, 100)}...`);
            }
        }

        // Validate parameters before execution
        for (let i = 0; i < result.params.length; i++) {
            if (result.params[i] === undefined || result.params[i] === null) {
                console.error(`❌ Query parameter $${i + 1} is undefined/null`);
                console.error(`SQL: ${result.sql}`);
                console.error(`All params: ${JSON.stringify(result.params)}`);
                throw new Error(`Query parameter $${i + 1} is undefined/null. SQL: ${result.sql.substring(0, 100)}...`);
            }
        }

        let entities: any[];

        if (this.orQuery) {
            // For OR queries, bypass prepared statement cache and execute directly
            // This avoids potential parameter type inference issues with Bun's SQL
            entities = await dbConn.unsafe(result.sql, result.params);
        } else {
            // Check prepared statement cache for regular queries
            const cacheKey = this.context.generateCacheKey();
            const { statement, isHit } = await preparedStatementCache.getOrCreate(result.sql, cacheKey, dbConn);
            entities = await preparedStatementCache.execute(statement, result.params, dbConn);
        }

        // Convert to Entity objects
        const entityIds: string[] = entities.map((row: any) => row.id);

        if (entityIds.length === 0) {
            return [];
        }

        // Create Entity objects
        const entityMap = new Map<string, Entity>();
        for (const id of entityIds) {
            const entity = new Entity(id);
            entity.setPersisted(true);
            entity.setDirty(false);
            entityMap.set(id, entity);
        }

        // Populate entities with components if requested
        if (this.shouldPopulate && this.context.componentIds.size > 0) {
            await this.populateComponents(entityMap);
        }

        // Eagerly load specific components if requested
        if (this.context.eagerComponents.size > 0) {
            const entitiesArray = Array.from(entityMap.values());
            await Entity.LoadComponents(entitiesArray, Array.from(this.context.eagerComponents));
        }

        // Return entities in the same order as the query results
        return entityIds.map(id => entityMap.get(id)!);
    }

    /**
     * Bulk fetch and attach components to entities
     * @private
     */
    private async populateComponents(entityMap: Map<string, Entity>): Promise<void> {
        const entityIds = Array.from(entityMap.keys());
        const componentTypeIds = Array.from(this.context.componentIds);

        if (entityIds.length === 0 || componentTypeIds.length === 0) {
            return;
        }

        // Bulk fetch all components for all entities and all requested component types
        const entityIdList = inList(entityIds, 1);
        const typeIdList = inList(componentTypeIds, entityIdList.newParamIndex);

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        let components: any[];
        if (shouldUseDirectPartition() && componentTypeIds.length === 1) {
            // Single component type - use direct partition if available
            const partitionTableName = ComponentRegistry.getPartitionTableName(componentTypeIds[0]!);
            if (partitionTableName) {
                components = await dbConn.unsafe(`
                    SELECT id, entity_id, type_id, data
                    FROM ${partitionTableName}
                    WHERE entity_id IN ${entityIdList.sql}
                    AND type_id IN ${typeIdList.sql}
                    AND deleted_at IS NULL
                `, [...entityIdList.params, ...typeIdList.params]);
            } else {
                // Fallback to parent table
                components = await dbConn.unsafe(`
                    SELECT id, entity_id, type_id, data
                    FROM components
                    WHERE entity_id IN ${entityIdList.sql}
                    AND type_id IN ${typeIdList.sql}
                    AND deleted_at IS NULL
                `, [...entityIdList.params, ...typeIdList.params]);
            }
        } else {
            // Multiple types or direct partition disabled - use parent table
            components = await dbConn.unsafe(`
                SELECT id, entity_id, type_id, data
                FROM components
                WHERE entity_id IN ${entityIdList.sql}
                AND type_id IN ${typeIdList.sql}
                AND deleted_at IS NULL
            `, [...entityIdList.params, ...typeIdList.params]);
        }

        // Get metadata storage for Date deserialization
        const storage = getMetadataStorage();

        // Group components by entity_id and attach them to entities
        for (const row of components) {
            const entity = entityMap.get(row.entity_id);
            if (!entity) continue;

            // Get the component constructor from registry
            const ComponentCtor = ComponentRegistry.getConstructor(row.type_id);
            if (!ComponentCtor) {
                logger.warn(`Component constructor not found for type_id: ${row.type_id}`);
                continue;
            }

            // Create component instance
            const component = new ComponentCtor();
            
            // Parse and assign component data
            const componentData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            Object.assign(component, componentData);

            // Deserialize Date properties
            const props = storage.componentProperties.get(row.type_id);
            if (props) {
                for (const prop of props) {
                    if (prop.propertyType === Date && typeof (component as any)[prop.propertyKey] === 'string') {
                        (component as any)[prop.propertyKey] = new Date((component as any)[prop.propertyKey]);
                    }
                }
            }

            // Set component metadata
            component.id = row.id;
            component.setPersisted(true);
            component.setDirty(false);

            // Add component to entity (using protected method)
            (entity as any).addComponent(component);
        }
    }

    /**
     * Execute query with EXPLAIN ANALYZE for performance debugging
     * Returns the query plan and execution statistics
     */
    public async explainAnalyze(buffers: boolean = true): Promise<string> {
        // Reset context for fresh execution
        this.context.reset();

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

        // Get the database connection (transaction or default)
        const dbConn = this.getDb();

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query EXPLAIN ANALYZE Debug:');
            console.log('SQL:', explainSql);
            console.log('Params:', result.params);
            console.log('Using Transaction:', !!this.trx);
            console.log('---');
        }

        // Execute the EXPLAIN ANALYZE query
        const explainResult = await dbConn.unsafe(explainSql, result.params);

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
        // Validate value to catch empty strings early
        if (value === '' || (typeof value === 'string' && value.trim() === '')) {
            throw new Error(`Query.filter: Cannot create filter for field "${field}" with empty string value. This would cause PostgreSQL UUID parsing errors.`);
        }
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