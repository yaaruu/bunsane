import ServiceRegistry from "../../service/ServiceRegistry";
import { type Plugin } from "graphql-yoga";
import { createYogaInstance } from "../../gql";
import { createRequestContextPlugin } from "../RequestContext";

export function setupGraphQL(app: {
    contextFactory?: (yogaContext: unknown) => Promise<unknown> | unknown;
    graphqlMaxDepth: number;
    graphqlMaxComplexity: number;
    graphqlIntrospection?: boolean;
    graphqlGraphiQL?: boolean;
    requestContextPluginEnabled: boolean;
    yogaPlugins: Plugin[];
    yoga: unknown;
}): void {
    const schemaProvider = () => ServiceRegistry.getSchema();

    const wrappedContextFactory = app.contextFactory
        ? async (yogaContext: unknown) => {
              const userContext = await app.contextFactory!(yogaContext);
              if (userContext && typeof userContext === "object") {
                  return { ...(yogaContext as Record<string, unknown>), ...userContext };
              }
              return userContext;
          }
        : undefined;

    if (!Number.isInteger(app.graphqlMaxDepth) || app.graphqlMaxDepth < 1) {
        throw new Error(
            `GraphQL maxDepth ${String(app.graphqlMaxDepth)} is invalid. ` +
            `Pass an integer >= 1 via setGraphQLMaxDepth or GRAPHQL_MAX_DEPTH. The limit cannot be disabled.`,
        );
    }
    if (!Number.isInteger(app.graphqlMaxComplexity) || app.graphqlMaxComplexity < 1) {
        throw new Error(
            `GraphQL maxComplexity ${String(app.graphqlMaxComplexity)} is invalid. ` +
            `Pass an integer >= 1 via setGraphQLMaxComplexity or GRAPHQL_MAX_COMPLEXITY. The limit cannot be disabled.`,
        );
    }

    const yogaOptions = {
        cors: false as const,
        maxDepth: app.graphqlMaxDepth,
        maxComplexity: app.graphqlMaxComplexity,
        introspection: typeof app.graphqlIntrospection === "boolean" ? app.graphqlIntrospection : undefined,
        graphiql: typeof app.graphqlGraphiQL === "boolean" ? app.graphqlGraphiQL : undefined,
    };

    const effectivePlugins: Plugin[] = app.requestContextPluginEnabled
        ? [createRequestContextPlugin(), ...app.yogaPlugins]
        : [...app.yogaPlugins];

    app.yoga = createYogaInstance(
        schemaProvider,
        effectivePlugins,
        wrappedContextFactory,
        yogaOptions,
    );
}
