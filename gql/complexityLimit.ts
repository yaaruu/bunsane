import {
    type ArgumentNode,
    type DocumentNode,
    type FragmentDefinitionNode,
    type OperationDefinitionNode,
    type SelectionNode,
    type ValidationContext,
    type ValueNode,
    GraphQLError,
    Kind,
    type GraphQLSchema,
    getVariableValues,
} from "graphql";
import type { Plugin } from "graphql-yoga";

/**
 * Per-field cost is 1, multiplied by `first` / `limit` / `take` when that
 * argument is an Int literal or a coerced variable. Fragment spreads are
 * charged fully on the first use and at {@link FRAGMENT_REPEAT_COST} after
 * that; a fragment that spreads itself is not re-entered. `__` fields are
 * not exempt — each costs {@link INTROSPECTION_FIELD_COST}. Aliased fields
 * are capped separately from the complexity budget.
 */
export const FRAGMENT_REPEAT_COST = 1;
export const INTROSPECTION_FIELD_COST = 10;
export const GRAPHQL_ALIAS_CAP = 50;
const MULTIPLIER_ARGS: Record<string, true> = { first: true, limit: true, take: true };

export interface ComplexityAnalysis {
    complexity: number;
    aliases: number;
}

function readNumeric(value: ValueNode, variableValues: Record<string, unknown> | null | undefined): number | null {
    if (value.kind === Kind.INT) {
        const n = parseInt(value.value, 10);
        return Number.isFinite(n) ? n : null;
    }
    if (value.kind === Kind.VARIABLE) {
        const raw = variableValues?.[value.name.value];
        if (typeof raw === "number" && Number.isFinite(raw)) return raw;
        if (typeof raw === "string" && /^-?\d+$/.test(raw)) return parseInt(raw, 10);
        return null;
    }
    return null;
}

function readMultiplier(
    args: readonly ArgumentNode[] | undefined,
    variableValues: Record<string, unknown> | null | undefined,
): number {
    if (!args) return 1;
    for (const arg of args) {
        if (MULTIPLIER_ARGS[arg.name.value] !== true) continue;
        const n = readNumeric(arg.value, variableValues);
        if (n !== null && n > 0) return n;
    }
    return 1;
}

function fragmentMap(document: DocumentNode): Map<string, FragmentDefinitionNode> {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of document.definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) {
            fragments.set(def.name.value, def);
        }
    }
    return fragments;
}

export function analyzeComplexity(
    document: DocumentNode,
    variableValues?: Record<string, unknown> | null,
): ComplexityAnalysis {
    const fragments = fragmentMap(document);
    let aliases = 0;

    function walkAliases(node: { selectionSet?: { selections: readonly SelectionNode[] } }, seen: Set<string>): void {
        if (!node.selectionSet) return;
        for (const selection of node.selectionSet.selections) {
            if (selection.kind === Kind.FIELD) {
                if (selection.alias) aliases++;
                walkAliases(selection, seen);
            } else if (selection.kind === Kind.INLINE_FRAGMENT) {
                walkAliases(selection, seen);
            } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
                const name = selection.name.value;
                if (seen.has(name)) continue;
                seen.add(name);
                const fragment = fragments.get(name);
                if (fragment) walkAliases(fragment, seen);
            }
        }
    }

    function cost(
        node: { selectionSet?: { selections: readonly SelectionNode[] } },
        active: Set<string>,
        charged: Set<string>,
    ): number {
        if (!node.selectionSet) return 0;
        let total = 0;
        for (const selection of node.selectionSet.selections) {
            if (selection.kind === Kind.FIELD) {
                if (selection.name.value.startsWith("__")) {
                    total += INTROSPECTION_FIELD_COST + cost(selection, active, charged);
                    continue;
                }
                const multiplier = readMultiplier(selection.arguments, variableValues);
                total += multiplier * (1 + cost(selection, active, charged));
            } else if (selection.kind === Kind.INLINE_FRAGMENT) {
                total += cost(selection, active, charged);
            } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
                const name = selection.name.value;
                if (active.has(name)) {
                    total += FRAGMENT_REPEAT_COST;
                    continue;
                }
                const fragment = fragments.get(name);
                if (!fragment) continue;
                if (charged.has(name)) {
                    total += FRAGMENT_REPEAT_COST;
                    continue;
                }
                charged.add(name);
                active.add(name);
                total += cost(fragment, active, charged);
                active.delete(name);
            }
        }
        return total;
    }

    let complexity = 0;
    for (const def of document.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        walkAliases(def, new Set());
        const opCost = cost(def, new Set(), new Set());
        if (opCost > complexity) complexity = opCost;
    }
    return { complexity, aliases };
}

export function complexityErrors(
    analysis: ComplexityAnalysis,
    maxComplexity: number,
    aliasCap: number = GRAPHQL_ALIAS_CAP,
): string[] {
    const errors: string[] = [];
    if (analysis.aliases > aliasCap) {
        errors.push(
            `Query uses ${analysis.aliases} aliases, which exceeds the per-operation alias cap of ${aliasCap}`,
        );
    }
    if (analysis.complexity > maxComplexity) {
        errors.push(
            `Query complexity ${analysis.complexity} exceeds maximum allowed complexity of ${maxComplexity}`,
        );
    }
    return errors;
}

function contextVariables(context: ValidationContext): Record<string, unknown> | undefined {
    if (!("coercedVariableValues" in context)) return undefined;
    const raw = context.coercedVariableValues;
    if (!raw || typeof raw !== "object") return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) out[key] = value;
    return out;
}

export function complexityLimitRule(
    maxComplexity: number,
    variableValues?: Record<string, unknown> | null,
    aliasCap: number = GRAPHQL_ALIAS_CAP,
) {
    return function ComplexityLimitValidationRule(context: ValidationContext) {
        return {
            OperationDefinition(node: OperationDefinitionNode) {
                const document = context.getDocument();
                const values = variableValues ?? contextVariables(context);
                const analysis = analyzeComplexity(
                    {
                        ...document,
                        definitions: [
                            node,
                            ...document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION),
                        ],
                    },
                    values,
                );
                for (const message of complexityErrors(analysis, maxComplexity, aliasCap)) {
                    context.reportError(new GraphQLError(message));
                }
            },
        };
    };
}

function coercedVariables(
    schema: GraphQLSchema,
    document: DocumentNode,
    operationName: string | undefined,
    raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
    const op = document.definitions.find(
        (d): d is OperationDefinitionNode =>
            d.kind === Kind.OPERATION_DEFINITION &&
            (operationName == null || d.name?.value === operationName),
    );
    if (!op) return raw ?? {};
    const result = getVariableValues(schema, op.variableDefinitions ?? [], raw ?? {});
    if (result.errors) return raw ?? {};
    return result.coerced ?? {};
}

function rejectIfOverBudget(
    schema: GraphQLSchema,
    document: DocumentNode,
    operationName: string | undefined,
    rawVariables: Record<string, unknown> | null | undefined,
    maxComplexity: number,
): GraphQLError[] {
    const values = coercedVariables(schema, document, operationName, rawVariables);
    const analysis = analyzeComplexity(document, values);
    return complexityErrors(analysis, maxComplexity).map((message) => new GraphQLError(message));
}

function readRawVariables(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    return out;
}

/** One complexity walk per operation, with coerced variable multipliers. */
export function useComplexityLimit(maxComplexity: number): Plugin {
    return {
        onExecute({ args, setResultAndStopExecution }) {
            const errors = rejectIfOverBudget(
                args.schema,
                args.document,
                args.operationName ?? undefined,
                readRawVariables(args.variableValues),
                maxComplexity,
            );
            if (errors.length > 0) {
                setResultAndStopExecution({ errors });
            }
        },
        onSubscribe({ args, setResultAndStopExecution }) {
            const errors = rejectIfOverBudget(
                args.schema,
                args.document,
                args.operationName ?? undefined,
                readRawVariables(args.variableValues),
                maxComplexity,
            );
            if (errors.length > 0) {
                setResultAndStopExecution({ errors });
            }
        },
    };
}
