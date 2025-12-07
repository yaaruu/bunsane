import { GraphQLSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import { logger } from "../../core/Logger";
import { ServiceScanner } from "../scanner/ServiceScanner";
import { SchemaGraph } from "../graph/SchemaGraph";
import { VisitorComposer } from "../visitors/VisitorComposer";
import { ArchetypePreprocessorVisitor } from "../visitors/ArchetypePreprocessorVisitor";
import { DeduplicationVisitor } from "../visitors/DeduplicationVisitor";
import { SchemaGeneratorVisitor } from "../visitors/SchemaGeneratorVisitor";
import { ResolverGeneratorVisitor } from "../visitors/ResolverGeneratorVisitor";

/**
 * Orchestrates the complete GraphQL schema generation process using the graph-based architecture.
 * Coordinates service scanning, visitor execution, and final schema assembly.
 *
 * This class implements the high-level workflow for Phase 6 of the refactor.
 */
export class GraphQLSchemaOrchestrator {
    private serviceScanner: ServiceScanner;
    private schemaGraph: SchemaGraph;
    private services: any[] = [];

    constructor() {
        this.schemaGraph = new SchemaGraph();
        this.serviceScanner = new ServiceScanner(this.schemaGraph);
    }

    /**
     * Generate a complete GraphQL schema from service instances.
     * This is the main entry point that orchestrates the entire generation process.
     */
    generateSchema(services: any[]): GraphQLSchema | null {
        try {
            logger.info("Starting GraphQL schema generation with orchestrator");

            // Store services for use in visitors
            this.services = services;

            // Phase 1: Build graph from services
            this.buildGraphFromServices(services);

            // Phase 2: Run preprocessing visitors
            this.runPreprocessingVisitors();

            // Phase 3: Run generation visitors
            const generationResults = this.runGenerationVisitors();

            // Phase 4: Sort operations alphabetically
            this.sortOperationsAlphabetically(generationResults);

            // Phase 5: Create final GraphQL schema
            const schema = this.createGraphQLSchema(generationResults);

            logger.info("GraphQL schema generation completed successfully");
            return schema;

        } catch (error) {
            logger.error("Failed to generate GraphQL schema", { error });
            throw new Error(`Schema generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Phase 1: Build the schema graph from service instances using the ServiceScanner.
     */
    private buildGraphFromServices(services: any[]): void {
        logger.debug("Phase 1: Building graph from services", { serviceCount: services.length });

        // Clear any existing nodes
        this.schemaGraph.clear();

        // Scan all services - this adds nodes directly to the graph
        this.serviceScanner.scanServices(services);

        logger.debug("Graph built successfully", {
            nodeCount: this.schemaGraph.size(),
            serviceCount: services.length
        });
    }

    /**
     * Phase 2: Run preprocessing visitors to prepare the graph for generation.
     */
    private runPreprocessingVisitors(): void {
        logger.debug("Phase 2: Running preprocessing visitors");

        const composer = new VisitorComposer();

        // Add preprocessing visitors
        composer.addVisitor(new ArchetypePreprocessorVisitor());
        composer.addVisitor(new DeduplicationVisitor());

        // Run visitors on the graph
        composer.visitGraph(this.schemaGraph);

        // Get results and apply any necessary modifications
        const results = composer.getResults();

        // Log preprocessing results
        const archetypeResults = results["visitor-0"];
        const deduplicationResults = results["visitor-1"];

        logger.debug("Preprocessing completed", {
            archetypeSchemas: archetypeResults?.archetypeSchemas?.length || 0,
            duplicateNodes: deduplicationResults?.duplicateNodeIds?.length || 0
        });
    }

    /**
     * Phase 3: Run generation visitors to produce typeDefs and resolvers.
     */
    private runGenerationVisitors(): {
        typeDefs: string;
        resolvers: Record<string, any>;
    } {
        logger.debug("Phase 3: Running generation visitors");

        const composer = new VisitorComposer();

        // Add generation visitors
        composer.addVisitor(new SchemaGeneratorVisitor());
        composer.addVisitor(new ResolverGeneratorVisitor(this.services));

        // Run visitors on the graph
        composer.visitGraph(this.schemaGraph);

        // Get results
        const results = composer.getResults();
        const schemaResults = results["visitor-0"];
        const resolverResults = results["visitor-1"];

        // Add field resolvers from services (for archetype field resolvers)
        this.addFieldResolvers(resolverResults);

        // Filter out empty resolver types to avoid schema validation errors
        const filteredResolvers: Record<string, any> = {};
        for (const [type, typeResolvers] of Object.entries(resolverResults || {})) {
            if (typeResolvers && Object.keys(typeResolvers).length > 0) {
                filteredResolvers[type] = typeResolvers;
            }
        }

        logger.debug("Generation completed", {
            typeDefsLength: schemaResults?.typeDefs?.length || 0,
            resolverCount: Object.keys(filteredResolvers).length
        });

        return {
            typeDefs: schemaResults?.typeDefs || "",
            resolvers: filteredResolvers
        };
    }

    /**
     * Add field resolvers from services (registered via archetype.registerFieldResolvers)
     */
    private addFieldResolvers(resolvers: Record<string, any>): void {
        for (const service of this.services) {
            const fields = service.__graphqlFields || service.constructor.prototype.__graphqlFields;
            if (!fields) continue;

            for (const fieldMeta of fields) {
                const { type, field, propertyKey } = fieldMeta;
                
                // Ensure the type exists in resolvers
                if (!resolvers[type]) {
                    resolvers[type] = {};
                }

                // Add field resolver
                resolvers[type][field] = async (parent: any, args: any, context: any, info: any) => {
                    try {
                        return await service[propertyKey](parent, args, context, info);
                    } catch (error) {
                        logger.error(`Error in field resolver ${type}.${field}:`, error);
                        throw error;
                    }
                };
            }
        }
    }

    /**
     * Phase 4: Sort operations alphabetically within each operation type.
     */
    private sortOperationsAlphabetically(generationResults: {
        typeDefs: string;
        resolvers: Record<string, any>;
    }): void {
        logger.debug("Phase 4: Sorting operations alphabetically");

        // Sort resolvers alphabetically within each type
        const operationTypes = ["Query", "Mutation", "Subscription"] as const;

        for (const operationType of operationTypes) {
            if (generationResults.resolvers[operationType]) {
                const sortedResolvers: Record<string, any> = {};

                // Sort operation names alphabetically
                const sortedKeys = Object.keys(generationResults.resolvers[operationType]).sort();

                for (const key of sortedKeys) {
                    sortedResolvers[key] = generationResults.resolvers[operationType][key];
                }

                generationResults.resolvers[operationType] = sortedResolvers;
            }
        }

        logger.debug("Operations sorted alphabetically");
    }

    /**
     * Phase 5: Create the final GraphQL schema using the generated typeDefs and resolvers.
     */
    private createGraphQLSchema(generationResults: {
        typeDefs: string;
        resolvers: Record<string, any>;
    }): GraphQLSchema | null {
        logger.debug("Phase 5: Creating GraphQL schema");

        // Check if there are any operations to create a schema for
        const hasOperations = Object.values(generationResults.resolvers).some(
            (typeResolvers: any) => Object.keys(typeResolvers).length > 0
        );

        if (!hasOperations && generationResults.typeDefs.trim() === "") {
            logger.warn("No operations or type definitions found, returning null schema");
            return null;
        }

        try {
            const schema = createSchema({
                typeDefs: generationResults.typeDefs,
                resolvers: generationResults.resolvers
            });

            logger.debug("GraphQL schema created successfully");
            return schema;

        } catch (error) {
            logger.error("Failed to create GraphQL schema", { error });
            throw new Error(`Schema creation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get the current schema graph (for debugging/testing purposes).
     */
    getSchemaGraph(): SchemaGraph {
        return this.schemaGraph;
    }

    /**
     * Clear the orchestrator state for reuse.
     */
    clear(): void {
        this.schemaGraph.clear();
        logger.debug("Orchestrator state cleared");
    }
}