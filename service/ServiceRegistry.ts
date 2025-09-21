import type BaseService from "./Service";
import ApplicationLifecycle, {ApplicationPhase} from "core/ApplicationLifecycle";
import { generateGraphQLSchema } from "gql/Generator";
import { GraphQLSchema } from "graphql";

class ServiceRegistry {
    static #instance: ServiceRegistry;

    private services: Map<string, BaseService> = new Map();
    private schema: GraphQLSchema | null = null;


    constructor() {
        
    }

    public init() {
        ApplicationLifecycle.addPhaseListener((event) => {
            switch(event.detail) {
                case ApplicationPhase.SYSTEM_REGISTERING: {
                    const servicesArray = Array.from(this.services.values());
                    const { schema } = generateGraphQLSchema(servicesArray);
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

    public registerService(service: BaseService) {
        if(!this.services.has(service.constructor.name)) {
            this.services.set(service.constructor.name, service);
        }
        return service;
    }

    public getServices(): BaseService[] {
        return Array.from(this.services.values());
    }

    public getSchema(): GraphQLSchema | null {
        return this.schema;
    }
}

export default ServiceRegistry.instance;