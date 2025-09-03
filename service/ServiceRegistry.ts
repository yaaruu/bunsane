import type BaseService from "./Service";
import ApplicationLifecycle, {ApplicationPhase} from "core/ApplicationLifecycle";
import { generateGraphQLSchema } from "gql/Generator";
import { GraphQLSchema } from "graphql";

class ServiceRegistry {
    static #instance: ServiceRegistry;

    private systems: Map<string, BaseService> = new Map();
    private schema: GraphQLSchema | null = null;


    constructor() {
        
    }

    public init() {
        ApplicationLifecycle.addPhaseListener((event) => {
            switch(event.detail) {
                case ApplicationPhase.SYSTEM_REGISTERING: {
                    const systemsArray = Array.from(this.systems.values());
                    const { schema } = generateGraphQLSchema(systemsArray);
                    this.schema = schema;
                    ApplicationLifecycle.setPhase(ApplicationPhase.SYSTEM_READY);
                    break;
                };
            }
        });
    }



    public static get instance() : ServiceRegistry {
        if (!ServiceRegistry.#instance) {
            ServiceRegistry.#instance = new ServiceRegistry();
        }
        return ServiceRegistry.#instance;
    }

    public registerService(system: BaseService) {
        if(!this.systems.has(system.constructor.name)) {
            this.systems.set(system.constructor.name, system);
        }
    }

    public getSchema(): GraphQLSchema | null {
        return this.schema;
    }
}

export default ServiceRegistry.instance;