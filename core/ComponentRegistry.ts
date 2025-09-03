import { generateTypeId, type BaseComponent } from "./Components";
import ApplicationLifecycle, { ApplicationPhase } from "./ApplicationLifecycle";
import { CreateComponentPartitionTable } from "database/DatabaseHelper";
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
                return;
            }
        }
        if(this.instantRegister) {
            if(this.componentsMap.has(name)) {
                logger.trace(`Component already registered: ${name}`);
                return;
            }
            this.register(name, generateTypeId(name), ctor);
        }
    }

    componentSize() {
        return this.componentQueue.size;
    }

    isComponentReady(name: string): boolean {
        return this.componentsMap.has(name);
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
    }

    register(name: string, typeid: string, ctor: new () => BaseComponent) {
        return new Promise<boolean>(async resolve => {
            const partitionTableName = `components_${this.sluggifyName(name)}`;
            await this.populateCurrentTables();
            if (!this.currentTables.includes(partitionTableName)) {
                logger.trace(`Partition table ${partitionTableName} does not exist. Creating... name: ${name}, typeId: ${typeid}`);
                const instance = new ctor();
                const indexedProps = instance.indexedProperties();
                await CreateComponentPartitionTable(name, typeid, indexedProps);
                await this.populateCurrentTables();
            }
            this.componentsMap.set(name, typeid);
            this.typeIdToCtor.set(typeid, ctor);
            resolve(true);
        });
    }


    private sluggifyName(name: string) {
        return name.toLowerCase().replace(/\s+/g, '_');
    }
}

export default ComponentRegistry.instance;