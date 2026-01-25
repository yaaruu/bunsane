import { GraphQLSchema } from "graphql";
import { GraphQLSchemaOrchestrator } from "./orchestration/GraphQLSchemaOrchestrator";
import { logger } from "../core/Logger";

/**
 * New graph-based GraphQL schema generation function.
 * This is the V2 implementation using the GraphQLSchemaOrchestrator.
 *
 * @param services Array of service instances to generate schema from
 * @param options Configuration options
 * @returns Object containing the generated GraphQL schema and resolvers
 */
export function generateGraphQLSchemaV2(
    services: any[],
    options?: { enableArchetypeOperations?: boolean }
): { schema: GraphQLSchema | null; resolvers: any } {
    try {
        logger.info("Starting GraphQL schema generation with V2 (graph-based) implementation");

        // Create orchestrator instance
        const orchestrator = new GraphQLSchemaOrchestrator();

        // Generate schema using orchestrator
        const schema = orchestrator.generateSchema(services);

        // For now, return empty resolvers since the orchestrator handles everything internally
        // TODO: Extract resolvers from orchestrator if needed for external access
        const resolvers = {};

        logger.info("GraphQL schema generation V2 completed successfully");
        return { schema, resolvers };

    } catch (error) {
        logger.error(`Failed to generate GraphQL schema with V2 implementation: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}