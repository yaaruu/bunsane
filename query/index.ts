export { QueryContext } from "./QueryContext";
export { QueryNode, type QueryResult } from "./QueryNode";
export { SourceNode } from "./SourceNode";
export { ComponentInclusionNode } from "./ComponentInclusionNode";
export { QueryDAG } from "./QueryDAG";
export { OrQuery } from "./OrQuery";
export { OrNode } from "./OrNode";
export { Query, or } from "./Query";

export type FilterSchema<T = any> = {
    [K in keyof T]?: {
        field: string;
        op: string;
        value: string;
    } | undefined;
}

// Custom Filter Builder exports
export type { FilterBuilder, FilterResult, FilterBuilderOptions } from "./FilterBuilder";
export { buildJSONPath, buildJSONBPath } from "./FilterBuilder";
export { FilterBuilderRegistry } from "./FilterBuilderRegistry";

// JSONB Array Builder exports
export {
    jsonbContainsBuilder,
    jsonbContainedByBuilder,
    jsonbHasAnyBuilder,
    jsonbHasAllBuilder,
    jsonbArrayOptions,
    JSONB_ARRAY_OPS,
} from "./builders/JsonbArrayBuilder";

// Auto-register JSONB array builders (core framework feature)
import { FilterBuilderRegistry } from "./FilterBuilderRegistry";
import {
    jsonbContainsBuilder,
    jsonbContainedByBuilder,
    jsonbHasAnyBuilder,
    jsonbHasAllBuilder,
    jsonbArrayOptions,
    JSONB_ARRAY_OPS,
} from "./builders/JsonbArrayBuilder";

FilterBuilderRegistry.register(JSONB_ARRAY_OPS.CONTAINS, jsonbContainsBuilder, jsonbArrayOptions, "bunsane-jsonb-array", "1.0.0");
FilterBuilderRegistry.register(JSONB_ARRAY_OPS.CONTAINED_BY, jsonbContainedByBuilder, jsonbArrayOptions, "bunsane-jsonb-array", "1.0.0");
FilterBuilderRegistry.register(JSONB_ARRAY_OPS.HAS_ANY, jsonbHasAnyBuilder, jsonbArrayOptions, "bunsane-jsonb-array", "1.0.0");
FilterBuilderRegistry.register(JSONB_ARRAY_OPS.HAS_ALL, jsonbHasAllBuilder, jsonbArrayOptions, "bunsane-jsonb-array", "1.0.0");