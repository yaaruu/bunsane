

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
