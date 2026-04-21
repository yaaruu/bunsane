import type BaseService from "./Service";
import ApplicationLifecycle, {ApplicationPhase, type PhaseChangeEvent} from "../core/ApplicationLifecycle";
import { generateGraphQLSchemaV2 } from "../gql";
import { GraphQLSchema } from "graphql";

/**
 * ServiceRegistry is a singleton. The default export and the re-exported
 * named `ServiceRegistry` from `service/index.ts` both resolve to the
 * singleton instance (for backward compatibility). When you need the class
 * itself (for typing or subclassing), import `ServiceRegistryClass`.
 */
export class ServiceRegistry {
    static #instance: ServiceRegistry;

    private services: Map<string, BaseService> = new Map();
    private schema: GraphQLSchema | null = null;
    private phaseListener: ((event: PhaseChangeEvent) => void) | null = null;


    constructor() {

    }

    public init() {
        // Remove previous listener if re-init (tests) to prevent listener stacking.
        if (this.phaseListener) {
            ApplicationLifecycle.removePhaseListener(this.phaseListener);
        }
        this.phaseListener = (event: PhaseChangeEvent) => {
            switch(event.detail) {
                case ApplicationPhase.SYSTEM_REGISTERING: {
                    const servicesArray = Array.from(this.services.values());

                    const result = generateGraphQLSchemaV2(servicesArray, {
                        enableArchetypeOperations: false
                    });

                    this.schema = result.schema;
                    ApplicationLifecycle.setPhase(ApplicationPhase.SYSTEM_READY);
                    break;
                };
            }
        };
        ApplicationLifecycle.addPhaseListener(this.phaseListener);
    }

    public dispose(): void {
        if (this.phaseListener) {
            ApplicationLifecycle.removePhaseListener(this.phaseListener);
            this.phaseListener = null;
        }
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