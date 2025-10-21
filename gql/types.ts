

export enum GraphQLScalar {
    ID = "ID",
    INT = "Int",
    FLOAT = "Float",
    STRING = "String",
    BOOLEAN = "Boolean",
}

export interface GraphQLObject {
    name: string;
    fields: GraphQLField[];
}

export type GraphQLType = GraphQLScalar | string;
export interface GraphQLField {
    name: string;
    type: GraphQLType;
    isList?: boolean;
    isRequired?: boolean;
}



// TODO: Remove this when we have a better way to define GraphQL type
// Current usage is for custom input types in Operation decorators
export enum GraphQLFieldTypes {
    ID = "ID",
    ID_REQUIRED = "ID!",
    INT = "Int",
    INT_REQUIRED = "Int!",
    FLOAT = "Float",
    FLOAT_REQUIRED = "Float!",
    STRING = "String",
    STRING_REQUIRED = "String!",
    BOOLEAN = "Boolean",
    BOOLEAN_REQUIRED = "Boolean!",
}

export const GraphQLList = {
    of: (type: string) => `[${type}]`,
    ofRequired: (type: string) => `[${type}]!`,
} as const;

// Utils for building GraphQL Enums
import { GraphQLEnumType } from 'graphql';

type EnumObject = {
  [index: string]: string;
};

type EnumObjectResult = {
  [index: string]: {
    value: string;
  };
};
export const enumBuilderValues = <T extends EnumObject>(
  constants: T,
): EnumObjectResult =>
  Object.keys(constants).reduce(
    (prev, curr) => ({
      ...prev,
      [curr]: {
        value: constants[curr],
      },
    }),
    {},
  );


export const graphqlEnumBuilder = <T extends EnumObject>(name: string, values: T) =>
  new GraphQLEnumType({
    name,
    values: enumBuilderValues(values),
  });
