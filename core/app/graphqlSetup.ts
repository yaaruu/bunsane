import ServiceRegistry from "../../service/ServiceRegistry";
import { type Plugin } from "graphql-yoga";
import { createYogaInstance } from "../../gql";
import { createRequestContextPlugin } from "../RequestContext";

export function setupGraphQL(app: any): void {
    // Provide the schema as a live factory rather than a fixed reference, so
    // ServiceRegistry.rebuildSchema() is observed by the next request without
    // recreating Yoga. Falls back to the static placeholder while null.
    const schemaProvider = () => ServiceRegistry.getSchema();

    const wrappedContextFactory = app.contextFactory
        ? async (yogaContext: any) => {
              const userContext = await app.contextFactory(yogaContext);
              return {
                  ...yogaContext,
                  ...userContext,
              };
          }
        : undefined;

    const envDepth = process.env.GRAPHQL_MAX_DEPTH;
    if (envDepth) {
        app.graphqlMaxDepth = parseInt(envDepth, 10);
    }
    const envComplexity = process.env.GRAPHQL_MAX_COMPLEXITY;
    if (envComplexity) {
        const parsed = parseInt(envComplexity, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
            app.graphqlMaxComplexity = parsed;
        }
    }

    const yogaOptions = {
        cors: app.config.cors,
        maxDepth: app.graphqlMaxDepth || undefined,
        maxComplexity: app.graphqlMaxComplexity,
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
