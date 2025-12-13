import { describe, it, expect, beforeEach, mock } from "bun:test";
// import { ServiceScanner } from "../../gql/scanner/ServiceScanner";
import {
    SchemaGraph
} from '../../../gql/graph/SchemaGraph';
import {
    GraphNode,
    TypeNode,
    OperationNode,
    FieldNode,
    InputNode,
    ScalarNode,
    OperationType,
    GraphQLTypeKind
} from '../../../gql/graph/GraphNode';
import BaseService from "../../../service/Service";
import { ServiceScanner } from '../../../gql/scanner/ServiceScanner';

// Mock BaseArcheType for testing
class MockArcheType {
    constructor(public name: string) {}
}

// Mock service classes for testing
class MockServiceWithScalars extends BaseService {
    public static __graphqlScalarTypes = ['CustomScalar', 'AnotherScalar'];
}

class MockServiceWithObjectTypes extends BaseService {
    public static __graphqlObjectType = [
        {
            name: 'User',
            fields: {
                id: 'ID!',
                name: 'String!',
                email: 'String'
            }
        }
    ];
}

class MockServiceWithOperations extends BaseService {
    public __graphqlObjectType = [
        {
            name: 'User',
            fields: {
                id: 'ID!',
                name: 'String!',
                email: 'String'
            }
        }
    ];

    public __graphqlOperations = [
        {
            type: 'Query' as const,
            name: 'getUser',
            propertyKey: 'getUser',
            input: { id: 'ID!' },
            output: 'User'
        },
        {
            type: 'Mutation' as const,
            name: 'createUser',
            propertyKey: 'createUser',
            input: { name: 'String!', email: 'String' },
            output: 'User'
        }
    ];
}

class MockServiceWithSubscriptions extends BaseService {
    public __graphqlObjectType = [
        {
            name: 'User',
            fields: {
                id: 'ID!',
                name: 'String!',
                email: 'String'
            }
        }
    ];

    public __graphqlSubscriptions = [
        {
            name: 'userCreated',
            propertyKey: 'userCreated',
            input: null,
            output: 'User'
        }
    ];
}

class MockServiceWithFields extends BaseService {
    public __graphqlFields = [
        {
            type: 'String!',
            field: 'fullName',
            propertyKey: 'fullName'
        }
    ];
}

describe('ServiceScanner', () => {
    let graph: SchemaGraph;
    let scanner: ServiceScanner;

    beforeEach(() => {
        graph = new SchemaGraph();
        scanner = new ServiceScanner(graph);
    });

    describe('scanServices', () => {
        it('should scan multiple services', () => {
            const services = [
                new MockServiceWithScalars(),
                new MockServiceWithObjectTypes()
            ];

            scanner.scanServices(services);

            expect(graph.getStats().nodeCount).toBeGreaterThan(0);
        });
    });

    describe('extractScalarTypes', () => {
        it('should extract scalar types from service', () => {
            const service = new MockServiceWithScalars();

            scanner.extractScalarTypes(service);

            const scalars = graph.getNodesByType('SCALAR');
            expect(scalars).toHaveLength(2);

            const scalarNames = scalars.map(node => node.id);
            expect(scalarNames).toContain('CustomScalar');
            expect(scalarNames).toContain('AnotherScalar');

            // Verify node properties
            const customScalar = scalars.find(node => node.id === 'CustomScalar') as ScalarNode;
            expect(customScalar).toBeInstanceOf(ScalarNode);
            expect(customScalar.metadata.serviceName).toBe('MockServiceWithScalars');
        });

        it('should handle services without scalar types', () => {
            const service = new BaseService();

            scanner.extractScalarTypes(service);

            const scalars = graph.getNodesByType('SCALAR');
            expect(scalars).toHaveLength(0);
        });
    });

    describe('extractObjectTypes', () => {
        it('should extract object types from service', () => {
            const service = new MockServiceWithObjectTypes();

            scanner.extractObjectTypes(service);

            const types = graph.getNodesByType('TYPE');
            expect(types).toHaveLength(1);

            const userType = types[0] as TypeNode;
            expect(userType.id).toBe('User');
            expect(userType.kind).toBe(GraphQLTypeKind.OBJECT);
            expect(userType.metadata.fields).toEqual({
                id: 'ID!',
                name: 'String!',
                email: 'String'
            });
        });

        it('should handle services without object types', () => {
            const service = new BaseService();

            scanner.extractObjectTypes(service);

            const types = graph.getNodesByType('TYPE');
            expect(types).toHaveLength(0);
        });
    });

    describe('extractOperations', () => {
        it('should extract operations from service', () => {
            const service = new MockServiceWithOperations();

            scanner.scanServices([service]);

            const operations = graph.getNodesByType('OPERATION');
            expect(operations).toHaveLength(2);

            const operationNames = operations.map(node => node.id);
            expect(operationNames).toContain('getUser');
            expect(operationNames).toContain('createUser');

            // Verify operation properties
            const getUserOp = operations.find(node => node.id === 'getUser') as OperationNode;
            expect(getUserOp).toBeInstanceOf(OperationNode);
            expect(getUserOp.operationType).toBe(OperationType.QUERY);
            expect(getUserOp.metadata.input).toEqual({ id: 'ID!' });
            expect(getUserOp.metadata.output).toBe('User');
        });

        it('should add operation dependencies', () => {
            const service = new MockServiceWithOperations();

            scanner.scanServices([service]);

            const getUserOp = graph.getNode('getUser') as OperationNode;
            expect(getUserOp).toBeDefined();

            const dependencies = graph.getDependencies(getUserOp.id);
            expect(dependencies.map(d => d.id)).toContain('getUserInput'); // Input dependency
            expect(dependencies.map(d => d.id)).toContain('User'); // Output dependency
        });

        it('should handle services without operations', () => {
            const service = new BaseService();

            scanner.extractOperations(service);

            const operations = graph.getNodesByType('OPERATION');
            expect(operations).toHaveLength(0);
        });
    });

    describe('extractSubscriptions', () => {
        it('should extract subscriptions from service', () => {
            const service = new MockServiceWithSubscriptions();

            scanner.scanServices([service]);

            const subscriptions = graph.getNodesByType('OPERATION');
            const subscriptionNodes = subscriptions.filter(node => (node as OperationNode).operationType === OperationType.SUBSCRIPTION);
            expect(subscriptionNodes).toHaveLength(1);

            const userCreatedSub = subscriptionNodes[0] as OperationNode;
            expect(userCreatedSub.id).toBe('userCreated');
            expect(userCreatedSub.operationType).toBe(OperationType.SUBSCRIPTION);
            expect(userCreatedSub.metadata.output).toBe('User');
        });

        it('should add subscription dependencies', () => {
            const service = new MockServiceWithSubscriptions();

            scanner.scanServices([service]);

            const userCreatedSub = graph.getNode('userCreated') as OperationNode;
            expect(userCreatedSub).toBeDefined();

            const dependencies = graph.getDependencies(userCreatedSub.id);
            expect(dependencies.map(d => d.id)).toContain('User'); // Output dependency
        });

        it('should handle services without subscriptions', () => {
            const service = new BaseService();

            scanner.extractSubscriptions(service);

            const operations = graph.getNodesByType('OPERATION');
            const subscriptionNodes = operations.filter(node => (node as OperationNode).operationType === OperationType.SUBSCRIPTION);
            expect(subscriptionNodes).toHaveLength(0);
        });
    });

    describe('extractFields', () => {
        it('should extract fields from service', () => {
            const service = new MockServiceWithFields();

            scanner.extractFields(service);

            const fields = graph.getNodesByType('FIELD');
            expect(fields).toHaveLength(1);

            const fullNameField = fields[0] as FieldNode;
            expect(fullNameField.id).toBe('fullName');
            expect(fullNameField.fieldDef).toBe('String!');
        });

        it('should handle services without fields', () => {
            const service = new BaseService();

            scanner.extractFields(service);

            const fields = graph.getNodesByType('FIELD');
            expect(fields).toHaveLength(0);
        });
    });

    describe('extractTypeNameFromInput', () => {
        it('should extract type name from string input', () => {
            const scanner = new ServiceScanner(graph);
            const result = (scanner as any).extractTypeNameFromInput('UserInput', 'testOp');
            expect(result).toBe('UserInput');
        });

        it('should extract type name from object input', () => {
            const scanner = new ServiceScanner(graph);
            const result = (scanner as any).extractTypeNameFromInput({ name: 'String' }, 'testOp');
            expect(result).toBe('testOpInput');
        });

        it('should extract type name from Zod schema input', () => {
            const scanner = new ServiceScanner(graph);
            const mockZodSchema = { _def: {} };
            const result = (scanner as any).extractTypeNameFromInput(mockZodSchema, 'testOp');
            expect(result).toBe('testOpInput');
        });
    });

    describe('extractTypeNameFromOutput', () => {
        it('should extract type name from string output', () => {
            const scanner = new ServiceScanner(graph);
            const result = (scanner as any).extractTypeNameFromOutput('User');
            expect(result).toBe('User');
        });

        it('should extract type name from archetype instance', () => {
            const scanner = new ServiceScanner(graph);
            const mockArchetype = new MockArcheType('TestArchetype');
            const result = (scanner as any).extractTypeNameFromOutput(mockArchetype);
            expect(result).toBe('MockArcheType');
        });

        it('should extract type name from archetype array', () => {
            const scanner = new ServiceScanner(graph);
            const mockArchetypes = [new MockArcheType('TestArchetype')];
            const result = (scanner as any).extractTypeNameFromOutput(mockArchetypes);
            expect(result).toBe('MockArcheType');
        });
    });

    describe('getServiceMetadata', () => {
        it('should retrieve metadata from instance', () => {
            const service = new MockServiceWithOperations();
            const scanner = new ServiceScanner(graph);
            const result = (scanner as any).getServiceMetadata(service, '__graphqlOperations');
            expect(result).toBe(service.__graphqlOperations);
        });

        it('should retrieve metadata from prototype', () => {
            const service = new MockServiceWithScalars();
            const scanner = new ServiceScanner(graph);
            const result = (scanner as any).getServiceMetadata(service, '__graphqlScalarTypes');
            expect(result).toBe(MockServiceWithScalars.__graphqlScalarTypes);
        });

        it('should return null for missing metadata', () => {
            const service = new BaseService();
            const scanner = new ServiceScanner(graph);
            const result = (scanner as any).getServiceMetadata(service, '__nonexistent');
            expect(result).toBeNull();
        });
    });
});