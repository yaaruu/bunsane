/**
 * Finds the indicator component name from an archetype's field list.
 * The indicator is used to identify entities of this archetype type.
 * 
 * Priority order:
 * 1. {ArcheTypeName}Tag (e.g., UserTag)
 * 2. {ArcheTypeName}Id (e.g., UserId)
 * 3. Any field starting with {ArcheTypeName}
 * 4. Any field containing {ArcheTypeName}
 * 5. Fallback to first component
 */
export function findIndicatorComponentName(
    archeTypeName: string,
    fields: Array<{ componentName: string; fieldName: string }>
): string | null {
    if (fields.length === 0) {
        return null;
    }

    const archeTypeNameLower = archeTypeName.toLowerCase();
    const componentNames = fields.map(field => field.componentName);

    const tagComponentName = `${archeTypeName}Tag`;
    const tagMatch = componentNames.find(
        name => name.toLowerCase() === tagComponentName.toLowerCase()
    );
    if (tagMatch) {
        return tagMatch;
    }

    const idComponentName = `${archeTypeName}Id`;
    const idMatch = componentNames.find(
        name => name.toLowerCase() === idComponentName.toLowerCase()
    );
    if (idMatch) {
        return idMatch;
    }

    const startsWithMatch = componentNames.find(
        name => name.toLowerCase().startsWith(archeTypeNameLower)
    );
    if (startsWithMatch) {
        return startsWithMatch;
    }

    const containsMatch = componentNames.find(
        name => name.toLowerCase().includes(archeTypeNameLower)
    );
    if (containsMatch) {
        return containsMatch;
    }

    return componentNames[0] ?? null;
}
