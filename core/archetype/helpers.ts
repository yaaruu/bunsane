import type { ComponentPropertyMetadata } from "../metadata/definitions/Component";

export const primitiveTypes = [String, Number, Boolean, Date];

export function compNameToFieldName(compName: string): string {
    return (
        compName.charAt(0).toLowerCase() +
        compName.slice(1).replace(/Component$/, "Component")
    );
}

/**
 * Helper to determine if a component should be unwrapped to a scalar value.
 * Returns true if the component has a single 'value' property and the field type is primitive.
 */
export function shouldUnwrapComponent(
    componentProps: ComponentPropertyMetadata[],
    fieldType: any
): boolean {
    if (
        fieldType === String ||
        fieldType === Number ||
        fieldType === Boolean ||
        fieldType === Date
    ) {
        return true;
    }
    return false;
}
