import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";
import { ResolverBuilder } from "../builders/ResolverBuilder";
import { logger } from "../../core/Logger";

/**
 * Visitor that generates the GraphQL resolvers object.
 * Uses the ResolverBuilder from Phase 4 to construct resolver functions.
 */
export class ResolverGeneratorVisitor extends GraphVisitor {
    private resolverBuilder: ResolverBuilder;
    private services: any[];

    constructor(services: any[]) {
        super();
        this.services = services;
        this.resolverBuilder = new ResolverBuilder();
    }

    visitTypeNode(node: TypeNode): void {
        // TypeNodes don't directly create resolvers
        // Resolvers for object types are typically handled by archetypes
    }

    visitOperationNode(node: OperationNode): void {
        // Find the service instance that matches the service name
        const service = this.services.find(s => s.constructor.name === node.metadata.serviceName);
        if (!service) {
            logger.warn(`Service ${node.metadata.serviceName} not found for operation ${node.name}`);
            return;
        }

        const type = node.operationType.charAt(0).toUpperCase() + node.operationType.slice(1).toLowerCase() as "Query" | "Mutation" | "Subscription";
        logger.debug(`Creating resolver for ${type}.${node.name} with service ${node.metadata.serviceName}`);

        // Extract Zod schema from input if it's a Zod type (check for '_def' property)
        const input = node.metadata.input;
        const zodSchema = (input && typeof input === 'object' && '_def' in input) ? input as any : null;

        // Create resolver definitions for operations
        const resolverDef = {
            name: node.name,
            type: type,
            service: service, // Service instance
            propertyKey: node.metadata.propertyKey, // Method name from metadata
            zodSchema: zodSchema, // Zod schema if available
            hasInput: !!node.inputNodeId || !!zodSchema // Whether this operation has input (either InputNode or Zod schema)
        };

        this.resolverBuilder.addResolver(resolverDef);
    }

    visitFieldNode(node: FieldNode): void {
        // FieldNodes represent individual field resolvers
        // These would typically be added to the resolvers for their parent type
        // For now, we'll skip these as they're handled by archetypes
    }

    visitInputNode(node: InputNode): void {
        // InputNodes don't create resolvers
    }

    visitScalarNode(node: ScalarNode): void {
        // ScalarNodes don't create resolvers
    }

    getResults(): Record<string, Record<string, Function>> {
        return this.resolverBuilder.getResolvers();
    }

    /**
     * Get resolvers for a specific operation type
     */
    getResolversForType(type: "Query" | "Mutation" | "Subscription"): Record<string, Function> {
        return this.resolverBuilder.getResolversForType(type);
    }

    /**
     * Get statistics about generated resolvers
     */
    getStats(): { queries: number; mutations: number; subscriptions: number } {
        return this.resolverBuilder.getStats();
    }

    /**
     * Clear all resolver data
     */
    clear(): void {
        this.resolverBuilder.clear();
    }
}