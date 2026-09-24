export type GraphQLType =
  | string
  | `${string}!`
  | `[${string}]`
  | `[${string}]!`;

export function isValidGraphQLType(type: string): type is GraphQLType {
  return /^(\w+|\[\w+\])(!)?$/.test(type);
}

export function isFieldRequested(info: { fieldNodes?: Array<{ selectionSet?: { selections: Array<{ name?: { value?: string } }> } }> }, fieldName: string): boolean {
    const selections = info.fieldNodes?.[0]?.selectionSet?.selections;
    if (!selections) return false;
    return selections.some((selection) => selection.name?.value === fieldName);
}

export function isFieldRequestedSafe(info: { fieldNodes?: Array<{ selectionSet?: { selections: readonly unknown[] } }> } | null | undefined, ...path: string[]): boolean {
    const fieldNode = info?.fieldNodes?.[0];
    if (!fieldNode?.selectionSet) return false;
    return isPathSelected(fieldNode.selectionSet, path);
}

function isPathSelected(selectionSet: { selections: readonly unknown[] }, path: string[]): boolean {
    if (path.length === 0) return true;
    const [current, ...rest] = path;
    for (const selection of selectionSet.selections) {
        if (!selection || typeof selection !== "object" || !("kind" in selection)) continue;
        if (selection.kind === "Field" && "name" in selection && selection.name && typeof selection.name === "object" && "value" in selection.name && selection.name.value === current) {
            if (rest.length === 0) return true;
            if ("selectionSet" in selection && selection.selectionSet && typeof selection.selectionSet === "object" && "selections" in selection.selectionSet) {
                return isPathSelected(selection.selectionSet as { selections: readonly unknown[] }, rest);
            }
            return false;
        }
        if ((selection.kind === "InlineFragment" || selection.kind === "FragmentSpread") && "selectionSet" in selection && selection.selectionSet && typeof selection.selectionSet === "object" && "selections" in selection.selectionSet) {
            if (isPathSelected(selection.selectionSet as { selections: readonly unknown[] }, path)) return true;
        }
    }
    return false;
}
