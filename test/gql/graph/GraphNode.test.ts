import {
    GraphNode,
    TypeNode,
    OperationNode,
    FieldNode,
    InputNode,
    ScalarNode,
    NodeType,
    GraphQLTypeKind,
    OperationType
} from '../../../gql/graph/GraphNode';

describe('GraphNode Classes', () => {
    describe('GraphNode Base Class', () => {
        it('should create a node with basic properties', () => {
            const node = new (class extends GraphNode {
                getDescription(): string {
                    return 'Test node';
                }
            })('test-id', NodeType.TYPE, { custom: 'data' }, ['dep1', 'dep2']);

            expect(node.id).toBe('test-id');
            expect(node.nodeType).toBe(NodeType.TYPE);
            expect(node.metadata).toEqual({ custom: 'data' });
            expect(node.dependencies).toEqual(['dep1', 'dep2']);
        });

        it('should check dependencies correctly', () => {
            const node = new (class extends GraphNode {
                getDescription(): string {
                    return 'Test node';
                }
            })('test-id', NodeType.TYPE, {}, ['dep1', 'dep2']);

            expect(node.dependsOn('dep1')).toBe(true);
            expect(node.dependsOn('dep3')).toBe(false);
        });

        it('should add and remove dependencies', () => {
            const node = new (class extends GraphNode {
                getDescription(): string {
                    return 'Test node';
                }
            })('test-id', NodeType.TYPE);

            node.addDependency('dep1');
            expect(node.dependencies).toEqual(['dep1']);

            node.addDependency('dep1'); // Duplicate should be ignored
            expect(node.dependencies).toEqual(['dep1']);

            node.addDependency('dep2');
            expect(node.dependencies).toEqual(['dep1', 'dep2']);

            node.removeDependency('dep1');
            expect(node.dependencies).toEqual(['dep2']);
        });
    });

    describe('TypeNode', () => {
        it('should create a type node', () => {
            const node = new TypeNode(
                'user-type',
                'User',
                GraphQLTypeKind.OBJECT,
                'type User { id: ID! name: String! }',
                { source: 'archetype' },
                ['id-type', 'string-type']
            );

            expect(node.id).toBe('user-type');
            expect(node.nodeType).toBe(NodeType.TYPE);
            expect(node.name).toBe('User');
            expect(node.kind).toBe(GraphQLTypeKind.OBJECT);
            expect(node.typeDef).toBe('type User { id: ID! name: String! }');
            expect(node.metadata).toEqual({ source: 'archetype' });
            expect(node.dependencies).toEqual(['id-type', 'string-type']);
        });

        it('should return correct description', () => {
            const node = new TypeNode('test', 'TestType', GraphQLTypeKind.SCALAR, 'scalar TestType');
            expect(node.getDescription()).toBe('Type TestType (SCALAR)');
        });
    });

    describe('OperationNode', () => {
        it('should create an operation node', () => {
            const node = new OperationNode(
                'get-user-query',
                'getUser',
                OperationType.QUERY,
                'getUser(id: ID!): User',
                'user-input',
                'user-type',
                { service: 'UserService' }
            );

            expect(node.id).toBe('get-user-query');
            expect(node.nodeType).toBe(NodeType.OPERATION);
            expect(node.operationType).toBe(OperationType.QUERY);
            expect(node.name).toBe('getUser');
            expect(node.fieldDef).toBe('getUser(id: ID!): User');
            expect(node.inputNodeId).toBe('user-input');
            expect(node.outputNodeId).toBe('user-type');
            expect(node.dependencies).toEqual(['user-input', 'user-type']);
        });

        it('should auto-add input/output dependencies', () => {
            const node = new OperationNode(
                'test-op',
                'createUser',
                OperationType.MUTATION,
                'createUser(input: CreateUserInput!): User',
                'create-input',
                'user-type'
            );

            expect(node.dependencies).toContain('create-input');
            expect(node.dependencies).toContain('user-type');
        });

        it('should return correct description', () => {
            const node = new OperationNode('test', 'updateUser', OperationType.MUTATION, 'updateUser: Boolean');
            expect(node.getDescription()).toBe('MUTATION operation updateUser');
        });
    });

    describe('FieldNode', () => {
        it('should create a field node', () => {
            const node = new FieldNode(
                'user-email-field',
                'User',
                'email',
                'email: String',
                { resolver: 'emailResolver' },
                ['string-type']
            );

            expect(node.id).toBe('user-email-field');
            expect(node.nodeType).toBe(NodeType.FIELD);
            expect(node.typeName).toBe('User');
            expect(node.fieldName).toBe('email');
            expect(node.fieldDef).toBe('email: String');
            expect(node.metadata).toEqual({ resolver: 'emailResolver' });
            expect(node.dependencies).toEqual(['string-type']);
        });

        it('should return correct description', () => {
            const node = new FieldNode('test', 'User', 'name', 'name: String!');
            expect(node.getDescription()).toBe('Field name on type User');
        });
    });

    describe('InputNode', () => {
        it('should create an input node', () => {
            const node = new InputNode(
                'create-user-input',
                'CreateUserInput',
                'input CreateUserInput { name: String! email: String! }',
                false,
                { zodSchema: 'CreateUserSchema' },
                ['string-type']
            );

            expect(node.id).toBe('create-user-input');
            expect(node.nodeType).toBe(NodeType.INPUT);
            expect(node.name).toBe('CreateUserInput');
            expect(node.typeDef).toBe('input CreateUserInput { name: String! email: String! }');
            expect(node.isOptional).toBe(false);
            expect(node.metadata).toEqual({ zodSchema: 'CreateUserSchema' });
            expect(node.dependencies).toEqual(['string-type']);
        });

        it('should handle optional inputs', () => {
            const node = new InputNode('optional-input', 'OptionalInput', 'input OptionalInput { data: String }', true);
            expect(node.isOptional).toBe(true);
            expect(node.getDescription()).toBe('Input type OptionalInput (optional)');
        });

        it('should return correct description', () => {
            const node = new InputNode('test', 'TestInput', 'input TestInput { value: String }');
            expect(node.getDescription()).toBe('Input type TestInput');
        });
    });

    describe('ScalarNode', () => {
        it('should create a scalar node', () => {
            const node = new ScalarNode(
                'email-scalar',
                'Email',
                { validator: 'emailValidator' }
            );

            expect(node.id).toBe('email-scalar');
            expect(node.nodeType).toBe(NodeType.SCALAR);
            expect(node.name).toBe('Email');
            expect(node.metadata).toEqual({ validator: 'emailValidator' });
            expect(node.dependencies).toEqual([]);
        });

        it('should return correct description', () => {
            const node = new ScalarNode('test', 'TestScalar');
            expect(node.getDescription()).toBe('Scalar type TestScalar');
        });
    });
});