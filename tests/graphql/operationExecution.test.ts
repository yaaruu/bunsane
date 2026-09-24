/**
 * D9: a service method decorated with @GraphQLOperation, a t.* input, and an
 * archetype output builds a schema and executes through Yoga.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { printSchema } from "graphql";
import { GraphQLOperation, t, generateGraphQLSchemaV2, createYogaInstance } from "../../gql";
import BaseService from "../../service/Service";
import { TestUserArchetype } from "../fixtures/archetypes/TestUserArchetype";
import { TestUser, TestProduct, TestOrder } from "../fixtures/components";
import { ensureComponentsRegistered } from "../utils";

class EchoService extends BaseService {
    @GraphQLOperation({
        type: "Query",
        input: { name: t.string().required() },
        output: TestUserArchetype,
    })
    async echoUser(input: { name: string }): Promise<TestUserArchetype> {
        const row = new TestUserArchetype();
        Object.assign(row, { id: "echo-1", user: { name: input.name, email: "ada@example.com", age: 1 } });
        return row;
    }
}

describe("GraphQLOperation execution", () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
    });

    test("builds the schema and executes the operation through Yoga", async () => {
        const service = new EchoService();
        const { schema } = generateGraphQLSchemaV2([service]);
        expect(schema).toBeTruthy();

        const printed = printSchema(schema!);
        expect(printed).toContain("echoUser(input: echoUserInput!): TestUserArchetype");

        const yoga = createYogaInstance(schema!, [], undefined, {
            introspection: true,
            graphiql: false,
        });
        const response = await yoga.fetch("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                query: `query { echoUser(input: { name: "Ada" }) { id } }`,
            }),
        });
        const body = await response.json() as { data?: { echoUser?: { id?: string } }; errors?: Array<{ message: string }> };
        expect(body.errors).toBeUndefined();
        expect(body.data?.echoUser?.id).toBe("echo-1");
    });
});
