import { z, type ZodType } from "zod";

export interface ArchetypeFunctionArg {
    name: string;
    type: unknown;
    nullable?: boolean;
}

export interface ArchetypeFunctionOptions {
    returnType?: string;
    args?: ArchetypeFunctionArg[];
    /** Collect parents in the request and call the method once. */
    batch?: boolean;
}

const SCALAR_RETURN: Record<string, () => ZodType> = {
    string: () => z.string(),
    number: () => z.number(),
    boolean: () => z.boolean(),
    date: () => z.date(),
    Date: () => z.date(),
};

function designName(designReturn: unknown): string {
    if (typeof designReturn === "function" && designReturn.name) return designReturn.name;
    return "unknown";
}

/**
 * Zod output for an @ArcheTypeFunction field. Missing returnType on a method
 * whose design:returntype is Promise or Object throws — those used to become
 * z.any() and an unusable GraphQL field. A custom returnType string is not
 * resolved here; the weaver maps it to a real GraphQL type.
 */
export function functionOutputZod(
    archetypeName: string,
    propertyKey: string,
    options: ArchetypeFunctionOptions | undefined,
    designReturn: unknown
): ZodType {
    const named = options?.returnType;
    if (named) {
        const scalar = SCALAR_RETURN[named];
        if (scalar) return scalar().nullish();
        return z.any().nullish();
    }
    if (designReturn === String) return z.string().nullish();
    if (designReturn === Number) return z.number().nullish();
    if (designReturn === Boolean) return z.boolean().nullish();
    if (designReturn === Date) return z.date().nullish();
    if (designReturn === Promise || designReturn === Object) {
        throw new Error(
            `@ArcheTypeFunction ${archetypeName}.${propertyKey} is missing returnType ` +
            `(design:returntype is ${designName(designReturn)}). ` +
            `Pass { returnType: "string" | "number" | "boolean" | "Date" | "ArchetypeName" }.`
        );
    }
    throw new Error(
        `@ArcheTypeFunction ${archetypeName}.${propertyKey} is missing returnType ` +
        `(design:returntype is ${designName(designReturn)}). ` +
        `Pass { returnType } instead of emitting an untyped field.`
    );
}

/** True when a missing batch value may be null instead of a field error. */
export function functionOutputAllowsNull(schema: ZodType): boolean {
    return schema.safeParse(null).success || schema.safeParse(undefined).success;
}

/**
 * Missing Map key. Nullable function fields (sdlEmit / functionOutputZod are
 * nullish) resolve null; a non-null field fails that parent.
 */
export function rejectBatchMiss(
    allowsNull: boolean,
    archetypeName: string,
    propertyKey: string,
    entityId: string,
): null | Error {
    if (allowsNull) return null;
    return new Error(
        `@ArcheTypeFunction ${archetypeName}.${propertyKey} is non-null but the batch result has no value for ${entityId}`
    );
}
