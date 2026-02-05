import {
    GraphQLScalar,
    type GraphQLObject,
    type GraphQLField
} from "../../../gql/types"

export interface GQLObjectMetaData {
    name: string;
    fields: GraphQLField[];
}
