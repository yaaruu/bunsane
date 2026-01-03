import type { ZodType } from "zod";

/**
 * Generate a structural signature for a Zod schema to enable type matching.
 * The signature is based on field names and their types, sorted alphabetically.
 * This allows us to detect when two schemas are structurally equivalent,
 * even if they were created through different transformations (.omit(), .extend(), etc.)
 */
export function generateZodStructuralSignature(schema: ZodType | any): string {
    if (!schema || !schema._def) return 'unknown';

    const typeName = schema._def.typeName || schema._def.type;

    // Handle object types - the main case for input type matching
    if (typeName === 'ZodObject' || typeName === 'object') {
        let shape: Record<string, any> | undefined;
        
        try {
            shape = typeof schema._def.shape === 'function'
                ? schema._def.shape()
                : schema._def.shape;
        } catch {
            // If shape access fails, try alternative methods
            if (schema.shape && typeof schema.shape === 'object') {
                shape = schema.shape;
            }
        }

        if (!shape || Object.keys(shape).length === 0) {
            return 'object:{}';
        }

        // Sort keys for consistent hashing
        const fieldSignatures = Object.entries(shape)
            .filter(([key]) => key !== '__typename') // Exclude __typename from signature
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}:${generateZodStructuralSignature(value as ZodType)}`)
            .join(',');

        return `object:{${fieldSignatures}}`;
    }

    // Primitive types
    if (typeName === 'ZodNumber' || typeName === 'number') return 'number';
    if (typeName === 'ZodString' || typeName === 'string') return 'string';
    if (typeName === 'ZodBoolean' || typeName === 'boolean') return 'boolean';
    if (typeName === 'ZodDate' || typeName === 'date') return 'date';
    if (typeName === 'ZodAny' || typeName === 'any') return 'any';
    if (typeName === 'ZodUnknown' || typeName === 'unknown') return 'unknown';
    if (typeName === 'ZodVoid' || typeName === 'void') return 'void';
    if (typeName === 'ZodNull' || typeName === 'null') return 'null';
    if (typeName === 'ZodUndefined' || typeName === 'undefined') return 'undefined';
    if (typeName === 'ZodNaN' || typeName === 'nan') return 'nan';
    if (typeName === 'ZodBigInt' || typeName === 'bigint') return 'bigint';
    if (typeName === 'ZodSymbol' || typeName === 'symbol') return 'symbol';

    // Wrapper types - unwrap and include wrapper info
    if (typeName === 'ZodOptional' || typeName === 'optional') {
        const inner = generateZodStructuralSignature(schema._def.innerType);
        return `optional:${inner}`;
    }

    if (typeName === 'ZodNullable' || typeName === 'nullable') {
        const inner = generateZodStructuralSignature(schema._def.innerType);
        return `nullable:${inner}`;
    }

    if (typeName === 'ZodDefault' || typeName === 'default') {
        const inner = generateZodStructuralSignature(schema._def.innerType);
        return `default:${inner}`;
    }

    if (typeName === 'ZodEffects' || typeName === 'effects') {
        const inner = generateZodStructuralSignature(schema._def.schema);
        return `effects:${inner}`;
    }

    if (typeName === 'ZodReadonly' || typeName === 'readonly') {
        const inner = generateZodStructuralSignature(schema._def.innerType);
        return `readonly:${inner}`;
    }

    if (typeName === 'ZodBranded' || typeName === 'branded') {
        const inner = generateZodStructuralSignature(schema._def.type);
        return `branded:${inner}`;
    }

    if (typeName === 'ZodCatch' || typeName === 'catch') {
        const inner = generateZodStructuralSignature(schema._def.innerType);
        return `catch:${inner}`;
    }

    if (typeName === 'ZodPipeline' || typeName === 'pipeline') {
        const inner = generateZodStructuralSignature(schema._def.in);
        const outer = generateZodStructuralSignature(schema._def.out);
        return `pipeline:${inner}->${outer}`;
    }

    // Array type
    if (typeName === 'ZodArray' || typeName === 'array') {
        const elementType = schema._def.type;
        const elementSignature = generateZodStructuralSignature(elementType);
        return `array:${elementSignature}`;
    }

    // Tuple type
    if (typeName === 'ZodTuple' || typeName === 'tuple') {
        const items = schema._def.items || [];
        const itemSignatures = items.map((item: ZodType) => generateZodStructuralSignature(item)).join(',');
        const rest = schema._def.rest ? `,rest:${generateZodStructuralSignature(schema._def.rest)}` : '';
        return `tuple:[${itemSignatures}${rest}]`;
    }

    // Union type - sort options for consistent signature
    if (typeName === 'ZodUnion' || typeName === 'union') {
        const options = schema._def.options || [];
        const optionSignatures = options
            .map((opt: ZodType) => generateZodStructuralSignature(opt))
            .sort()
            .join('|');
        return `union:(${optionSignatures})`;
    }

    // Discriminated union - include discriminator key
    if (typeName === 'ZodDiscriminatedUnion' || typeName === 'discriminatedUnion') {
        const discriminator = schema._def.discriminator;
        const options = schema._def.options || [];
        const optionSignatures = options
            .map((opt: ZodType) => generateZodStructuralSignature(opt))
            .sort()
            .join('|');
        return `discUnion:${discriminator}:(${optionSignatures})`;
    }

    // Intersection type
    if (typeName === 'ZodIntersection' || typeName === 'intersection') {
        const left = generateZodStructuralSignature(schema._def.left);
        const right = generateZodStructuralSignature(schema._def.right);
        return `intersection:(${left}&${right})`;
    }

    // Literal type - include the literal value
    if (typeName === 'ZodLiteral' || typeName === 'literal') {
        const value = schema._def.value ?? (schema._def.values ? schema._def.values[0] : undefined);
        return `literal:${JSON.stringify(value)}`;
    }

    // Enum type
    if (typeName === 'ZodEnum' || typeName === 'enum') {
        const values = schema._def.values || [];
        return `enum:[${values.sort().join(',')}]`;
    }

    // Native enum type
    if (typeName === 'ZodNativeEnum' || typeName === 'nativeEnum') {
        const values = Object.values(schema._def.values || {}).sort();
        return `nativeEnum:[${values.join(',')}]`;
    }

    // Record type
    if (typeName === 'ZodRecord' || typeName === 'record') {
        const keyType = generateZodStructuralSignature(schema._def.keyType);
        const valueType = generateZodStructuralSignature(schema._def.valueType);
        return `record:<${keyType},${valueType}>`;
    }

    // Map type
    if (typeName === 'ZodMap' || typeName === 'map') {
        const keyType = generateZodStructuralSignature(schema._def.keyType);
        const valueType = generateZodStructuralSignature(schema._def.valueType);
        return `map:<${keyType},${valueType}>`;
    }

    // Set type
    if (typeName === 'ZodSet' || typeName === 'set') {
        const valueType = generateZodStructuralSignature(schema._def.valueType);
        return `set:<${valueType}>`;
    }

    // Promise type
    if (typeName === 'ZodPromise' || typeName === 'promise') {
        const inner = generateZodStructuralSignature(schema._def.type);
        return `promise:${inner}`;
    }

    // Function type
    if (typeName === 'ZodFunction' || typeName === 'function') {
        const args = generateZodStructuralSignature(schema._def.args);
        const returns = generateZodStructuralSignature(schema._def.returns);
        return `function:(${args})=>${returns}`;
    }

    // Lazy type - be careful with infinite recursion
    if (typeName === 'ZodLazy' || typeName === 'lazy') {
        // For lazy types, we can't fully resolve without risking infinite recursion
        // Use a placeholder that indicates it's a lazy type
        return 'lazy:deferred';
    }

    // Fallback for unknown types
    return typeName || 'unknown';
}

/**
 * Normalize a signature for comparison.
 * Currently just returns the signature as-is, but can be extended
 * to handle canonicalization if needed.
 */
export function normalizeSignature(signature: string): string {
    return signature;
}

/**
 * Compare two schemas for structural equivalence.
 */
export function areStructurallyEquivalent(schema1: ZodType, schema2: ZodType): boolean {
    const sig1 = normalizeSignature(generateZodStructuralSignature(schema1));
    const sig2 = normalizeSignature(generateZodStructuralSignature(schema2));
    return sig1 === sig2;
}
