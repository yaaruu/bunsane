
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


    /**
     * Wait for the lifecycle to reach the given phase. Resolves immediately if
     * already at that phase; otherwise attaches a one-shot listener that
     * resolves when the phase is reached. Bounded by `timeoutMs` so callers
     * cannot hang forever when a phase transition fails silently.
     */
    async waitForPhase(phase: ApplicationPhase, timeoutMs = 30_000): Promise<void> {
        if (this.currentPhase === phase) return;
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.eventEmitter.removeEventListener("phaseChanged", onPhase as EventListener);
                reject(new Error(`waitForPhase(${phase}) timed out after ${timeoutMs}ms; current=${this.currentPhase}`));
            }, timeoutMs);
            timer.unref?.();
            const onPhase = (event: PhaseChangeEvent) => {
                if (event.detail === phase) {
                    clearTimeout(timer);
                    this.eventEmitter.removeEventListener("phaseChanged", onPhase as EventListener);
                    resolve();
                }
            };
            this.eventEmitter.addEventListener("phaseChanged", onPhase as EventListener);
        });
    }

    addPhaseListener(listener: (event: PhaseChangeEvent) => void) {
        this.eventEmitter.addEventListener("phaseChanged", listener as EventListener);
        return listener;
    }

    removePhaseListener(listener: (event: PhaseChangeEvent) => void) {
        this.eventEmitter.removeEventListener("phaseChanged", listener as EventListener);
    }

    /**
     * Test / shutdown helper: remove all phase listeners. Call before
     * recreating singletons in tests to prevent listener stacking.
     */
    removeAllListeners() {
        this.eventEmitter = new EventTarget();
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