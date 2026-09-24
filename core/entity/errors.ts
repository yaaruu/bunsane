/**
 * A component read failed (pool, timeout, SQL, admission). Distinct from
 * "the row is not there" so callers do not cache an outage as absence.
 */
export class ComponentLoadError extends Error {
    readonly entityId: string;
    readonly componentName: string;
    override readonly cause: unknown;

    constructor(entityId: string, componentName: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Failed to load component ${componentName} for entity ${entityId}: ${detail}`);
        this.name = "ComponentLoadError";
        this.entityId = entityId;
        this.componentName = componentName;
        this.cause = cause;
    }
}

/**
 * getOrThrow confirmed the component is absent (zero rows / negative cache).
 * Not thrown for infrastructure failures — those are ComponentLoadError.
 */
export class ComponentMissingError extends Error {
    readonly entityId: string;
    readonly componentName: string;

    constructor(entityId: string, componentName: string) {
        super(`Entity ${entityId} is missing required component ${componentName}`);
        this.name = "ComponentMissingError";
        this.entityId = entityId;
        this.componentName = componentName;
    }
}
