import type { GraphQLObjectTypeMeta, GraphQLOperationMeta, GraphQLSubscriptionMeta } from "gql/Generator";

class BaseService {
    public __graphqlObjectType?: GraphQLObjectTypeMeta[];
    public __graphqlOperations?: GraphQLOperationMeta<any>[];
    public __graphqlSubscriptions?: GraphQLSubscriptionMeta<any>[];
    constructor() {

    }
}

export default BaseService ;