import { describe, test, expect } from "bun:test";
import {
    GraphQLSchema,
    GraphQLObjectType,
    GraphQLString,
    GraphQLList,
    validate,
    parse,
} from "graphql";
import { depthLimitRule } from "../../../gql/depthLimit";

// Build a test schema with nested types: Query -> user -> friends -> friends -> ...
const UserType: GraphQLObjectType = new GraphQLObjectType({
    name: "User",
    fields: () => ({
        name: { type: GraphQLString },
        email: { type: GraphQLString },
        friends: { type: new GraphQLList(UserType) },
    }),
});

const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
        name: "Query",
        fields: {
            user: { type: UserType },
        },
    }),
});

function validateQuery(query: string, maxDepth: number) {
    const doc = parse(query);
    const rule = depthLimitRule(maxDepth);
    return validate(schema, doc, [rule]);
}

describe("depthLimitRule", () => {
    test("allows queries within depth limit", () => {
        const query = `{ user { name } }`;
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(0);
    });

    test("allows queries at exact depth boundary", () => {
        // depth: user(1) -> name(2) = 2
        const query = `{ user { name } }`;
        const errors = validateQuery(query, 2);
        expect(errors).toHaveLength(0);
    });

    test("rejects queries exceeding depth limit", () => {
        // depth: user(1) -> friends(2) -> friends(3) -> name(4) = 4
        const query = `{ user { friends { friends { name } } } }`;
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain("exceeds maximum allowed depth");
    });

    test("handles deeply nested queries", () => {
        // depth 5
        const query = `{
            user {
                friends {
                    friends {
                        friends {
                            name
                        }
                    }
                }
            }
        }`;
        const errors = validateQuery(query, 2);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain("depth 5");
        expect(errors[0]!.message).toContain("maximum allowed depth of 2");
    });

    test("handles named fragments correctly", () => {
        // The fragment expands to depth: friends(2) -> name(3)
        // Total: user(1) -> friends(2) -> name(3) = 3
        const query = `
            fragment FriendFields on User {
                name
            }
            { user { friends { ...FriendFields } } }
        `;
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(0);
    });

    test("rejects named fragments that cause depth violation", () => {
        // fragment expands: friends -> friends -> name (3 levels from fragment root)
        // Total: user(1) -> friends(2) -> friends(3) -> name(4) = 4
        const query = `
            fragment DeepFriends on User {
                friends { friends { name } }
            }
            { user { ...DeepFriends } }
        `;
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(1);
    });

    test("handles inline fragments correctly", () => {
        // Inline fragments don't increment depth
        // depth: user(1) -> ... on User -> name(2) = 2
        const query = `{
            user {
                ... on User {
                    name
                }
            }
        }`;
        const errors = validateQuery(query, 2);
        expect(errors).toHaveLength(0);
    });

    test("handles inline fragments with nested fields", () => {
        // user(1) -> ... on User -> friends(2) -> name(3) = 3
        const query = `{
            user {
                ... on User {
                    friends { name }
                }
            }
        }`;
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(0);

        const errorsStrict = validateQuery(query, 2);
        expect(errorsStrict).toHaveLength(1);
    });

    test("depth 1 only allows scalar root fields", () => {
        // user -> name = depth 2
        const query = `{ user { name } }`;
        const errors = validateQuery(query, 1);
        expect(errors).toHaveLength(1);
    });

    test("multiple operations are each checked independently", () => {
        const query = `
            query Shallow { user { name } }
            query Deep { user { friends { friends { friends { name } } } } }
        `;
        // maxDepth 2 should pass Shallow (depth=2) but fail Deep (depth=5)
        const errors = validateQuery(query, 2);
        expect(errors).toHaveLength(1);
    });

    test("allows introspection queries regardless of depth", () => {
        // Real introspection queries go 13+ levels deep
        const query = `{
            __schema {
                types {
                    name
                    fields {
                        name
                        type {
                            name
                            ofType {
                                name
                                ofType {
                                    name
                                    ofType {
                                        name
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;
        // depth=8, limit=3 — should still pass because it's introspection
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(0);
    });

    test("allows __type introspection queries", () => {
        const query = `{
            __type(name: "User") {
                name
                fields {
                    name
                    type { name ofType { name ofType { name } } }
                }
            }
        }`;
        const errors = validateQuery(query, 2);
        expect(errors).toHaveLength(0);
    });

    test("still limits mixed queries with introspection and user fields", () => {
        // If a query mixes __schema with user fields, it's NOT pure introspection
        const query = `{
            __schema { types { name } }
            user { friends { friends { friends { name } } } }
        }`;
        const errors = validateQuery(query, 3);
        expect(errors).toHaveLength(1);
    });
});
