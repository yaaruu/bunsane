import type { GraphQLObjectTypeMeta, GraphQLOperationMeta } from "gql/Generator";

class BaseService {
    public __graphqlObjectType?: GraphQLObjectTypeMeta[];
    public __graphqlOperations?: GraphQLOperationMeta<any>[];
    constructor() {

    }
}

export default BaseService ;