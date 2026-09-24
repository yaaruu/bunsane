import { GraphQLSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import { logger } from "../../core/Logger";
import { getMetadataStorage } from "../../core/metadata";
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
            logger.debug("Starting GraphQL schema generation with orchestrator");

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

            logger.debug("GraphQL schema generation completed successfully");
            return schema;

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to generate GraphQL schema: ${message}`);
            throw new Error(`Schema generation failed: ${message}`, { cause: error });
        }
    }

    /**
     * Phase 1: Build the schema graph from service instances using the ServiceScanner.
     */
    private buildGraphFromServices(services: any[]): void {

        // Clear any existing nodes
        this.schemaGraph.clear();

        // Scan all services - this adds nodes directly to the graph
        this.serviceScanner.scanServices(services);
    }

    /**
     * Phase 2: Run preprocessing visitors to prepare the graph for generation.
     */
    private runPreprocessingVisitors(): void {

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

        
    }

    /**
     * Phase 3: Run generation visitors to produce typeDefs and resolvers.
     */
    private runGenerationVisitors(): {
        typeDefs: string;
        resolvers: Record<string, any>;
    } {

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

        this.addFieldResolvers(resolverResults);
        this.attachArchetypeFieldResolvers(resolverResults);

        // Filter out empty resolver types to avoid schema validation errors
        const filteredResolvers: Record<string, any> = {};
        for (const [type, typeResolvers] of Object.entries(resolverResults || {})) {
            if (typeResolvers && Object.keys(typeResolvers).length > 0) {
                filteredResolvers[type] = typeResolvers;
            }
        }

        

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
                if (!resolvers[type]) {
                    resolvers[type] = {};
                }
                if (resolvers[type][field]) continue;

                resolvers[type][field] = async (parent: unknown, args: unknown, context: unknown, info: unknown) => {
                    try {
                        return await service[propertyKey](parent, args, context, info);
                    } catch (error) {
                        logger.error(`Error in field resolver ${type}.${field}: ${error instanceof Error ? error.message : String(error)}`);
                        throw error;
                    }
                };
            }
        }
    }

    /**
     * Install archetype component, relation, and @ArcheTypeFunction resolvers.
     * Skips fields already registered (registerFieldResolvers or @GraphQLField)
     * so a service constructor call cannot double-register them.
     */
    private attachArchetypeFieldResolvers(resolvers: Record<string, unknown>): void {
        const storage = getMetadataStorage();
        for (const meta of storage.archetypes) {
            if (typeof meta.target !== "function") continue;
            const instance = new (meta.target as new () => object)();
            if (!("generateFieldResolvers" in instance) || typeof instance.generateFieldResolvers !== "function") continue;
            const entries = instance.generateFieldResolvers() as Array<{ typeName: string; fieldName: string; resolver: unknown }>;
            for (const { typeName, fieldName, resolver } of entries) {
                const typeResolvers = resolvers[typeName];
                const bucket = typeResolvers && typeof typeResolvers === "object"
                    ? typeResolvers as Record<string, unknown>
                    : {};
                if (!typeResolvers) resolvers[typeName] = bucket;
                if (bucket[fieldName]) continue;
                bucket[fieldName] = resolver;
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

    }

    /**
     * Phase 5: Create the final GraphQL schema using the generated typeDefs and resolvers.
     */
    private createGraphQLSchema(generationResults: {
        typeDefs: string;
        resolvers: Record<string, any>;
    }): GraphQLSchema | null {
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

            return schema;

        } catch (error) {
            logger.error({ error }, "Failed to create GraphQL schema");
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Schema creation failed: ${message}`, { cause: error });
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
    }
}