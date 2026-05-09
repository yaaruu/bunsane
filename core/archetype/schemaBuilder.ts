import type { BaseComponent } from "../components";
import type { ArcheTypeFieldOptions } from "../metadata/definitions/ArcheType";
import { z, ZodObject } from "zod";
import { asEnumType } from "@gqloom/zod";
import { getMetadataStorage } from "../metadata";
import { compNameToFieldName, primitiveTypes } from "./helpers";
import { customTypeRegistry } from "./customTypes";

// Component-level schema cache
export const componentSchemaCache = new Map<string, ZodObject<any>>();

// Enum schema cache to prevent duplicate registrations
export const enumSchemaCache = new Map<string, any>();

/**
 * Generate Zod schema for a component and cache it.
 */
export function getOrCreateComponentSchema(
    componentCtor: new (...args: any[]) => BaseComponent,
    componentId: string,
    fieldOptions?: ArcheTypeFieldOptions
): any | null {
    if (componentSchemaCache.has(componentId)) {
        return componentSchemaCache.get(componentId)!;
    }

    const storage = getMetadataStorage();
    const props = storage.getComponentProperties(componentId);

    if (props.length === 0) {
        return null;
    }

    const zodFields: Record<string, any> = {
        __typename: z
            .literal(compNameToFieldName(componentCtor.name))
            .nullish(),
    };

    for (const prop of props) {
        if (prop.isPrimitive) {
            switch (prop.propertyType) {
                case String:
                    zodFields[prop.propertyKey] = z.string();
                    break;
                case Number:
                    zodFields[prop.propertyKey] = z.number();
                    break;
                case Boolean:
                    zodFields[prop.propertyKey] = z.boolean();
                    break;
                case Date:
                    zodFields[prop.propertyKey] = z.date();
                    break;
                default:
                    console.warn(`[ArcheType] Unknown primitive type for ${componentCtor.name}.${prop.propertyKey}: ${prop.propertyType?.name}. Falling back to z.string()`);
                    zodFields[prop.propertyKey] = z.string();
            }
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        } else if (prop.isEnum && prop.enumValues && prop.enumKeys) {
            const enumTypeName =
                prop.propertyType?.name ||
                `${componentCtor.name}_${prop.propertyKey}_Enum`;

            let enumSchema = enumSchemaCache.get(enumTypeName);

            if (!enumSchema) {
                enumSchema = z
                    .enum(prop.enumValues as any)
                    .register(asEnumType, {
                        name: enumTypeName,
                        valuesConfig: prop.enumKeys.reduce(
                            (
                                acc: Record<string, { description: string }>,
                                key,
                                idx
                            ) => {
                                acc[key] = { description: prop.enumValues![idx]! };
                                return acc;
                            },
                            {}
                        ),
                    });
                enumSchemaCache.set(enumTypeName, enumSchema);
            }

            zodFields[prop.propertyKey] = enumSchema;
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        } else if (customTypeRegistry.has(prop.propertyType)) {
            zodFields[prop.propertyKey] = customTypeRegistry.get(
                prop.propertyType
            )!;
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        } else if (prop.arrayOf) {
            if (customTypeRegistry.has(prop.arrayOf)) {
                zodFields[prop.propertyKey] = z.array(customTypeRegistry.get(prop.arrayOf)!);
            } else if (primitiveTypes.includes(prop.arrayOf)) {
                if (prop.arrayOf === String) {
                    zodFields[prop.propertyKey] = z.array(z.string());
                } else if (prop.arrayOf === Number) {
                    zodFields[prop.propertyKey] = z.array(z.number());
                } else if (prop.arrayOf === Boolean) {
                    zodFields[prop.propertyKey] = z.array(z.boolean());
                } else if (prop.arrayOf === Date) {
                    zodFields[prop.propertyKey] = z.array(z.date());
                }
            } else {
                console.warn(`[ArcheType] Unknown array element type for ${componentCtor.name}.${prop.propertyKey}: ${prop.arrayOf?.name}. Falling back to z.array(z.string())`);
                zodFields[prop.propertyKey] = z.array(z.string());
            }
            if (prop.isOptional) {
                zodFields[prop.propertyKey] = zodFields[prop.propertyKey].optional();
            }
        } else {
            console.warn(`[ArcheType] Unknown type for ${componentCtor.name}.${prop.propertyKey}: ${prop.propertyType?.name}. Falling back to z.string()`);
            zodFields[prop.propertyKey] = z.string();
            if (prop.isOptional) {
                zodFields[prop.propertyKey] =
                    zodFields[prop.propertyKey].optional();
            }
        }

        if (fieldOptions?.nullable) {
            zodFields[prop.propertyKey] = zodFields[prop.propertyKey].nullish();
        }
    }

    const componentSchema = z.object(zodFields);
    componentSchemaCache.set(componentId, componentSchema);

    return componentSchema;
}
