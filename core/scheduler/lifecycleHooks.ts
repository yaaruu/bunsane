import ApplicationLifecycle, { ApplicationPhase } from "../ApplicationLifecycle";
import type { SchedulerManager } from "../SchedulerManager";

export function initializeLifecycleIntegration(manager: SchedulerManager): void {
    manager.phaseListener = (event) => {
        const phase = event.detail;
        if (phase === ApplicationPhase.APPLICATION_READY) {
            if (manager.config.runOnStart) {
                manager.start();
            }
        }
    };
    ApplicationLifecycle.addPhaseListener(manager.phaseListener);
}

export function disposeLifecycleIntegration(manager: SchedulerManager): void {
    if (manager.phaseListener) {
        ApplicationLifecycle.removePhaseListener(manager.phaseListener);
        manager.phaseListener = null;
    }
}
