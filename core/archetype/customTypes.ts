import { z, ZodObject } from "zod";
import { asObjectType } from "@gqloom/zod";

export const customTypeRegistry = new Map<any, any>();
export const customTypeNameRegistry = new Map<any, string>();
export const registeredCustomTypes = new Map<string, any>();
export const customTypeSilks = new Map<string, any>();
export const customTypeResolvers: any[] = [];
export const inputTypeRegistry = new Map<any, string>();

// Structural signature registry for input type deduplication
// Maps structural signature -> registered input type name
export const structuralSignatureRegistry = new Map<string, string>();

let _generateZodStructuralSignature: ((schema: any) => string) | null = null;

function getSignatureGenerator(): (schema: any) => string {
    if (!_generateZodStructuralSignature) {
        const { generateZodStructuralSignature } = require('../../gql/utils/TypeSignature');
        _generateZodStructuralSignature = generateZodStructuralSignature;
    }
    return _generateZodStructuralSignature!;
}

export function registerCustomZodType(
    type: any,
    schema: any,
    typeName?: string,
    inputTypeName?: string
) {
    if (typeName && schema instanceof ZodObject) {
        const shape = schema.shape;
        const namedSchema = z.object({
            __typename: z.literal(typeName).nullish(),
            ...shape,
        });
        customTypeRegistry.set(type, namedSchema);
        if (typeName) {
            customTypeNameRegistry.set(type, typeName);
            registeredCustomTypes.set(typeName, namedSchema);
        }

        if (inputTypeName) {
            const inputSchema = z.object(shape).register(asObjectType, { name: inputTypeName });
            registeredCustomTypes.set(inputTypeName, inputSchema);
            inputTypeRegistry.set(type, inputTypeName);

            try {
                const generateSignature = getSignatureGenerator();
                const signature = generateSignature(z.object(shape));
                structuralSignatureRegistry.set(signature, inputTypeName);
            } catch (e) {
                // Signature registration is optional, don't fail if it errors
            }
        }
    } else {
        customTypeRegistry.set(type, schema);
        if (typeName) {
            customTypeNameRegistry.set(type, typeName);
            registeredCustomTypes.set(typeName, schema);
        }

        if (inputTypeName && schema instanceof ZodObject) {
            const inputSchema = schema.register(asObjectType, { name: inputTypeName });
            registeredCustomTypes.set(inputTypeName, inputSchema);
            inputTypeRegistry.set(type, inputTypeName);

            try {
                const generateSignature = getSignatureGenerator();
                const signature = generateSignature(schema);
                structuralSignatureRegistry.set(signature, inputTypeName);
            } catch (e) {
                // Signature registration is optional, don't fail if it errors
            }
        }
    }
}

export function getRegisteredCustomTypes() {
    return registeredCustomTypes;
}

/**
 * Find a matching registered input type for a given Zod schema based on structural equivalence.
 */
export function findMatchingInputType(schema: any): string | null {
    if (!schema) return null;

    try {
        const generateSignature = getSignatureGenerator();
        const signature = generateSignature(schema);
        return structuralSignatureRegistry.get(signature) || null;
    } catch (e) {
        return null;
    }
}

export function getStructuralSignatureRegistry(): Map<string, string> {
    return structuralSignatureRegistry;
}
