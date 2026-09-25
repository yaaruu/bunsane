import { generateTypeId } from "./Decorators";
import { type BaseComponent } from "./BaseComponent";
import ApplicationLifecycle, {
    ApplicationPhase,
} from "../ApplicationLifecycle";
import {
    CreateComponentPartitionTable,
    GenerateTableName,
    AnalyzeAllComponentTables,
    CreateRelationIndexes,
    GetPartitionStrategy,
} from "../../database/DatabaseHelper";
import {
    ensureMultipleJSONBPathIndexes,
    loadComponentIndexCatalog,
} from "../../database/IndexingStrategy";
import type { IndexBootContext } from "../../database/IndexingStrategy";
import { reconcileKeyIndexes } from "../../database/indexReconciler";
import type { KeyIndexComponent } from "../../database/indexReconciler";
import { GetSchema } from "../../database/DatabaseHelper";
import { logger as MainLogger } from "../Logger";
import { getMetadataStorage } from "../metadata";
import { registerDecoratedHooks } from "../decorators/EntityHooks";
const logger = MainLogger.child({ scope: "ComponentRegistry" });

type ComponentConstructor = new () => BaseComponent;

export type { ComponentConstructor };

class ComponentRegistry {
    static #instance: ComponentRegistry;
    private componentQueue = new Map<string, ComponentConstructor>();
    private currentTables: string[] = [];
    private componentsMap = new Map<string, string>();
    private typeIdToName = new Map<string, string>();
    private typeIdToCtor = new Map<string, ComponentConstructor>();
    private instantRegister: boolean = false;
    private readinessPromises = new Map<string, Promise<void>>();
    private readinessResolvers = new Map<string, () => void>();
    private componentsRegistered: boolean = false;
    private cachedPartitionStrategy: 'list' | 'hash' | null = null;
    private indexBoot: IndexBootContext | undefined;
    private schemaChangedThisBoot = false;
    private registerAllInFlight: Promise<void> | null = null;

    constructor() {}

    public init() {
        // Listener removed to make component registration sequential
    }

    public static get instance(): ComponentRegistry {
        if (!this.#instance) {
            this.#instance = new ComponentRegistry();
        }
        return this.#instance;
    }

    private async populateCurrentTables() {
        try {
            this.currentTables = await GetSchema();
        } catch (error) {
            logger.warn(`Failed to populate current tables: ${error}`);
            this.currentTables = [];
        }
    }

    define(name: string, ctor: ComponentConstructor) {
        if (!this.instantRegister) {
            if (!this.componentQueue.has(name)) {
                this.componentQueue.set(name, ctor);
                this.readinessPromises.set(
                    name,
                    new Promise<void>((resolve) => {
                        this.readinessResolvers.set(name, resolve);
                    })
                );
                return;
            }
        }
        if (this.instantRegister) {
            if (this.componentsMap.has(name)) {
                logger.trace(`Component already registered: ${name}`);
                return;
            }
            this.register(name, generateTypeId(name), ctor).then(() => {
                const resolve = this.readinessResolvers.get(name);
                if (resolve) resolve();
            }).catch((error) => {
                logger.error(`Failed to register component ${name}: ${error}`);
            });
        }
    }

    componentSize() {
        return this.componentQueue.size;
    }

    isComponentReady(name: string): boolean {
        return this.componentsMap.has(name);
    }

    async getReadyPromise(name: string): Promise<void> {
        if (this.isComponentReady(name)) {
            return Promise.resolve();
        }

        // Ensure components are registered before trying to find the component
        await this.ensureComponentsRegistered();

        if (this.isComponentReady(name)) {
            return Promise.resolve();
        }

        const storage = getMetadataStorage();
        const component = storage.components.find((c) => c.name === name);
        if (component) {
            // Component exists in metadata but not registered yet, register it
            return this.registerComponentFromMetadata(component);
        }
        // Check if component is in the queue (defined but not registered)
        if (this.componentQueue.has(name)) {
            const promise = this.readinessPromises.get(name);
            if (promise) {
                return promise;
            }
        }
        // Component not found anywhere, try to register it dynamically
        // This handles test components that are decorated but not imported in main app
        return this.registerComponentDynamically(name);
    }

    getComponentId(name: string) {
        return this.componentsMap.get(name);
    }

    getComponentName(typeId: string): string | undefined {
        return this.typeIdToName.get(typeId);
    }

    /**
     * Get component constructor by component name
     * @param name Component class name
     * @returns Component constructor or undefined
     */
    getConstructorByName(name: string): ComponentConstructor | undefined {
        const typeId = this.componentsMap.get(name);
        if (!typeId) return undefined;
        return this.typeIdToCtor.get(typeId);
    }

    getPartitionTableName(typeId: string): string | null {
        const name = this.typeIdToName.get(typeId);
        if (!name) return null;
        return GenerateTableName(name);
    }

    getConstructor(typeId: string) {
        return this.typeIdToCtor.get(typeId);
    }

    async registerAllComponents(): Promise<void> {
        if (this.componentsRegistered) return;
        if (this.registerAllInFlight) return this.registerAllInFlight;
        this.registerAllInFlight = this.runRegisterAll().finally(() => {
            this.registerAllInFlight = null;
        });
        return this.registerAllInFlight;
    }

    private async runRegisterAll(): Promise<void> {
        if (this.componentsRegistered) return;

        logger.trace("Registering Components...");
        ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_REGISTERING);

        await this.populateCurrentTables();
        const strategy = await GetPartitionStrategy();
        this.cachedPartitionStrategy = strategy === "hash" || strategy === "list" ? strategy : null;
        this.indexBoot = {
            existing: await loadComponentIndexCatalog(),
            partitionStrategy: this.cachedPartitionStrategy,
            indexCreated: false,
        };
        this.schemaChangedThisBoot = false;

        const storage = getMetadataStorage();
        // Sequential: CREATE TABLE ... PARTITION OF takes ACCESS EXCLUSIVE on
        // `components`. Parallel attaches deadlock or queue behind that lock.
        for (const metadata of storage.components) {
            const { name, target: ctor, typeId } = metadata;
            if (this.componentsMap.has(name)) {
                logger.trace(`Component already registered: ${name}`);
                continue;
            }
            const { promise, resolve } = Promise.withResolvers<void>();
            this.readinessPromises.set(name, promise);
            this.readinessResolvers.set(name, resolve);
            await this.register(name, typeId, ctor as ComponentConstructor);
            resolve();
        }
        this.componentsRegistered = true;

        await this.setupComponentFeatures();

        ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_READY);
    }

    async register(name: string, typeid: string, ctor: ComponentConstructor): Promise<boolean> {
        if (this.componentsRegistered && this.cachedPartitionStrategy === "list") {
            logger.warn(
                `Runtime partition attach for component "${name}" takes ACCESS EXCLUSIVE on the ` +
                `components table, stalling all component reads and writes until the DDL completes. ` +
                `Pre-register all components at startup, or set BUNSANE_PARTITION_STRATEGY=hash ` +
                `to avoid per-component partitions.`
            );
        }
        const partitionTableName = GenerateTableName(name);
        if (!this.currentTables.includes(partitionTableName)) {
            logger.trace(
                `Partition table ${partitionTableName} does not exist. Creating... name: ${name}, typeId: ${typeid}`
            );
            const created = await CreateComponentPartitionTable(name, typeid, {
                strategy: this.cachedPartitionStrategy,
                boot: this.indexBoot,
            });
            if (created) {
                this.schemaChangedThisBoot = true;
                this.currentTables.push(partitionTableName);
            }
        }
        this.componentsMap.set(name, typeid);
        this.typeIdToName.set(typeid, name);
        this.typeIdToCtor.set(typeid, ctor);
        if (this.componentsRegistered) {
            await this.setupNonKeyIndexes(name);
            const shared = this.cachedPartitionStrategy === "hash";
            await reconcileKeyIndexes({
                components: shared
                    ? this.getComponents().map(({ name: componentName }) => this.keyIndexComponent(componentName))
                    : [this.keyIndexComponent(name)],
                includeEntities: false,
                dropUndesired: true,
            });
        }
        return true;
    }

    private async registerComponentFromMetadata(component: any): Promise<void> {
        const { name, target: ctor, typeId } = component;
        if (this.componentsMap.has(name)) {
            return; // Already registered
        }
        this.readinessPromises.set(
            name,
            new Promise<void>((resolve) => {
                this.readinessResolvers.set(name, resolve);
            })
        );
        await this.register(name, typeId, ctor as ComponentConstructor);
        const resolve = this.readinessResolvers.get(name);
        if (resolve) resolve();
    }

    private async registerComponentDynamically(name: string): Promise<void> {
        // Try to find the component in global metadata storage
        const storage = getMetadataStorage();
        const component = storage.components.find((c) => c.name === name);
        if (component) {
            return this.registerComponentFromMetadata(component);
        }

        // If still not found, this is an error - component was never decorated
        throw new Error(
            `Component ${name} not found in metadata storage. Make sure it's decorated with @Component`
        );
    }

    getComponents() {
        // returns array of { name, ctor }
        const components: { name: string; ctor: ComponentConstructor }[] = [];
        for (const [name, typeid] of this.componentsMap) {
            const ctor = this.typeIdToCtor.get(typeid);
            if (ctor) {
                components.push({ name, ctor });
            }
        }
        return components;
    }

    async ensureComponentsRegistered(): Promise<void> {
        if (!this.componentsRegistered) {
            // If components haven't been registered yet, register them now
            // This handles cases where components are needed before DATABASE_READY phase
            logger.trace("Ensuring components are registered...");
            await this.registerAllComponents();
        }
    }

    private getIndexedFieldsForComponent(componentName: string) {
        const storage = getMetadataStorage();
        const componentId = storage.getComponentId(componentName);
        return storage.getIndexedFields(componentId);
    }

    private keyIndexComponent(name: string): KeyIndexComponent {
        const strategy = this.cachedPartitionStrategy === "hash" ? "hash" : "list";
        return {
            name,
            table: strategy === "hash" ? "components" : GenerateTableName(name),
            strategy,
        };
    }

    /** gin / hash / fulltext only. btree and numeric are key indexes. */
    private async setupNonKeyIndexes(name: string): Promise<boolean> {
        const indexTableName = this.cachedPartitionStrategy === "hash" ? "components" : GenerateTableName(name);
        const storage = getMetadataStorage();
        const componentId = storage.getComponentId(name);
        let created = false;

        const arrayIndexed = storage
            .getComponentProperties(componentId)
            .filter((p) => p.indexed && p.arrayOf != null);
        if (arrayIndexed.length > 0) {
            created = await ensureMultipleJSONBPathIndexes(
                indexTableName,
                arrayIndexed.map((p) => ({
                    tableName: indexTableName,
                    field: p.propertyKey,
                    indexType: "gin" as const,
                })),
                this.indexBoot,
            ) || created;
        }

        const indexedFields = this.getIndexedFieldsForComponent(name).filter(
            (field) => field.indexType !== "btree" && field.indexType !== "numeric",
        );
        if (indexedFields.length > 0) {
            created = await ensureMultipleJSONBPathIndexes(
                indexTableName,
                indexedFields.map((field) => ({
                    tableName: indexTableName,
                    field: field.propertyKey,
                    indexType: field.indexType,
                    isDateField: field.isDateField,
                })),
                this.indexBoot,
            ) || created;
        }
        return created;
    }

    private async setupComponentFeatures(): Promise<void> {
        const components = this.getComponents();
        const partitionStrategy = this.cachedPartitionStrategy;
        if (!this.indexBoot) {
            this.indexBoot = {
                existing: await loadComponentIndexCatalog(),
                partitionStrategy,
                indexCreated: false,
            };
        }

        for (const { name } of components) {
            if (await this.setupNonKeyIndexes(name)) this.schemaChangedThisBoot = true;
        }

        // Static import cycles through ServiceRegistry → gql → components.
        // Loaded here, after partitions exist, so the cycle never runs at module init.
        const { default: ServiceRegistry } = await import("../../service/ServiceRegistry");
        const services = ServiceRegistry.getServices();
        for (const service of services) {
            try {
                registerDecoratedHooks(service);
            } catch (error) {
                logger.warn(
                    `Failed to register hooks for service ${service.constructor.name}`
                );
                logger.warn(error);
            }
        }
        logger.info(`Registered hooks for ${services.length} services`);

        try {
            const created = await CreateRelationIndexes(this.indexBoot);
            if (created) this.schemaChangedThisBoot = true;
        } catch (error) {
            logger.warn(`Failed to create relation FK indexes: ${error}`);
        }

        await reconcileKeyIndexes({
            components: components.map(({ name }) => this.keyIndexComponent(name)),
            includeEntities: true,
            dropUndesired: true,
        });

        if (this.schemaChangedThisBoot || this.indexBoot.indexCreated) {
            await AnalyzeAllComponentTables();
        } else {
            logger.trace("Skipping ANALYZE; no partition or index was created this boot");
        }
    }
}

export default ComponentRegistry.instance;
