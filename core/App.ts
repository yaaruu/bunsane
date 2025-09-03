import ApplicationLifecycle, {ApplicationPhase} from "core/ApplicationLifecycle";
import { HasValidBaseTable, PrepareDatabase } from "database/DatabaseHelper";
import ComponentRegistry from "core/ComponentRegistry";
import { logger } from "core/Logger";
import { createYogaInstance } from "gql";
import ServiceRegistry from "service/ServiceRegistry";

export default class App {
    private yoga: any;

    constructor() {
        this.init();
    }

    async init() {
        logger.trace(`Initializing App`);
        ComponentRegistry.init();
        ServiceRegistry.init();
        if(ApplicationLifecycle.getCurrentPhase() === ApplicationPhase.DATABASE_INITIALIZING) {
            if(!await HasValidBaseTable()) {
                await PrepareDatabase();
            }
            logger.trace(`Database prepared...`);
            ApplicationLifecycle.setPhase(ApplicationPhase.DATABASE_READY);
        }

        ApplicationLifecycle.addPhaseListener((event) => {
            const phase = event.detail;
            logger.info(`Application phase changed to: ${phase}`);
            switch(phase) {
                case ApplicationPhase.DATABASE_READY: {
                    break;
                }
                case ApplicationPhase.COMPONENTS_READY: {
                    ApplicationLifecycle.setPhase(ApplicationPhase.SYSTEM_REGISTERING);
                    break;
                }
                case ApplicationPhase.SYSTEM_READY: {
                    try {
                        const schema = ServiceRegistry.getSchema();
                        if (schema) {
                            this.yoga = createYogaInstance(schema);
                        } else {
                            this.yoga = createYogaInstance();
                        }
                        ApplicationLifecycle.setPhase(ApplicationPhase.APPLICATION_READY);
                    } catch (error) {
                        logger.error("Error during SYSTEM_READY phase:");
                        logger.error(error);
                    }
                    break;
                }
                case ApplicationPhase.APPLICATION_READY: {
                    if(process.env.NODE_ENV !== "test") {
                        this.start();
                    }
                    break;
                }
            }
        });
    }

    waitForAppReady(): Promise<void> {
        return new Promise(resolve => {
            const interval = setInterval(() => {
                if (ApplicationLifecycle.getCurrentPhase() === ApplicationPhase.APPLICATION_READY) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
    }

    async start() {
        logger.info("Application Started");
        const server = Bun.serve({
            fetch: this.yoga
        });
        logger.info(`Server is running on ${new URL(this.yoga.graphqlEndpoint, `http://${server.hostname}:${server.port}`)}`)
    }
}