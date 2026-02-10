import { z, type ZodType } from "zod";

// ─── Marker ────────────────────────────────────────────────────────────────────

export const SCHEMA_DSL_MARKER = Symbol.for("bunsane.schema_dsl");

// ─── Constraint Types ──────────────────────────────────────────────────────────

type Constraint =
    | { kind: "min"; value: number }
    | { kind: "max"; value: number }
    | { kind: "minLength"; value: number }
    | { kind: "maxLength"; value: number }
    | { kind: "email" }
    | { kind: "url" }
    | { kind: "uuid" }
    | { kind: "pattern"; value: RegExp };

// ─── SchemaType Interface ──────────────────────────────────────────────────────

export interface SchemaType<T = unknown> {
    readonly [SCHEMA_DSL_MARKER]: true;
    readonly _output: T;
    readonly _required: boolean;
    readonly _nullable: boolean;
    readonly _graphqlType: string;
    required(): this;
    optional(): this;
    nullable(): this;
    toGraphQL(): string;
    toZod(): ZodType;
}

// ─── Inference Utilities ───────────────────────────────────────────────────────

export type InferField<T extends SchemaType> =
    T extends { _required: true } ? T["_output"] : T["_output"] | undefined;

export type InferInput<T extends Record<string, SchemaType>> = {
    [K in keyof T as T[K] extends { _required: true } ? K : never]: T[K]["_output"];
} & {
    [K in keyof T as T[K] extends { _required: true } ? never : K]?: T[K]["_output"];
};

// ─── Base Abstract Class ───────────────────────────────────────────────────────

export abstract class BaseSchemaType<T = unknown> implements SchemaType<T> {
    readonly [SCHEMA_DSL_MARKER] = true as const;
    declare readonly _output: T;
    _required: boolean = false;
    _nullable: boolean = false;
    protected _internalGraphqlType: string = "";
    protected _constraints: Constraint[] = [];

    get _graphqlType(): string {
        return this._internalGraphqlType;
    }

    set _graphqlType(value: string) {
        this._internalGraphqlType = value;
    }

    required(): this {
        this._required = true;
        return this;
    }

    optional(): this {
        this._required = false;
        return this;
    }

    nullable(): this {
        this._nullable = true;
        return this;
    }

    toGraphQL(): string {
        return this._required ? `${this._graphqlType}!` : this._graphqlType;
    }

    abstract toZod(): ZodType;

    protected wrapZod(schema: ZodType): ZodType {
        let result = schema;
        if (this._nullable) {
            result = result.nullable();
        }
        if (!this._required) {
            result = result.optional();
        }
        return result;
    }
}

// ─── Scalar Builders ───────────────────────────────────────────────────────────

class StringType extends BaseSchemaType<string> {
    override _internalGraphqlType = "String";

    minLength(value: number): this {
        this._constraints.push({ kind: "minLength", value });
        return this;
    }

    maxLength(value: number): this {
        this._constraints.push({ kind: "maxLength", value });
        return this;
    }

    email(): this {
        this._constraints.push({ kind: "email" });
        return this;
    }

    url(): this {
        this._constraints.push({ kind: "url" });
        return this;
    }

    uuid(): this {
        this._constraints.push({ kind: "uuid" });
        return this;
    }

    pattern(regex: RegExp): this {
        this._constraints.push({ kind: "pattern", value: regex });
        return this;
    }

    toZod(): ZodType {
        let schema = z.string();
        for (const c of this._constraints) {
            switch (c.kind) {
                case "minLength":
                    schema = schema.min(c.value);
                    break;
                case "maxLength":
                    schema = schema.max(c.value);
                    break;
                case "email":
                    schema = schema.email();
                    break;
                case "url":
                    schema = schema.url();
                    break;
                case "uuid":
                    schema = schema.uuid();
                    break;
                case "pattern":
                    schema = schema.regex(c.value);
                    break;
            }
        }
        return this.wrapZod(schema);
    }
}

class IntType extends BaseSchemaType<number> {
    override _internalGraphqlType = "Int";

    min(value: number): this {
        this._constraints.push({ kind: "min", value });
        return this;
    }

    max(value: number): this {
        this._constraints.push({ kind: "max", value });
        return this;
    }

    toZod(): ZodType {
        let schema = z.int();
        for (const c of this._constraints) {
            switch (c.kind) {
                case "min":
                    schema = schema.min(c.value);
                    break;
                case "max":
                    schema = schema.max(c.value);
                    break;
            }
        }
        return this.wrapZod(schema);
    }
}

class FloatType extends BaseSchemaType<number> {
    override _internalGraphqlType = "Float";

    min(value: number): this {
        this._constraints.push({ kind: "min", value });
        return this;
    }

    max(value: number): this {
        this._constraints.push({ kind: "max", value });
        return this;
    }

    toZod(): ZodType {
        let schema = z.number();
        for (const c of this._constraints) {
            switch (c.kind) {
                case "min":
                    schema = schema.min(c.value);
                    break;
                case "max":
                    schema = schema.max(c.value);
                    break;
            }
        }
        return this.wrapZod(schema);
    }
}

class BooleanType extends BaseSchemaType<boolean> {
    override _internalGraphqlType = "Boolean";

    toZod(): ZodType {
        return this.wrapZod(z.boolean());
    }
}

class IDType extends BaseSchemaType<string> {
    override _internalGraphqlType = "ID";

    toZod(): ZodType {
        return this.wrapZod(z.string());
    }
}

// ─── Composite Builders ────────────────────────────────────────────────────────

export class RefType<T = unknown> extends BaseSchemaType<T> {
    private readonly _zodSchema: ZodType;

    constructor(graphqlTypeName: string, zodSchema?: ZodType) {
        super();
        this._internalGraphqlType = graphqlTypeName;
        this._zodSchema = zodSchema ?? z.any();
    }

    toZod(): ZodType {
        return this.wrapZod(this._zodSchema);
    }
}

export class ObjectType<T extends Record<string, SchemaType> = Record<string, SchemaType>> extends BaseSchemaType<{
    [K in keyof T]: InferField<T[K]>;
}> {
    readonly shape: T;
    private readonly _typeName: string;

    constructor(shape: T, typeName: string) {
        super();
        this.shape = shape;
        this._typeName = typeName;
    }

    override get _graphqlType(): string {
        return this._typeName;
    }

    override set _graphqlType(_v: string) {
        // no-op: type name is set via constructor
    }

    toGraphQLTypeDef(): string {
        const fields = Object.entries(this.shape)
            .map(([name, field]) => `    ${name}: ${field.toGraphQL()}`)
            .join("\n");
        return `input ${this._typeName} {\n${fields}\n}`;
    }

    toZod(): ZodType {
        const shape: Record<string, ZodType> = {};
        for (const [key, field] of Object.entries(this.shape)) {
            shape[key] = field.toZod();
        }
        return this.wrapZod(z.object(shape));
    }
}

export class ListType<T extends SchemaType = SchemaType> extends BaseSchemaType<T["_output"][]> {
    readonly element: T;

    constructor(element: T) {
        super();
        this.element = element;
    }

    override get _graphqlType(): string {
        return `[${this.element.toGraphQL()}]`;
    }

    override set _graphqlType(_v: string) {
        // no-op: type is derived from element
    }

    minItems(value: number): this {
        this._constraints.push({ kind: "min", value });
        return this;
    }

    maxItems(value: number): this {
        this._constraints.push({ kind: "max", value });
        return this;
    }

    toZod(): ZodType {
        let schema = z.array(this.element.toZod());
        for (const c of this._constraints) {
            switch (c.kind) {
                case "min":
                    schema = schema.min(c.value);
                    break;
                case "max":
                    schema = schema.max(c.value);
                    break;
            }
        }
        return this.wrapZod(schema);
    }
}

export class EnumType<T extends readonly string[] = readonly string[]> extends BaseSchemaType<T[number]> {
    readonly values: T;
    private readonly _enumName: string;

    constructor(values: T, enumName: string) {
        super();
        this.values = values;
        this._enumName = enumName;
    }

    override get _graphqlType(): string {
        return this._enumName;
    }

    override set _graphqlType(_v: string) {
        // no-op: type name is set via constructor
    }

    toGraphQLTypeDef(): string {
        const entries = this.values.join("\n    ");
        return `enum ${this._enumName} {\n    ${entries}\n}`;
    }

    toZod(): ZodType {
        return this.wrapZod(z.enum(this.values as unknown as readonly [string, ...string[]]));
    }
}

// ─── Nested Type Definition Collector ──────────────────────────────────────────

export function collectNestedTypeDefs(
    shape: Record<string, SchemaType>,
): Map<string, string> {
    const defs = new Map<string, string>();

    for (const field of Object.values(shape)) {
        collectFromField(field, defs);
    }

    return defs;
}

function collectFromField(field: SchemaType, defs: Map<string, string>): void {
    if (field instanceof ObjectType) {
        // Depth-first: recurse into nested shape first (dependencies before dependents)
        for (const nested of Object.values(field.shape) as SchemaType[]) {
            collectFromField(nested, defs);
        }
        if (!defs.has(field._graphqlType)) {
            defs.set(field._graphqlType, field.toGraphQLTypeDef());
        }
    } else if (field instanceof ListType) {
        collectFromField(field.element, defs);
    } else if (field instanceof EnumType) {
        if (!defs.has(field._graphqlType)) {
            defs.set(field._graphqlType, field.toGraphQLTypeDef());
        }
    }
}

// ─── Detection Utilities ───────────────────────────────────────────────────────

export function isSchemaType(value: unknown): value is SchemaType {
    return (
        typeof value === "object" &&
        value !== null &&
        SCHEMA_DSL_MARKER in value &&
        (value as Record<symbol, unknown>)[SCHEMA_DSL_MARKER] === true
    );
}

export function isSchemaInput(
    input: unknown,
): input is Record<string, SchemaType> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
    if ("_def" in input) return false;
    const entries = Object.values(input);
    return entries.length > 0 && entries.every(isSchemaType);
}

// ─── Validation ─────────────────────────────────────────────────────────────────

export class SchemaValidationError extends Error {
    readonly fieldErrors: Array<{ path: string; message: string }>;

    constructor(operationName: string, fieldErrors: Array<{ path: string; message: string }>) {
        const details = fieldErrors
            .map(e => `  ${operationName}.${e.path}: ${e.message}`)
            .join("\n");
        super(`Validation failed for ${operationName}:\n${details}`);
        this.name = "SchemaValidationError";
        this.fieldErrors = fieldErrors;
    }
}

export function validateInput<T extends Record<string, SchemaType>>(
    schema: T,
    data: unknown,
    operationName: string = "input",
): InferInput<T> {
    const zodShape: Record<string, ZodType> = {};
    for (const [key, field] of Object.entries(schema)) {
        zodShape[key] = field.toZod();
    }
    const result = z.object(zodShape).safeParse(data);
    if (result.success) {
        return result.data as InferInput<T>;
    }

    const fieldErrors = result.error.issues.map(issue => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
    }));
    throw new SchemaValidationError(operationName, fieldErrors);
}

// ─── Public API ────────────────────────────────────────────────────────────────

export const t = {
    string: () => new StringType(),
    int: () => new IntType(),
    float: () => new FloatType(),
    boolean: () => new BooleanType(),
    id: () => new IDType(),
    object: <T extends Record<string, SchemaType>>(shape: T, name: string) =>
        new ObjectType(shape, name),
    list: <T extends SchemaType>(element: T) => new ListType(element),
    enum: <T extends readonly string[]>(values: T, name: string) =>
        new EnumType(values, name),
    ref: <T = unknown>(typeName: string, zodSchema?: ZodType) =>
        new RefType<T>(typeName, zodSchema),
} as const;
