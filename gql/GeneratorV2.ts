import { GraphQLSchema } from "graphql";
import { GraphQLSchemaOrchestrator } from "./orchestration/GraphQLSchemaOrchestrator";
import { logger } from "../core/Logger";

/**
 * Graph-based GraphQL schema generation.
 *
 * @param services Service instances to generate the schema from
 * @returns The generated GraphQL schema and an empty resolvers bag (resolvers live on the schema)
 */
export function generateGraphQLSchemaV2(
    services: object[],
): { schema: GraphQLSchema | null; resolvers: Record<string, never> } {
    try {
        logger.debug("Starting GraphQL schema generation with V2 (graph-based) implementation");

        const orchestrator = new GraphQLSchemaOrchestrator();
        const schema = orchestrator.generateSchema(services);
        const resolvers = {};

        logger.debug("GraphQL schema generation V2 completed successfully");
        return { schema, resolvers };
    } catch (error) {
        logger.error(`Failed to generate GraphQL schema with V2 implementation: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}
