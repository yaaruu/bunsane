import {
    type ASTVisitor,
    type DocumentNode,
    type FragmentDefinitionNode,
    type ValidationContext,
    GraphQLError,
    Kind,
} from "graphql";

/**
 * Lightweight GraphQL query complexity validator. Assigns each selected field
 * a base cost of 1, multiplied by the value of a `first` / `limit` / `take`
 * argument when present. Nested selections contribute their (multiplied) cost.
 * Fragments are followed and deduped. Introspection queries are exempt.
 *
 * Not as expressive as `graphql-query-complexity` (no per-field estimators,
 * no custom weights). Enough to block obviously abusive nested archetype
 * relations without a heavyweight dep.
 */
export function complexityLimitRule(maxComplexity: number) {
    return function ComplexityLimitValidationRule(
        context: ValidationContext,
    ): ASTVisitor {
        const document: DocumentNode = context.getDocument();

        const fragments = new Map<string, FragmentDefinitionNode>();
        for (const def of document.definitions) {
            if (def.kind === Kind.FRAGMENT_DEFINITION) {
                fragments.set(def.name.value, def);
            }
        }

        const MULTIPLIER_ARGS = new Set(["first", "limit", "take"]);

        function readMultiplier(args: readonly any[] | undefined): number {
            if (!args) return 1;
            for (const arg of args) {
                if (!MULTIPLIER_ARGS.has(arg.name.value)) continue;
                const v = arg.value;
                if (v.kind === Kind.INT) {
                    const n = parseInt(v.value, 10);
                    if (Number.isFinite(n) && n > 0) return n;
                }
            }
            return 1;
        }

        function cost(
            node: { selectionSet?: { selections: readonly any[] } },
            visited: Set<string>,
        ): number {
            if (!node.selectionSet) return 0;

            let total = 0;
            for (const selection of node.selectionSet.selections) {
                if (selection.kind === Kind.FIELD) {
                    const multiplier = readMultiplier(selection.arguments);
                    const childCost = cost(selection, visited);
                    total += multiplier * (1 + childCost);
                } else if (selection.kind === Kind.INLINE_FRAGMENT) {
                    total += cost(selection, visited);
                } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
                    const name = selection.name.value;
                    if (visited.has(name)) continue;
                    visited.add(name);
                    const fragment = fragments.get(name);
                    if (fragment) total += cost(fragment, visited);
                }
            }
            return total;
        }

        return {
            OperationDefinition(node) {
                if (node.selectionSet) {
                    const isIntrospection = node.selectionSet.selections.every(
                        (sel) =>
                            sel.kind === Kind.FIELD &&
                            sel.name.value.startsWith("__"),
                    );
                    if (isIntrospection) return;
                }

                const total = cost(node, new Set());
                if (total > maxComplexity) {
                    context.reportError(
                        new GraphQLError(
                            `Query complexity ${total} exceeds maximum allowed complexity of ${maxComplexity}`,
                        ),
                    );
                }
            },
        };
    };
}
