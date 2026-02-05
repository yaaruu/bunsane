import type App from "../core/App";
import type { ApplicationPhase } from "../core/ApplicationLifecycle";

abstract class BasePlugin {
    name!: string;
    version!: string;

    abstract init?(app: App): Promise<void> | void;
    onPhaseChange?(phase: ApplicationPhase, app: App): Promise<void> | void;
    onComponentRegistered?(componentName: string, componentCtor: new () => any, app: App): void;
}

export default BasePlugin;