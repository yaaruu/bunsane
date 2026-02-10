import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
    t,
    isSchemaInput,
    validateInput,
    SchemaValidationError,
    collectNestedTypeDefs,
} from '../../../gql/schema';
import type { SchemaType } from '../../../gql/schema';
import { SchemaGraph } from '../../../gql/graph/SchemaGraph';
import { OperationNode, OperationType, NodeType } from '../../../gql/graph/GraphNode';
import { ServiceScanner } from '../../../gql/scanner/ServiceScanner';
import { SchemaGeneratorVisitor } from '../../../gql/visitors/SchemaGeneratorVisitor';

// ---------------------------------------------------------------------------
// 1. validateInput - success
// ---------------------------------------------------------------------------

describe('validateInput - success', () => {
    test('validates a simple scalar input', () => {
        const schema = {
            name: t.string().required(),
            age: t.int(),
        };
        const result = validateInput(schema, { name: 'Alice', age: 30 }, 'createUser');
        expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    test('allows missing optional fields', () => {
        const schema = {
            name: t.string().required(),
            bio: t.string(),
        };
        const result = validateInput(schema, { name: 'Bob' }, 'createUser');
        expect(result.name).toBe('Bob');
        expect(result.bio).toBeUndefined();
    });

    test('validates nested object input', () => {
        const schema = {
            user: t.object({
                name: t.string().required(),
                email: t.string().email().required(),
            }, 'UserInput').required(),
        };
        const result = validateInput(schema, {
            user: { name: 'Carol', email: 'carol@example.com' },
        }, 'register');
        expect((result as any).user.name).toBe('Carol');
    });

    test('validates list input', () => {
        const schema = {
            ids: t.list(t.id().required()).required().minItems(1),
        };
        const result = validateInput(schema, { ids: ['a', 'b'] }, 'batchGet');
        expect(result.ids).toEqual(['a', 'b']);
    });

    test('validates enum input', () => {
        const schema = {
            status: t.enum(['ACTIVE', 'INACTIVE'] as const, 'Status').required(),
        };
        const result = validateInput(schema, { status: 'ACTIVE' }, 'setStatus');
        expect(result.status).toBe('ACTIVE');
    });
});

// ---------------------------------------------------------------------------
// 2. validateInput - errors with field paths
// ---------------------------------------------------------------------------

describe('validateInput - error paths', () => {
    test('throws SchemaValidationError on invalid data', () => {
        const schema = {
            email: t.string().email().required(),
        };
        expect(() => validateInput(schema, { email: 'not-email' }, 'createUser'))
            .toThrow(SchemaValidationError);
    });

    test('error contains operation name in message', () => {
        const schema = {
            email: t.string().email().required(),
        };
        try {
            validateInput(schema, { email: 'bad' }, 'createUser');
        } catch (e) {
            expect(e).toBeInstanceOf(SchemaValidationError);
            expect((e as Error).message).toContain('createUser');
        }
    });

    test('error contains field path', () => {
        const schema = {
            email: t.string().email().required(),
            age: t.int().min(0).required(),
        };
        try {
            validateInput(schema, { email: 'bad', age: -1 }, 'createUser');
        } catch (e) {
            const err = e as SchemaValidationError;
            expect(err.fieldErrors.length).toBeGreaterThanOrEqual(1);
            const paths = err.fieldErrors.map(f => f.path);
            expect(paths.some(p => p === 'email' || p === 'age')).toBe(true);
        }
    });

    test('error for missing required field includes path', () => {
        const schema = {
            name: t.string().required(),
        };
        try {
            validateInput(schema, {}, 'createUser');
        } catch (e) {
            const err = e as SchemaValidationError;
            expect(err.fieldErrors.length).toBeGreaterThanOrEqual(1);
        }
    });

    test('error for nested object includes dotted path', () => {
        const schema = {
            address: t.object({
                city: t.string().required(),
            }, 'AddressInput').required(),
        };
        try {
            validateInput(schema, { address: {} }, 'createUser');
        } catch (e) {
            const err = e as SchemaValidationError;
            const paths = err.fieldErrors.map(f => f.path);
            expect(paths.some(p => p.includes('city'))).toBe(true);
        }
    });

    test('fieldErrors has path and message properties', () => {
        const schema = { x: t.int().min(10).required() };
        try {
            validateInput(schema, { x: 1 }, 'op');
        } catch (e) {
            const err = e as SchemaValidationError;
            for (const fe of err.fieldErrors) {
                expect(typeof fe.path).toBe('string');
                expect(typeof fe.message).toBe('string');
            }
        }
    });
});

// ---------------------------------------------------------------------------
// 3. ServiceScanner - Schema DSL detection
// ---------------------------------------------------------------------------

describe('ServiceScanner - Schema DSL detection', () => {
    test('Schema DSL input does not create an InputNode', () => {
        const graph = new SchemaGraph();
        const scanner = new ServiceScanner(graph);

        const mockService = {
            constructor: { name: 'TestService', prototype: {} },
            __graphqlOperations: [{
                type: 'Query',
                name: 'getUser',
                propertyKey: 'getUser',
                input: {
                    id: t.id().required(),
                    includeDeleted: t.boolean(),
                },
                output: 'User',
            }],
        } as any;

        scanner.extractOperations(mockService);

        // Should have created an OperationNode
        const opNode = graph.getNode('getUser');
        expect(opNode).toBeDefined();
        expect(opNode!.nodeType).toBe(NodeType.OPERATION);

        // Should NOT have created an InputNode (Schema DSL inputs are handled by the visitor)
        const allNodes = graph.getAllNodes();
        const inputNodes = allNodes.filter(n => n.nodeType === NodeType.INPUT);
        expect(inputNodes.length).toBe(0);
    });

    test('plain Record input still creates an InputNode', () => {
        const graph = new SchemaGraph();
        const scanner = new ServiceScanner(graph);

        const mockService = {
            constructor: { name: 'TestService', prototype: {} },
            __graphqlOperations: [{
                type: 'Mutation',
                name: 'setName',
                propertyKey: 'setName',
                input: { name: 'String!' },
                output: 'Boolean',
            }],
        } as any;

        scanner.extractOperations(mockService);

        const inputNodes = graph.getAllNodes().filter(n => n.nodeType === NodeType.INPUT);
        expect(inputNodes.length).toBe(1);
    });

    test('Zod schema input does not create an InputNode', () => {
        const graph = new SchemaGraph();
        const scanner = new ServiceScanner(graph);

        const mockService = {
            constructor: { name: 'TestService', prototype: {} },
            __graphqlOperations: [{
                type: 'Query',
                name: 'search',
                propertyKey: 'search',
                input: z.object({ q: z.string() }),
                output: 'String',
            }],
        } as any;

        scanner.extractOperations(mockService);

        const inputNodes = graph.getAllNodes().filter(n => n.nodeType === NodeType.INPUT);
        expect(inputNodes.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 4. SchemaGeneratorVisitor - SDL generation from Schema DSL
// ---------------------------------------------------------------------------

describe('SchemaGeneratorVisitor - Schema DSL SDL', () => {
    function createVisitorAndVisitOperation(
        name: string,
        operationType: OperationType,
        input: Record<string, SchemaType>,
        output: string = 'String',
    ): string {
        const visitor = new SchemaGeneratorVisitor();

        const opNode = new OperationNode(
            name,
            name,
            operationType,
            `${name}: String`,
            undefined,
            undefined,
            {
                input,
                output,
                scalarTypes: new Set<string>(),
            },
        );

        visitor.visitOperationNode(opNode);
        return visitor.getTypeDefs();
    }

    test('generates correct SDL for scalar inputs', () => {
        const sdl = createVisitorAndVisitOperation('getUser', OperationType.QUERY, {
            id: t.id().required(),
            includeDeleted: t.boolean(),
        });

        expect(sdl).toContain('input getUserInput {');
        expect(sdl).toContain('id: ID!');
        expect(sdl).toContain('includeDeleted: Boolean');
        expect(sdl).toContain('getUser(input: getUserInput!): String');
    });

    test('generates correct SDL for nested object inputs', () => {
        const sdl = createVisitorAndVisitOperation('register', OperationType.MUTATION, {
            user: t.object({
                name: t.string().required(),
                email: t.string().email().required(),
            }, 'UserInput').required(),
            settings: t.object({
                theme: t.enum(['light', 'dark'] as const, 'Theme'),
                notifications: t.boolean(),
            }, 'SettingsInput'),
        });

        expect(sdl).toContain('input UserInput {');
        expect(sdl).toContain('name: String!');
        expect(sdl).toContain('email: String!');
        expect(sdl).toContain('enum Theme {');
        expect(sdl).toContain('light');
        expect(sdl).toContain('dark');
        expect(sdl).toContain('input SettingsInput {');
        expect(sdl).toContain('theme: Theme');
        expect(sdl).toContain('notifications: Boolean');
        expect(sdl).toContain('input registerInput {');
        expect(sdl).toContain('user: UserInput!');
        expect(sdl).toContain('settings: SettingsInput');
    });

    test('generates correct SDL for list inputs', () => {
        const sdl = createVisitorAndVisitOperation('batchOp', OperationType.MUTATION, {
            userIds: t.list(t.id().required()).required(),
            tags: t.list(t.string()),
        });

        expect(sdl).toContain('input batchOpInput {');
        expect(sdl).toContain('userIds: [ID!]!');
        expect(sdl).toContain('tags: [String]');
    });

    test('generates correct SDL for enum inputs', () => {
        const sdl = createVisitorAndVisitOperation('filter', OperationType.QUERY, {
            status: t.enum(['ACTIVE', 'INACTIVE', 'PENDING'] as const, 'Status').required(),
        });

        expect(sdl).toContain('enum Status {');
        expect(sdl).toContain('ACTIVE');
        expect(sdl).toContain('INACTIVE');
        expect(sdl).toContain('PENDING');
        expect(sdl).toContain('input filterInput {');
        expect(sdl).toContain('status: Status!');
    });

    test('generates correct SDL for ref inputs', () => {
        const sdl = createVisitorAndVisitOperation('getOrders', OperationType.QUERY, {
            from: t.ref<Date>('DateTime', z.date()).required(),
            status: t.ref<string>('OrderStatus'),
        });

        expect(sdl).toContain('input getOrdersInput {');
        expect(sdl).toContain('from: DateTime!');
        expect(sdl).toContain('status: OrderStatus');
    });

    test('generates correct SDL for deeply nested objects', () => {
        const sdl = createVisitorAndVisitOperation('createComplex', OperationType.MUTATION, {
            data: t.object({
                location: t.object({
                    lat: t.float().required(),
                    lng: t.float().required(),
                }, 'CoordInput').required(),
                tags: t.list(t.string().required()),
            }, 'DataInput').required(),
        });

        expect(sdl).toContain('input CoordInput {');
        expect(sdl).toContain('lat: Float!');
        expect(sdl).toContain('lng: Float!');
        expect(sdl).toContain('input DataInput {');
        expect(sdl).toContain('location: CoordInput!');
        expect(sdl).toContain('tags: [String!]');
        expect(sdl).toContain('input createComplexInput {');
        expect(sdl).toContain('data: DataInput!');
    });

    test('deduplicates shared nested types', () => {
        const Shared = t.object({ id: t.id().required() }, 'SharedInput');
        const sdl = createVisitorAndVisitOperation('dedup', OperationType.QUERY, {
            first: Shared.required(),
            second: Shared,
        });

        // SharedInput should appear exactly once
        const matches = sdl.match(/input SharedInput \{/g);
        expect(matches?.length).toBe(1);
    });

    test('routes query to Query type', () => {
        const sdl = createVisitorAndVisitOperation('hello', OperationType.QUERY, {
            name: t.string().required(),
        });

        expect(sdl).toContain('type Query {');
        expect(sdl).toContain('hello(input: helloInput!): String');
    });

    test('routes mutation to Mutation type', () => {
        const sdl = createVisitorAndVisitOperation('doStuff', OperationType.MUTATION, {
            x: t.int().required(),
        });

        expect(sdl).toContain('type Mutation {');
        expect(sdl).toContain('doStuff(input: doStuffInput!): String');
    });
});

// ---------------------------------------------------------------------------
// 5. End-to-end: collectNestedTypeDefs + SDL composition
// ---------------------------------------------------------------------------

describe('collectNestedTypeDefs - complex scenarios', () => {
    test('deeply nested chain of objects collects all levels', () => {
        const Level3 = t.object({ value: t.string().required() }, 'Level3');
        const Level2 = t.object({ nested: Level3.required() }, 'Level2');
        const Level1 = t.object({ child: Level2.required() }, 'Level1');

        const defs = collectNestedTypeDefs({ root: Level1 });
        const keys = Array.from(defs.keys());

        expect(keys).toEqual(['Level3', 'Level2', 'Level1']);
        expect(defs.get('Level3')).toContain('value: String!');
        expect(defs.get('Level2')).toContain('nested: Level3!');
        expect(defs.get('Level1')).toContain('child: Level2!');
    });

    test('enum inside list inside object collects all types', () => {
        const Priority = t.enum(['LOW', 'MEDIUM', 'HIGH'] as const, 'Priority');
        const Task = t.object({
            title: t.string().required(),
            priority: Priority.required(),
        }, 'TaskInput');

        const defs = collectNestedTypeDefs({
            tasks: t.list(Task.required()),
        });

        expect(defs.has('Priority')).toBe(true);
        expect(defs.has('TaskInput')).toBe(true);
        expect(defs.get('Priority')).toContain('enum Priority {');
        expect(defs.get('TaskInput')).toContain('priority: Priority!');
    });
});
