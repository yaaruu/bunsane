import { generateTypeId, type BaseComponent } from "./Components";
import ApplicationLifecycle, { ApplicationPhase } from "./ApplicationLifecycle";
import { CreateComponentPartitionTable, GenerateTableName, UpdateComponentIndexes } from "database/DatabaseHelper";
import { GetSchema } from "database/DatabaseHelper";
import { logger as MainLogger } from "./Logger";
const logger = MainLogger.child({ scope: "ComponentRegistry" });

class ComponentRegistry {
    static #instance: ComponentRegistry;
    private componentQueue = new Map<string, new () => BaseComponent>();
    private currentTables: string[] = [];
    private componentsMap = new Map<string, string>();
    private typeIdToCtor = new Map<string, new () => BaseComponent>();
    private instantRegister: boolean = false;
    private readinessPromises = new Map<string, Promise<void>>();
    private readinessResolvers = new Map<string, () => void>();

    constructor() {
        
    }

    public init() {
        ApplicationLifecycle.addPhaseListener(async (event) => {
            if(event.detail === ApplicationPhase.DATABASE_READY) {
                logger.trace("Registering Components...");
                ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_REGISTERING);
                logger.trace(`Total Components to register: ${this.componentQueue.size}`);
                await this.populateCurrentTables();
                await this.registerAllComponents();
                this.instantRegister = true;
            }
        });
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

    define(
        name: string,
        ctor: new () => BaseComponent
    ) {
        if(!this.instantRegister) {
            if(!this.componentQueue.has(name)) {
                this.componentQueue.set(name, ctor);
                this.readinessPromises.set(name, new Promise<void>(resolve => {
                    this.readinessResolvers.set(name, resolve);
                }));
                return;
            }
        }
        if(this.instantRegister) {
            if(this.componentsMap.has(name)) {
                logger.trace(`Component already registered: ${name}`);
                return;
            }
            this.register(name, generateTypeId(name), ctor).then(() => {
                const resolve = this.readinessResolvers.get(name);
                if(resolve) resolve();
            });
        }
    }

    componentSize() {
        return this.componentQueue.size;
    }

    isComponentReady(name: string): boolean {
        return this.componentsMap.has(name);
    }

    getReadyPromise(name: string): Promise<void> {
        if (this.isComponentReady(name)) {
            return Promise.resolve();
        }
        const promise = this.readinessPromises.get(name);
        if (!promise) {
            return Promise.reject(new Error(`Component ${name} not defined`));
        }
        return promise;
    }

    getComponentId(name: string) {
        return this.componentsMap.get(name);
    }

    getConstructor(typeId: string) {
        return this.typeIdToCtor.get(typeId);
    }

    async registerAllComponents(): Promise<void> {
        logger.trace(`Registering all components`);
        for(const [name, ctor] of this.componentQueue) {
            const typeId = generateTypeId(name);
            await this.register(name, typeId, ctor);
        }
        ApplicationLifecycle.setPhase(ApplicationPhase.COMPONENTS_READY);
        // Resolve all pending readiness promises
        for(const [name] of this.componentQueue) {
            const resolve = this.readinessResolvers.get(name);
            if(resolve) resolve();
        }
    }

    register(name: string, typeid: string, ctor: new () => BaseComponent) {
        return new Promise<boolean>(async resolve => {
            const partitionTableName = GenerateTableName(name);
            await this.populateCurrentTables();
            // const instance = new ctor();
            // const indexedProps = instance.indexedProperties();
            if (!this.currentTables.includes(partitionTableName)) {
                logger.trace(`Partition table ${partitionTableName} does not exist. Creating... name: ${name}, typeId: ${typeid}`);
                // await CreateComponentPartitionTable(name, typeid, indexedProps);
                await CreateComponentPartitionTable(name, typeid);
                await this.populateCurrentTables();
            }
            // await UpdateComponentIndexes(partitionTableName, indexedProps);
            this.componentsMap.set(name, typeid);
            this.typeIdToCtor.set(typeid, ctor);
            resolve(true);
        });
    }

    getComponents() {
        // returns array of { name, ctor }
        const components: { name: string, ctor: new () => BaseComponent }[] = [];
        for (const [name, typeid] of this.componentsMap) {
            const ctor = this.typeIdToCtor.get(typeid);
            if(ctor) {
                components.push({ name, ctor });
            }
        }
        return components;
    }

}

export default ComponentRegistry.instance;