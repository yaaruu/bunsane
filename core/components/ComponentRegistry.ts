import { generateTypeId } from "./Decorators";
import { type BaseComponent } from "./BaseComponent";
import ApplicationLifecycle, {
    ApplicationPhase,
} from "../ApplicationLifecycle";
import {
    CreateComponentPartitionTable,
    GenerateTableName,
    UpdateComponentIndexes,
    AnalyzeAllComponentTables,
    GetPartitionStrategy,
} from "../../database/DatabaseHelper";
import { ensureMultipleJSONBPathIndexes } from "database/IndexingStrategy";
import { GetSchema } from "database/DatabaseHelper";
import { logger as MainLogger } from "../Logger";
import { getMetadataStorage } from "../metadata";
import { registerDecoratedHooks } from "../decorators/EntityHooks";
import ServiceRegistry from "../../service/ServiceRegistry";
import { preparedStatementCache } from "../../database/PreparedStatementCache";
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

    // TODO: OLD LOGIC Remove if not needed
    // async registerAllComponents(): Promise<void> {
    //     logger.trace(`Registering all components`);
    //     for(const [name, ctor] of this.componentQueue) {
    //         const typeId = generateTypeId(name);
    //         await this.register(name, typeId, ctor);
    //     }
    //     ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_READY);
    //     // Resolve all pending readiness promises
    //     for(const [name] of this.componentQueue) {
    //         const resolve = this.readinessResolvers.get(name);
    //         if(resolve) resolve();
    //     }
    // }

    async registerAllComponents(): Promise<void> {
        if (this.componentsRegistered) {
            return; // Already registered
        }

        logger.trace("Registering Components...");
        ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_REGISTERING);

        await this.populateCurrentTables();
        const storage = getMetadataStorage();
        const promises = storage.components.map(async (metadata) => {
            const { name, target: ctor, typeId } = metadata;
            if (this.componentsMap.has(name)) {
                logger.trace(`Component already registered: ${name}`);
                return;
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
        });
        await Promise.all(promises);
        this.componentsRegistered = true;

        // Handle component-related setup that was previously in App.init()
        await this.setupComponentFeatures();

        ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_READY);
    }

    register(name: string, typeid: string, ctor: ComponentConstructor) {
        return new Promise<boolean>(async (resolve) => {
            const partitionTableName = GenerateTableName(name);
            // await this.populateCurrentTables();
            // const instance = new ctor();
            // const indexedProps = instance.indexedProperties();
            if (!this.currentTables.includes(partitionTableName)) {
                logger.trace(
                    `Partition table ${partitionTableName} does not exist. Creating... name: ${name}, typeId: ${typeid}`
                );
                // await CreateComponentPartitionTable(name, typeid, indexedProps); // TODO: OLD Logic with indexedProps, remove if not needed
                await CreateComponentPartitionTable(name, typeid);
                // await this.populateCurrentTables();
            }
            // await UpdateComponentIndexes(partitionTableName, indexedProps); // TODO: OLD Logic with indexedProps, remove if not needed
            this.componentsMap.set(name, typeid);
            this.typeIdToName.set(typeid, name);
            this.typeIdToCtor.set(typeid, ctor);
            resolve(true);
        });
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

    private async setupComponentFeatures(): Promise<void> {
        const components = this.getComponents();

        // Invalidate prepared statement cache when component schemas change
        preparedStatementCache.clear();
        logger.trace(
            "Cleared prepared statement cache due to component schema changes"
        );

        // Check partitioning strategy for index creation
        const partitionStrategy = await GetPartitionStrategy();

        // Update component indexes for components that have indexed properties
        // NOTE: Index operations are serialized to prevent deadlocks with ANALYZE
        for (const { name, ctor } of components) {
            const instance = new ctor();
            const table_name = GenerateTableName(name);

            // Handle legacy @CompData(indexed: true) properties
            if (instance.indexedProperties().length > 0) {
                // For HASH partitioning, redirect index operations to parent table
                const indexTableName =
                    partitionStrategy === "hash" ? "components" : table_name;
                await UpdateComponentIndexes(
                    indexTableName,
                    instance.indexedProperties()
                );
                logger.trace(
                    `Updated legacy indexes for component: ${name} on table: ${indexTableName}`
                );
            }

            // Handle new @IndexedField decorators
            const indexedFields = this.getIndexedFieldsForComponent(name);
            if (indexedFields.length > 0) {
                // For HASH partitioning, create indexes on parent table
                const indexTableName =
                    partitionStrategy === "hash" ? "components" : table_name;
                const indexDefinitions = indexedFields.map((field) => ({
                    tableName: indexTableName,
                    field: field.propertyKey,
                    indexType: field.indexType,
                    isDateField: field.isDateField,
                }));
                await ensureMultipleJSONBPathIndexes(
                    indexTableName,
                    indexDefinitions
                );
                logger.trace(
                    `Created specialized indexes for component: ${name} on table: ${indexTableName}`
                );
            }
        }

        // Automatically register decorated hooks for all services
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

        // Run ANALYZE on all component tables to update query planner statistics
        await AnalyzeAllComponentTables();
    }
}

export default ComponentRegistry.instance;
