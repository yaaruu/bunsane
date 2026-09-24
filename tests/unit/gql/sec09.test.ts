import { afterEach, describe, expect, test } from "bun:test";
import {
    GraphQLInt,
    GraphQLObjectType,
    GraphQLSchema,
    GraphQLString,
    getIntrospectionQuery,
    parse,
} from "graphql";
import { createYogaInstance, type YogaInstance } from "../../../gql";
import { setupGraphQL } from "../../../core/app/graphqlSetup";
import { analyzeComplexity, complexityErrors } from "../../../gql/complexityLimit";

const originalNodeEnv = process.env.NODE_ENV;
const originalIntrospection = process.env.GRAPHQL_INTROSPECTION;
const originalGraphiql = process.env.GRAPHQL_GRAPHIQL;

afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalIntrospection === undefined) delete process.env.GRAPHQL_INTROSPECTION;
    else process.env.GRAPHQL_INTROSPECTION = originalIntrospection;
    if (originalGraphiql === undefined) delete process.env.GRAPHQL_GRAPHIQL;
    else process.env.GRAPHQL_GRAPHIQL = originalGraphiql;
});

const NodeType: GraphQLObjectType = new GraphQLObjectType({
    name: "Node",
    fields: () => ({
        x: { type: GraphQLString },
        child: { type: GraphQLString },
        friend: { type: NodeType },
    }),
});

const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
        name: "Query",
        fields: {
            c: {
                type: NodeType,
                args: { first: { type: GraphQLInt } },
                resolve: () => ({ x: "ok", child: "ok" }),
            },
            hello: { type: GraphQLString, resolve: () => "hi" },
        },
    }),
});

async function post(
    yoga: YogaInstance,
    query: string,
    variables?: Record<string, unknown>,
) {
    const response = await yoga.fetch("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    return response.json() as Promise<{ data?: unknown; errors?: Array<{ message: string }> }>;
}

describe("SEC-09 recon surface", () => {
    test("non-development defaults reject introspection and do not serve GraphiQL", async () => {
        delete process.env.NODE_ENV;
        delete process.env.GRAPHQL_INTROSPECTION;
        delete process.env.GRAPHQL_GRAPHIQL;

        const yoga = createYogaInstance(schema);
        const html = await yoga.fetch("http://localhost/graphql", {
            headers: { accept: "text/html" },
        });
        expect(html.status).toBe(404);
        expect(await html.text()).not.toContain("graphiql");

        const body = await post(yoga, "{ __schema { types { name } } }");
        expect(body.errors?.[0]?.message ?? "").toMatch(/introspection/i);
    });

    test("explicit opt-in and development restore introspection and GraphiQL", async () => {
        process.env.NODE_ENV = "production";
        const opted = createYogaInstance(schema, [], undefined, { introspection: true, graphiql: true });
        const optedBody = await post(opted, "{ __schema { types { name } } }");
        expect(optedBody.errors).toBeUndefined();
        const optedHtml = await opted.fetch("http://localhost/graphql", {
            headers: { accept: "text/html" },
        });
        expect(optedHtml.status).toBe(200);
        expect(await optedHtml.text()).toContain("GraphiQL");

        delete process.env.GRAPHQL_INTROSPECTION;
        process.env.NODE_ENV = "development";
        const dev = createYogaInstance(schema);
        const devBody = await post(dev, "{ __typename }");
        expect(devBody.errors).toBeUndefined();
        const intro = await post(dev, getIntrospectionQuery());
        expect(intro.errors).toBeUndefined();
    });

    test("GRAPHQL_INTROSPECTION=on enables introspection when not in development", async () => {
        process.env.NODE_ENV = "production";
        process.env.GRAPHQL_INTROSPECTION = "on";
        process.env.GRAPHQL_GRAPHIQL = "off";
        const yoga = createYogaInstance(schema);
        const body = await post(yoga, "{ __schema { types { name } } }");
        expect(body.errors).toBeUndefined();
        const html = await yoga.fetch("http://localhost/graphql", {
            headers: { accept: "text/html" },
        });
        expect(html.status).toBe(404);
    });
});

describe("SEC-09 complexity", () => {
    test("a million-valued first variable exceeds the complexity budget", async () => {
        const yoga = createYogaInstance(schema, [], undefined, {
            introspection: false,
            graphiql: false,
            maxComplexity: 100,
        });
        const body = await post(
            yoga,
            "query ($n: Int) { c(first: $n) { x } }",
            { n: 1_000_000 },
        );
        expect(body.errors?.[0]?.message ?? "").toMatch(/complexity \d+ exceeds maximum allowed complexity of 100/);
    });

    test("60 aliases of one fragment are charged per use and hit the alias cap", () => {
        const spreads = Array.from({ length: 60 }, (_, i) => `a${i}: c { ...Frag }`).join("\n");
        const query = `query { ${spreads} } fragment Frag on Node { x child }`;
        const once = analyzeComplexity(parse("query { c { ...Frag } } fragment Frag on Node { x child }"));
        const many = analyzeComplexity(parse(query));
        expect(many.aliases).toBe(60);
        expect(many.complexity).toBeGreaterThan(once.complexity * 10);
        expect(complexityErrors(many, 10_000).join(" ")).toMatch(/alias cap of 50/);
    });

    test("introspection fields are charged so a small __schema walk exceeds a tight budget", async () => {
        const yoga = createYogaInstance(schema, [], undefined, {
            introspection: true,
            graphiql: false,
            maxComplexity: 10,
        });
        const body = await post(yoga, "{ __schema { types { name } } }");
        expect(body.errors?.[0]?.message ?? "").toMatch(/complexity/);
    });

    test("configured depth is honored instead of clamped to 15", async () => {
        const yoga = createYogaInstance(schema, [], undefined, {
            introspection: false,
            graphiql: false,
            maxDepth: 2,
        });
        const shallow = await post(yoga, "{ c { x } }");
        expect(shallow.errors).toBeUndefined();
        const deep = await post(yoga, "{ c { friend { friend { x } } } }");
        expect(deep.errors?.[0]?.message ?? "").toMatch(/depth 4 exceeds maximum allowed depth of 2/);
    });

    test("maxDepth and maxComplexity below 1 throw instead of disabling the guard", () => {
        expect(() => createYogaInstance(schema, [], undefined, { maxDepth: 0 })).toThrow(/cannot be disabled/);
        expect(() => createYogaInstance(schema, [], undefined, { maxComplexity: 0 })).toThrow(/cannot be disabled/);
        expect(() => setupGraphQL({
            graphqlMaxDepth: 0,
            graphqlMaxComplexity: 1000,
            requestContextPluginEnabled: false,
            yogaPlugins: [],
            yoga: undefined,
        })).toThrow(/maxDepth 0 is invalid/);
    });
});
