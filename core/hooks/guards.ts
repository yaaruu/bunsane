import type { BaseComponent } from "../components";
import type ArcheType from "../ArcheType";
import type { LifecycleEvent } from "../events/EntityLifecycleEvents";
import type { CompiledComponentTarget, ComponentTargetConfig } from "./registry";
import { compileComponentTarget, typeIdOfCtor } from "./registry";

/**
 * Check if an event matches a component target compiled at registration.
 * Does not allocate type-id sets for the hook's filters — those live on `compiled`.
 */
export function matchesCompiledTarget(event: LifecycleEvent, compiled?: CompiledComponentTarget): boolean {
    if (!compiled) return true;

    const entityComponents = event.getEntity().componentList();
    const entityTypes = new Set<string>();
    for (const comp of entityComponents) {
        entityTypes.add(comp.getTypeID());
    }

    if (compiled.hasArchetype) {
        if (!compiled.archetypeTypeIds || !typeSetCovers(entityTypes, compiled.archetypeTypeIds, compiled.allowExtra)) {
            return false;
        }
    }

    if (compiled.archetypesTypeIds) {
        let any = false;
        for (const expected of compiled.archetypesTypeIds) {
            if (expected && typeSetCovers(entityTypes, expected, compiled.allowExtra)) {
                any = true;
                break;
            }
        }
        if (!any) return false;
    }

    if (compiled.includeTypeIds) {
        if (compiled.requireAllIncluded) {
            for (const typeId of compiled.includeTypeIds) {
                if (!entityTypes.has(typeId)) return false;
            }
        } else {
            let any = false;
            for (const typeId of compiled.includeTypeIds) {
                if (entityTypes.has(typeId)) {
                    any = true;
                    break;
                }
            }
            if (!any) return false;
        }
    }

    if (compiled.excludeTypeIds) {
        if (compiled.requireAllExcluded) {
            for (const typeId of compiled.excludeTypeIds) {
                if (entityTypes.has(typeId)) return false;
            }
        } else {
            let anyAbsent = false;
            for (const typeId of compiled.excludeTypeIds) {
                if (!entityTypes.has(typeId)) {
                    anyAbsent = true;
                    break;
                }
            }
            if (!anyAbsent) return false;
        }
    }

    return true;
}

/**
 * Exact match, or "expected ⊆ entity" when extra components are allowed.
 */
function typeSetCovers(entityTypes: Set<string>, expected: ReadonlySet<string>, allowExtra: boolean): boolean {
    if (!allowExtra && expected.size !== entityTypes.size) return false;
    for (const typeId of expected) {
        if (!entityTypes.has(typeId)) return false;
    }
    return true;
}

/**
 * Check if an event matches the component targeting configuration.
 * Prefer {@link matchesCompiledTarget} on the dispatch path — this compiles on the call.
 */
export function matchesComponentTarget(event: LifecycleEvent, componentTarget?: ComponentTargetConfig): boolean {
    if (!componentTarget) return true;
    return matchesCompiledTarget(event, compileComponentTarget(componentTarget));
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
        return requiredTypeIds.every(typeId => entityComponentTypes.has(typeId));
    }
    return requiredTypeIds.some(typeId => entityComponentTypes.has(typeId));
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
        return excludedTypeIds.every(typeId => !entityComponentTypes.has(typeId));
    }
    return excludedTypeIds.some(typeId => !entityComponentTypes.has(typeId));
}

/**
 * Check if entity components match a specific archetype
 */
export function matchesArchetype(entityComponents: BaseComponent[], archetype: ArcheType, allowExtraComponents: boolean = false): boolean {
    const archetypeComponentMap = archetype.componentMap;

    if (!archetypeComponentMap) {
        return false;
    }

    const expectedComponentTypes = new Set(
        Object.values(archetypeComponentMap).map(compCtor => typeIdOfCtor(compCtor as new () => BaseComponent))
    );

    const entityComponentTypes = new Set(
        entityComponents.map(comp => comp.getTypeID())
    );

    return typeSetCovers(entityComponentTypes, expectedComponentTypes, allowExtraComponents);
}
