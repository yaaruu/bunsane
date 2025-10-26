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