
export enum ApplicationPhase {
    DATABASE_INITIALIZING = "database_initializing",
    DATABASE_READY = "database_ready",
    COMPONENTS_REGISTERING = "components_registering",
    COMPONENTS_READY = "components_ready",
    SYSTEM_REGISTERING = "system_registering",
    SYSTEM_READY = "system_ready",
    APPLICATION_READY = "application_ready"
}

export interface PhaseChangeEvent extends CustomEvent {
    detail: ApplicationPhase;
}


class ApplicationLifecycle {
    static #instance : ApplicationLifecycle;
    constructor() {
    }

    public static get instance(): ApplicationLifecycle {
        if(ApplicationLifecycle.#instance === undefined) {
            ApplicationLifecycle.#instance = new ApplicationLifecycle();
        }
        return ApplicationLifecycle.#instance;
    }

    private eventEmitter = new EventTarget();
    private currentPhase = ApplicationPhase.DATABASE_INITIALIZING;


    async waitForPhase(phase: ApplicationPhase): Promise<void> {
        while (this.currentPhase !== phase) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    addPhaseListener(listener: (event: PhaseChangeEvent) => void) {
        this.eventEmitter.addEventListener("phaseChanged", listener as EventListener);
        return listener;
    }

    removePhaseListener(listener: (event: PhaseChangeEvent) => void) {
        this.eventEmitter.removeEventListener("phaseChanged", listener as EventListener);
    }

    setPhase(phase: ApplicationPhase) {
        this.currentPhase = phase;
        this.eventEmitter.dispatchEvent(new CustomEvent("phaseChanged", { detail: phase }));
    }
    getCurrentPhase() {
        return this.currentPhase;
    }
}

export default ApplicationLifecycle.instance;