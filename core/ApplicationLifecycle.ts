
export enum ApplicationPhase {
    DATABASE_INITIALIZING = "database_initializing",
    DATABASE_READY = "database_ready",
    COMPONENTS_REGISTERING = "components_registering",
    COMPONENTS_READY = "components_ready",
    SYSTEM_REGISTERING = "system_registering",
    SYSTEM_READY = "system_ready",
    APPLICATION_READY = "application_ready"
}

const PHASE_ORDER: Record<ApplicationPhase, number> = {
    [ApplicationPhase.DATABASE_INITIALIZING]: 0,
    [ApplicationPhase.DATABASE_READY]: 1,
    [ApplicationPhase.COMPONENTS_REGISTERING]: 2,
    [ApplicationPhase.COMPONENTS_READY]: 3,
    [ApplicationPhase.SYSTEM_REGISTERING]: 4,
    [ApplicationPhase.SYSTEM_READY]: 5,
    [ApplicationPhase.APPLICATION_READY]: 6,
};

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

    /**
     * Test helper: reset the current phase to the initial value. Paired with
     * `removeAllListeners()` when re-initializing the lifecycle in tests.
     * Monotonic phase enforcement would otherwise reject re-entering early
     * phases on a second App.init().
     */
    resetPhase() {
        this.currentPhase = ApplicationPhase.DATABASE_INITIALIZING;
    }

    setPhase(phase: ApplicationPhase) {
        // Phases are linear: refuse non-monotonic transitions to prevent
        // concurrent callers from clobbering each other's progress (H-LIFE-2).
        // Idempotent re-emits at the same phase are silently ignored.
        const currentRank = PHASE_ORDER[this.currentPhase];
        const nextRank = PHASE_ORDER[phase];
        if (nextRank === undefined) {
            throw new Error(`Unknown application phase: ${phase}`);
        }
        if (nextRank < currentRank) {
            throw new Error(
                `Non-monotonic phase transition rejected: ${this.currentPhase} → ${phase}`,
            );
        }
        if (nextRank === currentRank) {
            // Same phase — no-op, no re-dispatch
            return;
        }
        this.currentPhase = phase;
        this.eventEmitter.dispatchEvent(new CustomEvent("phaseChanged", { detail: phase }));
    }
    getCurrentPhase() {
        return this.currentPhase;
    }
}

export default ApplicationLifecycle.instance;