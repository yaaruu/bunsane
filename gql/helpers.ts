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
  T extends GraphQLFieldTypes.ID_REQUIRED | GraphQLFieldTypes.ID_OPTIONAL ? string :
  T extends GraphQLFieldTypes.STRING_REQUIRED ? string :
  T extends GraphQLFieldTypes.STRING_OPTIONAL ? string | null :
  T extends GraphQLFieldTypes.INT_REQUIRED ? number :
  T extends GraphQLFieldTypes.INT_OPTIONAL ? number | null :
  T extends GraphQLFieldTypes.BOOLEAN_REQUIRED ? boolean :
  T extends GraphQLFieldTypes.BOOLEAN_OPTIONAL ? boolean | null :
  T extends GraphQLFieldTypes.FLOAT_REQUIRED ? number :
  T extends GraphQLFieldTypes.FLOAT_OPTIONAL ? number | null :
  T extends `[${string}]` | `[${string}]!` ? any[] :  
  any;  

export type ResolverInput<T extends Record<string, GraphQLType>> = {
  [K in keyof T]: TypeFromGraphQL<T[K]>;
};

