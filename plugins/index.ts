import type App from "core/App";
import type { ApplicationPhase } from "core/ApplicationLifecycle";

abstract class BasePlugin {
    name!: string;
    version!: string;

    abstract init?(app: App): Promise<void> | void;
    abstract onPhaseChange(phase: ApplicationPhase, app: App): Promise<void> | void;
}

export default BasePlugin;