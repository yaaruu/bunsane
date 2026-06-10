import type { BaseComponent } from "../components";
import type ArcheType from "../ArcheType";
import type { LifecycleEvent } from "../events/EntityLifecycleEvents";
import type { ComponentTargetConfig } from "./registry";
import { typeIdOfCtor } from "./registry";

/**
 * Check if an event matches the component targeting configuration
 */
export function matchesComponentTarget(event: LifecycleEvent, componentTarget?: ComponentTargetConfig): boolean {
    // If no component targeting is specified, always match
    if (!componentTarget) {
        return true;
    }

    const entity = event.getEntity();
    const entityComponents = entity.componentList();

    // Check archetype matching first (most specific)
    if (componentTarget.archetype) {
        if (!matchesArchetype(entityComponents, componentTarget.archetype, !!(componentTarget.includeComponents?.length || componentTarget.excludeComponents?.length))) {
            return false;
        }
    }

    // Check multiple archetypes (OR logic)
    if (componentTarget.archetypes && componentTarget.archetypes.length > 0) {
        const allowExtra = !!(componentTarget.includeComponents?.length || componentTarget.excludeComponents?.length);
        const matchesAnyArchetype = componentTarget.archetypes.some(archetype =>
            matchesArchetype(entityComponents, archetype, allowExtra)
        );
        if (!matchesAnyArchetype) {
            return false;
        }
    }

    // Check included components
    if (componentTarget.includeComponents && componentTarget.includeComponents.length > 0) {
        const includeMatch = checkComponentPresence(
            entityComponents,
            componentTarget.includeComponents,
            componentTarget.requireAllIncluded ?? true
        );

        if (!includeMatch) {
            return false;
        }
    }

    // Check excluded components
    if (componentTarget.excludeComponents && componentTarget.excludeComponents.length > 0) {
        const excludeMatch = checkComponentAbsence(
            entityComponents,
            componentTarget.excludeComponents,
            componentTarget.requireAllExcluded ?? true
        );

        if (!excludeMatch) {
            return false;
        }
    }

    return true;
}

/**
 * Check if required components are present on the entity
 */
export function checkComponentPresence(
    entityComponents: BaseComponent[],
    requiredComponents: (new () => BaseComponent)[],
    requireAll: boolean
): boolean {
    const entityComponentTypes = new Set(
        entityComponents.map(comp => comp.getTypeID())
    );

    const requiredTypeIds = requiredComponents.map(typeIdOfCtor);

    if (requireAll) {
        // ALL required components must be present (AND logic)
        return requiredTypeIds.every(typeId => entityComponentTypes.has(typeId));
    } else {
        // ANY required component must be present (OR logic)
        return requiredTypeIds.some(typeId => entityComponentTypes.has(typeId));
    }
}

/**
 * Check if excluded components are absent from the entity
 */
export function checkComponentAbsence(
    entityComponents: BaseComponent[],
    excludedComponents: (new () => BaseComponent)[],
    requireAll: boolean
): boolean {
    const entityComponentTypes = new Set(
        entityComponents.map(comp => comp.getTypeID())
    );

    const excludedTypeIds = excludedComponents.map(typeIdOfCtor);

    if (requireAll) {
        // ALL excluded components must be absent (AND logic)
        return excludedTypeIds.every(typeId => !entityComponentTypes.has(typeId));
    } else {
        // ANY excluded component must be absent (OR logic) - this is less common but supported
        return excludedTypeIds.some(typeId => !entityComponentTypes.has(typeId));
    }
}

/**
 * Check if entity components match a specific archetype
 */
export function matchesArchetype(entityComponents: BaseComponent[], archetype: ArcheType, allowExtraComponents: boolean = false): boolean {
    // Get the expected component types from the archetype
    // We need to access the private componentMap from ArcheType
    const archetypeComponentMap = (archetype as any).componentMap as Record<string, typeof BaseComponent>;

    if (!archetypeComponentMap) {
        return false;
    }

    const expectedComponentTypes = new Set(
        Object.values(archetypeComponentMap).map(compCtor => typeIdOfCtor(compCtor as any))
    );

    const entityComponentTypes = new Set(
        entityComponents.map(comp => comp.getTypeID())
    );

    if (allowExtraComponents) {
        // Entity must have at least all the component types from the archetype
        // (allows additional components beyond the archetype)
        for (const expectedType of expectedComponentTypes) {
            if (!entityComponentTypes.has(expectedType)) {
                return false;
            }
        }
        return true;
    } else {
        // Entity must have exactly the same component types as the archetype
        if (expectedComponentTypes.size !== entityComponentTypes.size) {
            return false;
        }

        // All expected component types must be present in the entity
        for (const expectedType of expectedComponentTypes) {
            if (!entityComponentTypes.has(expectedType)) {
                return false;
            }
        }
        return true;
    }
}
