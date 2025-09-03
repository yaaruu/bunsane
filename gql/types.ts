export enum GraphQLScalar {
    ID = "ID",
    String = "String",
    Int = "Int",
    Float = "Float",
    Boolean = "Boolean",
    Date = "Date",
}

export enum GraphQLTypes {
    ID_REQUIRED = "ID!",
    ID_OPTIONAL = "ID",
    STRING_REQUIRED = "String!",
    STRING_OPTIONAL = "String",
    INT_REQUIRED = "Int!",
    INT_OPTIONAL = "Int",
    FLOAT_REQUIRED = "Float!",
    FLOAT_OPTIONAL = "Float",
    BOOLEAN_REQUIRED = "Boolean!",
    BOOLEAN_OPTIONAL = "Boolean",
}

export const GraphQLList = {
    of: (type: string) => `[${type}]`,
    ofRequired: (type: string) => `[${type}]!`,
} as const;


