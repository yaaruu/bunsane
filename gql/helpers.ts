import { GraphQLFieldTypes } from './types';

export type GraphQLType =
  | GraphQLFieldTypes  // e.g., "ID!", "String"
  | string             // For custom types like "User", "[User]", "[User]!"
  | `${string}!`       // For required custom types
  | `[${string}]`      // For list types
  | `[${string}]!`;    // For required list types

export function isValidGraphQLType(type: string): type is GraphQLType {
  const enumValues = Object.values(GraphQLFieldTypes);
  return enumValues.includes(type as GraphQLFieldTypes) ||
         /^(\w+|\[\w+\])(!)?$/.test(type);  // Simple regex for custom types/lists
}

export type TypeFromGraphQL<T extends GraphQLType> =
  T extends GraphQLFieldTypes.ID_REQUIRED | GraphQLFieldTypes.ID ? string :
  T extends GraphQLFieldTypes.STRING_REQUIRED ? string :
  T extends GraphQLFieldTypes.STRING ? string | null :
  T extends GraphQLFieldTypes.INT_REQUIRED ? number :
  T extends GraphQLFieldTypes.INT ? number | null :
  T extends GraphQLFieldTypes.BOOLEAN_REQUIRED ? boolean :
  T extends GraphQLFieldTypes.BOOLEAN ? boolean | null :
  T extends GraphQLFieldTypes.FLOAT_REQUIRED ? number :
  T extends GraphQLFieldTypes.FLOAT ? number | null :
  T extends `[${string}]` | `[${string}]!` ? any[] :  
  any;  

export type ResolverInput<T extends Record<string, GraphQLType>> = {
  [K in keyof T]: TypeFromGraphQL<T[K]>;
};

export function isFieldRequested(info: any, fieldName: string): boolean {
    return info.fieldNodes[0].selectionSet.selections.some((selection: any) => 
        selection.name.value === fieldName
    );
}

export function isFieldRequestedSafe(info: any, ...path: string[]): boolean {
    if (!info || !info.fieldNodes || info.fieldNodes.length === 0) return false;
    const fieldNode = info.fieldNodes[0];
    if (!fieldNode.selectionSet) return false;
    return isPathSelected(fieldNode.selectionSet, path);
}

function isPathSelected(selectionSet: any, path: string[]): boolean {
    if (path.length === 0) return true;
    const [current, ...rest] = path;
    for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
            if (selection.name.value === current) {
                if (rest.length === 0) return true;
                if (selection.selectionSet) {
                    return isPathSelected(selection.selectionSet, rest);
                }
                return false;
            }
        } else if (selection.kind === 'InlineFragment' || selection.kind === 'FragmentSpread') {
            // For simplicity, assume fragments are expanded; in practice, they should be resolved
            // Here, we can check if the fragment has the field
            if (selection.selectionSet) {
                if (isPathSelected(selection.selectionSet, path)) return true;
            }
        }
    }
    return false;
}