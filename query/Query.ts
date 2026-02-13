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
import type { ComponentConstructor, TypedEntity, ComponentRecord } from "../types/query.types";

export type FilterOperator = "=" | ">" | "<" | ">=" | "<=" | "!=" | "LIKE" | "ILIKE" | "IN" | "NOT IN" | string;

export const FilterOp = {
    EQ: "=" as FilterOperator,
    GT: ">" as FilterOperator,
    LT: "<" as FilterOperator,
    GTE: ">=" as FilterOperator,
    LTE: "<=" as FilterOperator,
    NEQ: "!=" as FilterOperator,
    LIKE: "LIKE" as FilterOperator,
    ILIKE: "ILIKE" as FilterOperator,
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

export interface QueryCacheOptions {
    preparedStatement?: boolean;
    component?: boolean;
}

/**
 * New Query class that uses DAG internally for better modularity and extensibility.
 *
 * Generic type parameter `TComponents` tracks component types added via `.with()`,
 * enabling type-safe access to component data after query execution.
 *
 * @example
 * ```typescript
 * const entities = await new Query()
 *   .with(Position)
 *   .with(Velocity)
 *   .exec();
 * // entities is TypedEntity<[typeof Position, typeof Velocity]>[]
 * ```
 */
class Query<TComponents extends readonly ComponentConstructor[] = []> {
    private context: QueryContext;
    private debug: boolean = false;
    private orQuery: OrQuery | null = null;
    private shouldPopulate: boolean = false;
    private trx: SQL | undefined;
    private skipPreparedCache: boolean = false;
    private skipComponentCache: boolean = false;

    /** Component constructors added to this query for type-safe access */
    private _componentCtors: ComponentConstructor[] = [];

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

    public async findOneById(id: string): Promise<TypedEntity<TComponents> | null> {
        // Validate ID to prevent PostgreSQL UUID parsing errors
        if (!id || typeof id !== 'string' || id.trim() === '') {
            return null;
        }
        const entities = await this.findById(id).exec();
        return entities.length > 0 ? entities[0]! : null;
    }

    /**
     * Add a component requirement to the query with type accumulation.
     * The returned Query tracks all component types for type-safe access after exec().
     */
    public with<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        options?: QueryFilterOptions
    ): Query<readonly [...TComponents, new (...args: any[]) => T]>;
    public with(components: ComponentWithFilters[]): this;
    public with(orQuery: OrQuery): this;
    public with<T extends BaseComponent>(
        componentCtorOrComponentsOrOrQuery: (new (...args: any[]) => T) | ComponentWithFilters[] | OrQuery,
        options?: QueryFilterOptions
    ): Query<readonly [...TComponents, new (...args: any[]) => T]> | this {
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
                this._componentCtors.push(item.component);

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
            this._componentCtors.push(componentCtorOrComponentsOrOrQuery);

            if (options?.filters && options.filters.length > 0) {
                this.context.componentFilters.set(typeId, options.filters);
            }
        }

        return this as unknown as Query<readonly [...TComponents, new (...args: any[]) => T]>;
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

    /**
     * Use cursor-based pagination instead of OFFSET.
     * Much more efficient for large datasets - O(1) instead of O(offset).
     * 
     * @param cursorId - The entity ID to paginate from (exclusive)
     * @param direction - 'after' for next page (default), 'before' for previous page
     * @returns this for chaining
     * 
     * @example
     * // Get first page
     * const page1 = await new Query().with(User).take(100).exec();
     * 
     * // Get next page using cursor
     * const lastId = page1[page1.length - 1].id;
     * const page2 = await new Query().with(User).take(100).cursor(lastId).exec();
     */
    public cursor(cursorId: string, direction: 'after' | 'before' = 'after'): this {
        this.context.cursorId = cursorId;
        this.context.cursorDirection = direction;
        // Clear offset when using cursor-based pagination
        this.context.offsetValue = 0;
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

    /**
     * Bypass cache for this query.
     * @param options Cache options to bypass. If not provided, bypasses prepared statement cache.
     */
    public noCache(): this;
    public noCache(options: QueryCacheOptions): this;
    public noCache(options?: QueryCacheOptions): this {
        if (!options) {
            // Default behavior: bypass prepared statement cache
            this.skipPreparedCache = true;
        } else {
            if (options.preparedStatement === true) {
                this.skipPreparedCache = true;
            }
            if (options.component === true) {
                this.skipComponentCache = true;
            }
        }
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

    /**
     * Get an estimated count using PostgreSQL statistics.
     * Much faster than exact count() for large tables - O(1) instead of O(n).
     * 
     * Note: Returns approximate count based on PostgreSQL's statistics.
     * Run ANALYZE on the table for more accurate estimates.
     * 
     * @param component - The component class to count (uses its partition table)
     * @returns Estimated count (may be up to 10% off for recently modified tables)
     * 
     * @example
     * // Fast approximate count
     * const approxCount = await new Query().with(User).estimatedCount(User);
     * console.log(`Approximately ${approxCount} users`);
     */
    public async estimatedCount(component: new (...args: any[]) => BaseComponent): Promise<number> {
        const typeId = ComponentRegistry.getComponentId(component.name);
        if (!typeId) {
            throw new Error(`Component ${component.name} not registered`);
        }

        const tableName = ComponentRegistry.getPartitionTableName(typeId);
        const dbConn = this.getDb();

        // Use PostgreSQL's statistics for fast count estimate
        // This queries pg_class which is O(1) instead of scanning the table
        const sql = tableName && tableName !== 'components'
            ? `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = $1`
            : `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'entity_components'`;

        const result = await dbConn.unsafe(sql, [tableName || 'entity_components']);

        if (!result || result.length === 0 || result[0].estimate === null) {
            // Fallback to exact count if statistics not available
            return this.count();
        }

        return Number(result[0].estimate);
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

        let countResult: any[];

        if (this.skipPreparedCache) {
            // Bypass cache - execute directly
            countResult = await dbConn.unsafe(countSql, result.params);
        } else {
            // Check prepared statement cache
            // Add 'count:' prefix to differentiate count queries from exec queries
            const cacheKey = 'count:' + this.context.generateCacheKey();
            const { statement, isHit } = await preparedStatementCache.getOrCreate(countSql, cacheKey, dbConn);
            countResult = await preparedStatementCache.execute(statement, result.params, dbConn);
        }

        // Debug logging
        if (this.debug) {
            console.log('🔍 Query Count Debug:');
            console.log('SQL:', countSql);
            console.log('Params:', result.params);
            console.log('Prepared Cache Bypass:', this.skipPreparedCache);
            console.log('Component Cache Bypass:', this.skipComponentCache);
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

        // Safely extract count from result - handle undefined/null cases
        if (!countResult || countResult.length === 0 || countResult[0] === undefined) {
            return 0;
        }

        // PostgreSQL COUNT(*) returns a value, handle both string and number
        const count = countResult[0].count;
        if (count === undefined || count === null) {
            return 0;
        }
        return typeof count === 'string' ? parseInt(count, 10) : Number(count);
    }

    /**
     * Calculate the sum of a numeric field across all matching entities.
     * The component must be included in the query via .with().
     * @param componentCtor The component class containing the field
     * @param field The field name to sum (must be numeric)
     * @returns Promise resolving to the sum, or 0 if no matches
     */
    public sum<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>
    ): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`Query sum execution timeout`);
                reject(new Error(`Query sum execution timeout after 30 seconds`));
            }, 30000);
            this.doAggregate('SUM', componentCtor, field as string)
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

    /**
     * Calculate the average of a numeric field across all matching entities.
     * The component must be included in the query via .with().
     * @param componentCtor The component class containing the field
     * @param field The field name to average (must be numeric)
     * @returns Promise resolving to the average, or 0 if no matches
     */
    public average<T extends BaseComponent>(
        componentCtor: new (...args: any[]) => T,
        field: keyof ComponentDataType<T>
    ): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error(`Query average execution timeout`);
                reject(new Error(`Query average execution timeout after 30 seconds`));
            }, 30000);
            this.doAggregate('AVG', componentCtor, field as string)
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

    /**
     * Internal method to perform aggregate operations (SUM, AVG) on component fields.
     * Uses an optimized single-pass approach by joining to the component table
     * directly within the CTE-based query.
     */
    private async doAggregate(
        aggregateType: 'SUM' | 'AVG',
        componentCtor: new (...args: any[]) => BaseComponent,
        field: string
    ): Promise<number> {
        // Get the component type ID
        const typeId = this.context.getComponentId(componentCtor);
        if (!typeId) {
            throw new Error(`Component ${componentCtor.name} is not registered.`);
        }

        // Validate that the component is in the query
        if (!this.context.componentIds.has(typeId)) {
            throw new Error(
                `Cannot aggregate on component ${componentCtor.name} that is not included in the query. ` +
                `Use .with(${componentCtor.name}) first.`
            );
        }

        // Reset context for fresh execution
        this.context.reset();

        // Build the DAG
        const dag = new QueryDAG();

        // Check if we have an OR query
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

        // Execute the DAG to get the base query
        const result = dag.execute(this.context);

        // Determine the component table name
        const componentTableName = shouldUseDirectPartition()
            ? (ComponentRegistry.getPartitionTableName(typeId) || 'components')
            : 'components';

        // Build the JSON path for the field
        let jsonPath: string;
        if (field.includes('.')) {
            const parts = field.split('.');
            const lastPart = parts.pop()!;
            const nestedPath = parts.map(p => `'${p}'`).join('->');
            jsonPath = `c.data->${nestedPath}->>'${lastPart}'`;
        } else {
            jsonPath = `c.data->>'${field}'`;
        }

        // Add the type_id parameter for the JOIN condition
        const typeIdParamIndex = this.context.addParam(typeId);

        // Build aggregate SQL by wrapping the entity query as a subquery
        // This approach works consistently regardless of CTE usage
        // The base query returns entity_id (aliased as 'id'), which we join to components
        const aggregateSql = `
SELECT ${aggregateType}((${jsonPath})::numeric) as result
FROM (${result.sql}) AS entity_subq
JOIN ${componentTableName} c ON c.entity_id = entity_subq.id
WHERE c.type_id = $${typeIdParamIndex}
AND c.deleted_at IS NULL`;

        // Get the database connection
        const dbConn = this.getDb();

        let aggregateResult: any[];

        if (this.skipPreparedCache) {
            aggregateResult = await dbConn.unsafe(aggregateSql, result.params);
        } else {
            const cacheKey = `${aggregateType.toLowerCase()}:${typeId}:${field}:` + this.context.generateCacheKey();
            const { statement } = await preparedStatementCache.getOrCreate(aggregateSql, cacheKey, dbConn);
            aggregateResult = await preparedStatementCache.execute(statement, result.params, dbConn);
        }

        // Debug logging
        if (this.debug) {
            console.log(`🔍 Query ${aggregateType} Debug:`);
            console.log('SQL:', aggregateSql);
            console.log('Params:', result.params);
            console.log('Component:', componentCtor.name);
            console.log('Field:', field);
            console.log('---');
        }

        // Validate params
        for (let i = 0; i < result.params.length; i++) {
            const param = result.params[i];
            if (param === '' || (typeof param === 'string' && param.trim() === '')) {
                logger.error(`Empty string parameter detected at position ${i + 1} in ${aggregateType} query`);
                throw new Error(`Query ${aggregateType} parameter $${i + 1} is an empty string.`);
            }
        }

        // Extract result
        if (!aggregateResult || aggregateResult.length === 0 || aggregateResult[0] === undefined) {
            return 0;
        }

        const value = aggregateResult[0].result;
        if (value === undefined || value === null) {
            return 0;
        }
        return typeof value === 'string' ? parseFloat(value) : Number(value);
    }

    /**
     * Execute the query and return typed entities.
     *
     * When components are added via `.with()`, the returned entities have:
     * - `getTyped(Ctor)`: Type-safe async getter (returns non-null since query guarantees existence)
     * - `componentData`: Synchronous access to already-loaded component data
     *
     * @returns Promise resolving to array of TypedEntity with accumulated component types
     */
    @timed("Query.exec")
    public async exec(): Promise<TypedEntity<TComponents>[]> {
        return new Promise<TypedEntity<TComponents>[]>((resolve, reject) => {
            // Add timeout to prevent hanging queries
            const timeout = setTimeout(() => {
                logger.error(`Query execution timeout`);
                reject(new Error(`Query execution timeout after 30 seconds`));
            }, 30000); // 30 second timeout

            this.doExec()
                .then(result => {
                    clearTimeout(timeout);
                    // Wrap entities with typed accessors
                    const typedEntities = result.map(e => this.wrapTypedEntity(e));
                    resolve(typedEntities);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    }

    /**
     * Wrap an entity with typed accessors for components in this query.
     * Provides both async getTyped() and synchronous componentData access.
     */
    private wrapTypedEntity(entity: Entity): TypedEntity<TComponents> {
        const componentCtors = this._componentCtors;

        // Build synchronous component data record from already-loaded components
        const componentData: Record<string, any> = {};
        for (const ctor of componentCtors) {
            const comp = entity.getInMemory(ctor);
            if (comp) {
                componentData[ctor.name] = (comp as any).data();
            }
        }

        // Create typed entity wrapper
        const typedEntity = entity as TypedEntity<TComponents>;

        // Define componentData property
        Object.defineProperty(typedEntity, 'componentData', {
            value: componentData as ComponentRecord<TComponents>,
            writable: false,
            enumerable: true
        });

        // Define _queriedComponents property for runtime reflection
        Object.defineProperty(typedEntity, '_queriedComponents', {
            value: componentCtors as unknown as TComponents,
            writable: false,
            enumerable: false
        });

        // Define getTyped method
        Object.defineProperty(typedEntity, 'getTyped', {
            value: async function<T extends TComponents[number]>(
                ctor: T
            ): Promise<T extends ComponentConstructor<infer C> ? C extends BaseComponent ? ComponentDataType<C> : never : never> {
                const data = await entity.get(ctor as any);
                if (!data) {
                    throw new Error(`Component ${(ctor as any).name} not found on entity ${entity.id}, but it was expected from query`);
                }
                return data as any;
            },
            writable: false,
            enumerable: false
        });

        return typedEntity;
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
            console.log('Prepared Cache Bypass:', this.skipPreparedCache);
            console.log('Component Cache Bypass:', this.skipComponentCache);
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

        if (this.orQuery || this.skipPreparedCache) {
            // For OR queries or explicit cache bypass, execute directly
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
            await Entity.LoadComponents(entitiesArray, Array.from(this.context.eagerComponents), this.skipComponentCache);
        }

        // Return entities in the same order as the query results
        const finalEntities = entityIds.map(id => entityMap.get(id)!);

        return finalEntities;
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