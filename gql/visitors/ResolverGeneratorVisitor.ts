import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";
import { ResolverBuilder } from "../builders/ResolverBuilder";
import { isSchemaInput } from "../schema";
import * as z from "zod";
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
        
        // Add Date scalar resolver
        this.resolverBuilder.addScalarResolver('Date', {
            serialize: (value: any) => {
                if (value instanceof Date) {
                    return value.toISOString();
                }
                return value;
            },
            parseValue: (value: any) => {
                if (typeof value === 'string') {
                    return new Date(value);
                }
                return value;
            },
            parseLiteral: (ast: any) => {
                if (ast.kind === 'StringValue') {
                    return new Date(ast.value);
                }
                return null;
            }
        });
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

        // Extract Zod schema from input. If it's already a Zod type (`_def`),
        // use directly. If it's a Schema DSL input (`t.` API), convert each
        // field `.toZod()` into a Zod object so the resolver validates it
        // instead of passing raw args through (H-GQL-4).
        const input = node.metadata.input;
        let zodSchema: any = null;
        if (input && typeof input === 'object' && '_def' in input) {
            zodSchema = input;
        } else if (isSchemaInput(input)) {
            const zodShape: Record<string, z.ZodType> = {};
            for (const [key, field] of Object.entries(input)) {
                zodShape[key] = (field as any).toZod();
            }
            zodSchema = z.object(zodShape);
        }

        // Create resolver definitions for operations
        const resolverDef = {
            name: node.name,
            type: type,
            service: service, // Service instance
            propertyKey: node.metadata.propertyKey, // Method name from metadata
            zodSchema: zodSchema, // Zod schema if available
            hasInput: !!node.inputNodeId || !!zodSchema || !!input // Whether this operation has input (InputNode, Zod schema, or raw GraphQL input definition)
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
        const resolvers = this.resolverBuilder.getResolvers();

        // Ensure there's always at least one Query resolver for GraphQL schema validity
        if (!resolvers.Query) {
            resolvers.Query = {};
        }
        if (Object.keys(resolvers.Query).length === 0) {
            resolvers.Query._empty = () => null;
        }

        return resolvers;
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