import {
    type ASTVisitor,
    type DocumentNode,
    type FragmentDefinitionNode,
    type ValidationContext,
    GraphQLError,
    Kind,
} from "graphql";

export function depthLimitRule(maxDepth: number) {
    return function DepthLimitValidationRule(
        context: ValidationContext,
    ): ASTVisitor {
        const document: DocumentNode = context.getDocument();

        // Build fragment map
        const fragments = new Map<string, FragmentDefinitionNode>();
        for (const def of document.definitions) {
            if (def.kind === Kind.FRAGMENT_DEFINITION) {
                fragments.set(def.name.value, def);
            }
        }

        function measureDepth(
            node: { selectionSet?: { selections: readonly any[] } },
            depth: number,
            visited: Set<string>,
        ): number {
            if (!node.selectionSet) return depth;

            let max = depth;
            for (const selection of node.selectionSet.selections) {
                if (selection.kind === Kind.FIELD) {
                    const fieldDepth = measureDepth(
                        selection,
                        depth + 1,
                        visited,
                    );
                    if (fieldDepth > max) max = fieldDepth;
                } else if (selection.kind === Kind.INLINE_FRAGMENT) {
                    const fragDepth = measureDepth(selection, depth, visited);
                    if (fragDepth > max) max = fragDepth;
                } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
                    const name = selection.name.value;
                    if (visited.has(name)) continue;
                    visited.add(name);
                    const fragment = fragments.get(name);
                    if (fragment) {
                        const fragDepth = measureDepth(
                            fragment,
                            depth,
                            visited,
                        );
                        if (fragDepth > max) max = fragDepth;
                    }
                }
            }
            return max;
        }

        return {
            OperationDefinition(node) {
                // Skip introspection queries — they are inherently deep (13+ levels)
                // and must be allowed for tooling (codegen, IDE autocomplete, etc.)
                if (node.selectionSet) {
                    const isIntrospection = node.selectionSet.selections.every(
                        (sel) =>
                            sel.kind === Kind.FIELD &&
                            sel.name.value.startsWith("__"),
                    );
                    if (isIntrospection) return;
                }

                const depth = measureDepth(node, 0, new Set());
                if (depth > maxDepth) {
                    context.reportError(
                        new GraphQLError(
                            `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}`,
                        ),
                    );
                }
            },
        };
    };
}
