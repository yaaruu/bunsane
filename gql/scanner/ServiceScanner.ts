import type BaseService from "../../service/Service";
import type { GraphQLObjectTypeMeta, GraphQLOperationMeta, GraphQLSubscriptionMeta } from "../Generator";
import { SchemaGraph } from "../graph/SchemaGraph";
import { ScalarNode, TypeNode, OperationNode, FieldNode, InputNode } from "../graph/GraphNode";
import { OperationType, GraphQLTypeKind } from "../graph/GraphNode";

/**
 * ServiceScanner extracts GraphQL metadata from services and converts it into graph nodes.
 * This class is responsible for scanning service instances and their prototypes to collect
 * all GraphQL-related metadata and create corresponding nodes in the schema graph.
 */
export class ServiceScanner {
    private graph: SchemaGraph;

    constructor(graph: SchemaGraph) {
        this.graph = graph;
    }

    /**
     * Scans all provided services and extracts their GraphQL metadata into graph nodes.
     * @param services Array of service instances to scan
     */
    public scanServices(services: BaseService[]): void {
        for (const service of services) {
            this.scanService(service);
        }
    }

    /**
     * Scans a single service instance for GraphQL metadata.
     * @param service The service instance to scan
     */
    private scanService(service: BaseService): void {
        // Extract scalar types
        this.extractScalarTypes(service);

        // Extract object types
        this.extractObjectTypes(service);

        // Extract operations (queries/mutations)
        this.extractOperations(service);

        // Extract subscriptions
        this.extractSubscriptions(service);

        // Extract fields
        this.extractFields(service);
    }

    /**
     * Extracts scalar type definitions from a service.
     * @param service The service to extract scalar types from
     */
    public extractScalarTypes(service: BaseService): void {
        const scalarTypes = this.getServiceMetadata(service, '__graphqlScalarTypes') as string[];
        if (!scalarTypes) return;

        for (const scalarName of scalarTypes) {
            const scalarNode = new ScalarNode(scalarName, scalarName, {
                serviceName: service.constructor.name,
                description: `Scalar type defined in ${service.constructor.name}`
            });
            this.graph.addNode(scalarNode);
        }
    }

    /**
     * Extracts object type definitions from a service.
     * @param service The service to extract object types from
     */
    public extractObjectTypes(service: BaseService): void {
        const objectTypes = this.getServiceMetadata(service, '__graphqlObjectType') as GraphQLObjectTypeMeta[];
        if (!objectTypes) return;

        for (const meta of objectTypes) {
            const typeNode = new TypeNode(meta.name, meta.name, GraphQLTypeKind.OBJECT, `type ${meta.name} {\n${Object.entries(meta.fields).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}`, {
                serviceName: service.constructor.name,
                fields: meta.fields,
                description: `Object type defined in ${service.constructor.name}`
            });
            this.graph.addNode(typeNode);
        }
    }

    /**
     * Extracts GraphQL operations (queries and mutations) from a service.
     * @param service The service to extract operations from
     */
    public extractOperations(service: BaseService): void {
        const operations = this.getServiceMetadata(service, '__graphqlOperations') as GraphQLOperationMeta[];
        if (!operations) return;

        for (const op of operations) {
            // Create input node if input is an object
            let inputNodeId: string | undefined;
            if (op.input && typeof op.input === 'object' && !Array.isArray(op.input)) {
                const inputTypeName = this.extractTypeNameFromInput(op.input, op.name!);
                const inputFields = Object.entries(op.input as Record<string, any>)
                    .map(([key, type]) => `  ${key}: ${type}`)
                    .join('\n');
                const inputTypeDef = `input ${inputTypeName} {\n${inputFields}\n}`;
                const inputNode = new InputNode(
                    inputTypeName,
                    inputTypeName,
                    inputTypeDef,
                    false,
                    {
                        serviceName: service.constructor.name,
                        operationName: op.name,
                        description: `Input type for ${op.name} operation`
                    }
                );
                this.graph.addNode(inputNode);
                inputNodeId = inputTypeName;
            }

            const operationType = op.type.toLowerCase() === 'query' ? OperationType.QUERY : OperationType.MUTATION;
            const operationNode = new OperationNode(
                op.name!,
                op.name!,
                operationType,
                `${op.name}: String`, // Placeholder field definition
                inputNodeId,
                undefined, // outputNodeId
                {
                    serviceName: service.constructor.name,
                    propertyKey: op.propertyKey,
                    input: op.input,
                    output: op.output,
                    description: `${op.type} operation defined in ${service.constructor.name}`
                }
            );
            this.graph.addNode(operationNode);

            // Add dependencies: operation depends on input and output types
            this.addOperationDependencies(operationNode, op);
        }
    }

    /**
     * Extracts GraphQL subscriptions from a service.
     * @param service The service to extract subscriptions from
     */
    public extractSubscriptions(service: BaseService): void {
        const subscriptions = this.getServiceMetadata(service, '__graphqlSubscriptions') as GraphQLSubscriptionMeta[];
        if (!subscriptions) return;

        for (const sub of subscriptions) {
            const subscriptionNode = new OperationNode(
                sub.name!,
                sub.name!,
                OperationType.SUBSCRIPTION,
                `${sub.name}: String`, // Placeholder field definition
                undefined, // inputNodeId
                undefined, // outputNodeId
                {
                    serviceName: service.constructor.name,
                    propertyKey: sub.propertyKey,
                    input: sub.input,
                    output: sub.output,
                    description: `Subscription defined in ${service.constructor.name}`
                }
            );
            this.graph.addNode(subscriptionNode);

            // Add dependencies: subscription depends on input and output types
            this.addSubscriptionDependencies(subscriptionNode, sub);
        }
    }

    /**
     * Extracts GraphQL field definitions from a service.
     * @param service The service to extract fields from
     */
    public extractFields(service: BaseService): void {
        const fields = this.getServiceMetadata(service, '__graphqlFields') as any[];
        if (!fields) return;

        for (const field of fields) {
            const fieldNode = new FieldNode(
                field.field,
                'unknown', // typeName - we don't know the parent type yet
                field.field,
                field.type,
                {
                    serviceName: service.constructor.name,
                    propertyKey: field.propertyKey,
                    description: `Field defined in ${service.constructor.name}`
                }
            );
            this.graph.addNode(fieldNode);
        }
    }

    /**
     * Adds dependency edges for an operation node based on its input and output types.
     * @param operationNode The operation node to add dependencies for
     * @param operationMeta The operation metadata
     */
    private addOperationDependencies(operationNode: OperationNode, operationMeta: GraphQLOperationMeta): void {
        // Add dependency on input type if it exists
        if (operationMeta.input) {
            const inputTypeName = this.extractTypeNameFromInput(operationMeta.input, operationMeta.name!);
            if (inputTypeName) {
                this.graph.addDependency(operationNode.id, inputTypeName);
            }
        }

        // Add dependency on output type
        const outputTypeName = this.extractTypeNameFromOutput(operationMeta.output);
        if (outputTypeName) {
            this.graph.addDependency(operationNode.id, outputTypeName);
        }
    }

    /**
     * Adds dependency edges for a subscription node based on its input and output types.
     * @param subscriptionNode The subscription node to add dependencies for
     * @param subscriptionMeta The subscription metadata
     */
    private addSubscriptionDependencies(subscriptionNode: OperationNode, subscriptionMeta: GraphQLSubscriptionMeta): void {
        // Add dependency on input type if it exists
        if (subscriptionMeta.input) {
            const inputTypeName = this.extractTypeNameFromInput(subscriptionMeta.input, subscriptionMeta.name!);
            if (inputTypeName) {
                this.graph.addDependency(subscriptionNode.id, inputTypeName);
            }
        }

        // Add dependency on output type
        const outputTypeName = this.extractTypeNameFromOutput(subscriptionMeta.output);
        if (outputTypeName) {
            this.graph.addDependency(subscriptionNode.id, outputTypeName);
        }
    }

    /**
     * Extracts a type name from operation input metadata.
     * @param input The input metadata
     * @param operationName The operation name for naming derived types
     * @returns The type name or null if not found
     */
    private extractTypeNameFromInput(input: any, operationName: string): string | null {
        if (typeof input === 'string') {
            return input;
        }

        // For Zod schemas, generate input type name
        if (input && typeof input === 'object' && '_def' in input) {
            return `${operationName}Input`;
        }

        // For object inputs, use operation name
        if (typeof input === 'object') {
            return `${operationName}Input`;
        }

        return null;
    }

    /**
     * Extracts a type name from operation output metadata.
     * @param output The output metadata
     * @returns The type name or null if not found
     */
    private extractTypeNameFromOutput(output: any): string | null {
        if (typeof output === 'string') {
            return output;
        }

        // Handle arrays of archetypes first
        if (Array.isArray(output) && output.length > 0) {
            const firstItem = output[0];
            if (firstItem && typeof firstItem === 'object' && firstItem.constructor) {
                const constructorName = firstItem.constructor.name;
                if (constructorName && constructorName !== 'Object') {
                    return constructorName;
                }
            }
        }

        // Handle BaseArcheType instances
        if (output && typeof output === 'object' && output.constructor) {
            const constructorName = output.constructor.name;
            if (constructorName && constructorName !== 'Object') {
                return constructorName;
            }
        }

        return null;
    }

    /**
     * Retrieves metadata from a service instance or its prototype chain.
     * @param service The service instance
     * @param key The metadata key to retrieve
     * @returns The metadata value or null if not found
     */
    private getServiceMetadata(service: BaseService, key: string): any {
        // Check instance first
        if (service[key as keyof BaseService]) {
            return service[key as keyof BaseService];
        }

        // Check prototype
        const prototype = service.constructor.prototype;
        if (prototype && prototype[key]) {
            return prototype[key];
        }

        // Check constructor
        if (service.constructor[key as keyof typeof service.constructor]) {
            return service.constructor[key as keyof typeof service.constructor];
        }

        return null;
    }
}