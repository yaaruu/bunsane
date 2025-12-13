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
    NodeType,
    GraphQLTypeKind,
    OperationType
} from '../../../gql/graph/GraphNode';

describe('SchemaGraph', () => {
    let graph: SchemaGraph;

    beforeEach(() => {
        graph = new SchemaGraph();
    });

    describe('Node Management', () => {
        it('should add and retrieve nodes', () => {
            const typeNode = new TypeNode('user-type', 'User', GraphQLTypeKind.OBJECT, 'type User { id: ID! }');
            graph.addNode(typeNode);

            expect(graph.hasNode('user-type')).toBe(true);
            expect(graph.getNode('user-type')).toBe(typeNode);
            expect(graph.getNode('non-existent')).toBeUndefined();
        });

        it('should throw error when adding duplicate node', () => {
            const node1 = new TypeNode('test', 'Test', GraphQLTypeKind.OBJECT, 'type Test {}');
            const node2 = new TypeNode('test', 'Test2', GraphQLTypeKind.OBJECT, 'type Test2 {}');

            graph.addNode(node1);
            expect(() => graph.addNode(node2)).toThrow("Node with id 'test' already exists in graph");
        });

        it('should remove nodes', () => {
            const node = new TypeNode('test', 'Test', GraphQLTypeKind.OBJECT, 'type Test {}');
            graph.addNode(node);

            expect(graph.removeNode('test')).toBe(true);
            expect(graph.hasNode('test')).toBe(false);
            expect(graph.removeNode('non-existent')).toBe(false);
        });

        it('should get all nodes', () => {
            const node1 = new TypeNode('type1', 'Type1', GraphQLTypeKind.OBJECT, 'type Type1 {}');
            const node2 = new TypeNode('type2', 'Type2', GraphQLTypeKind.OBJECT, 'type Type2 {}');

            graph.addNode(node1);
            graph.addNode(node2);

            const allNodes = graph.getAllNodes();
            expect(allNodes).toHaveLength(2);
            expect(allNodes).toContain(node1);
            expect(allNodes).toContain(node2);
        });

        it('should get nodes by type', () => {
            const typeNode = new TypeNode('type1', 'Type1', GraphQLTypeKind.OBJECT, 'type Type1 {}');
            const opNode = new OperationNode('op1', OperationType.QUERY, 'testQuery', 'testQuery: String');
            const fieldNode = new FieldNode('field1', 'Type1', 'field', 'field: String');

            graph.addNode(typeNode);
            graph.addNode(opNode);
            graph.addNode(fieldNode);

            expect(graph.getNodesByType(NodeType.TYPE)).toEqual([typeNode]);
            expect(graph.getNodesByType(NodeType.OPERATION)).toEqual([opNode]);
            expect(graph.getNodesByType(NodeType.FIELD)).toEqual([fieldNode]);
        });
    });

    describe('Dependency Management', () => {
        it('should handle node dependencies during addNode', () => {
            const stringType = new ScalarNode('string-type', 'String');
            const userType = new TypeNode('user-type', 'User', GraphQLTypeKind.OBJECT, 'type User { name: String }', {}, ['string-type']);

            graph.addNode(stringType);
            graph.addNode(userType);

            expect(graph.getDependencies('user-type')).toEqual([stringType]);
            expect(graph.getDependents('string-type')).toEqual([userType]);
        });

        it('should add and remove dependencies dynamically', () => {
            const node1 = new TypeNode('node1', 'Node1', GraphQLTypeKind.OBJECT, 'type Node1 {}');
            const node2 = new TypeNode('node2', 'Node2', GraphQLTypeKind.OBJECT, 'type Node2 {}');

            graph.addNode(node1);
            graph.addNode(node2);

            graph.addDependency('node1', 'node2');

            expect(graph.getDependencies('node1')).toEqual([node2]);
            expect(graph.getDependents('node2')).toEqual([node1]);

            graph.removeDependency('node1', 'node2');

            expect(graph.getDependencies('node1')).toEqual([]);
            expect(graph.getDependents('node2')).toEqual([]);
        });

        it('should throw error when adding dependency to non-existent nodes', () => {
            expect(() => graph.addDependency('non-existent', 'also-non-existent')).toThrow("Source node 'non-existent' does not exist");
        });
    });

    describe('Topological Sort', () => {
        it('should sort nodes in dependency order', () => {
            // Create nodes: C depends on B, B depends on A
            const nodeA = new ScalarNode('a', 'A');
            const nodeB = new TypeNode('b', 'B', GraphQLTypeKind.OBJECT, 'type B {}', {}, ['a']);
            const nodeC = new TypeNode('c', 'C', GraphQLTypeKind.OBJECT, 'type C {}', {}, ['b']);

            graph.addNode(nodeA);
            graph.addNode(nodeB);
            graph.addNode(nodeC);

            const sorted = graph.topologicalSort();

            // A should come before B, B before C
            const aIndex = sorted.findIndex(n => n.id === 'a');
            const bIndex = sorted.findIndex(n => n.id === 'b');
            const cIndex = sorted.findIndex(n => n.id === 'c');

            expect(aIndex).toBeLessThan(bIndex);
            expect(bIndex).toBeLessThan(cIndex);
        });

        it('should detect cycles', () => {
            // Create cycle: A -> B -> C -> A
            const nodeA = new TypeNode('a', 'A', GraphQLTypeKind.OBJECT, 'type A {}', {}, ['c']);
            const nodeB = new TypeNode('b', 'B', GraphQLTypeKind.OBJECT, 'type B {}', {}, ['a']);
            const nodeC = new TypeNode('c', 'C', GraphQLTypeKind.OBJECT, 'type C {}', {}, ['b']);

            graph.addNode(nodeA);
            graph.addNode(nodeB);
            graph.addNode(nodeC);

            expect(() => graph.topologicalSort()).toThrow('Cycle detected in graph');
        });

        it('should handle independent nodes', () => {
            const node1 = new ScalarNode('scalar1', 'Scalar1');
            const node2 = new ScalarNode('scalar2', 'Scalar2');
            const node3 = new ScalarNode('scalar3', 'Scalar3');

            graph.addNode(node1);
            graph.addNode(node2);
            graph.addNode(node3);

            const sorted = graph.topologicalSort();
            expect(sorted).toHaveLength(3);
            expect(sorted.map(n => n.id).sort()).toEqual(['scalar1', 'scalar2', 'scalar3'].sort());
        });
    });

    describe('Graph Statistics and Validation', () => {
        it('should provide graph statistics', () => {
            const typeNode = new TypeNode('type1', 'Type1', GraphQLTypeKind.OBJECT, 'type Type1 {}', {}, ['scalar1']);
            const opNode = new OperationNode('op1', OperationType.QUERY, 'query1', 'query1: String', undefined, 'type1');
            const scalarNode = new ScalarNode('scalar1', 'Scalar1');

            graph.addNode(typeNode);
            graph.addNode(opNode);
            graph.addNode(scalarNode);

            const stats = graph.getStats();

            expect(stats.nodeCount).toBe(3);
            expect(stats.edgeCount).toBe(2); // type1->scalar1, op1->type1 (input is undefined, so filtered out)
            expect(stats.nodesByType[NodeType.TYPE]).toBe(1);
            expect(stats.nodesByType[NodeType.OPERATION]).toBe(1);
            expect(stats.nodesByType[NodeType.SCALAR]).toBe(1);
        });

        it('should validate graph structure', () => {
            const validNode = new ScalarNode('valid', 'Valid');
            const invalidNode = new TypeNode('invalid', 'Invalid', GraphQLTypeKind.OBJECT, 'type Invalid {}', {}, ['missing-dep']);

            graph.addNode(validNode);
            graph.addNode(invalidNode);

            const validation = graph.validate();

            expect(validation.isValid).toBe(false);
            expect(validation.errors).toContain("Node 'invalid' depends on non-existent node 'missing-dep'");
        });

        it('should validate acyclic graphs', () => {
            // Create cycle for validation test
            const nodeA = new TypeNode('a', 'A', GraphQLTypeKind.OBJECT, 'type A {}', {}, ['c']);
            const nodeB = new TypeNode('b', 'B', GraphQLTypeKind.OBJECT, 'type B {}', {}, ['a']);
            const nodeC = new TypeNode('c', 'C', GraphQLTypeKind.OBJECT, 'type C {}', {}, ['b']);

            graph.addNode(nodeA);
            graph.addNode(nodeB);
            graph.addNode(nodeC);

            const validation = graph.validate();

            expect(validation.isValid).toBe(false);
            expect(validation.errors.some(error => error.includes('Cycle detected'))).toBe(true);
        });
    });

    describe('Utility Methods', () => {
        it('should clear the graph', () => {
            const node = new TypeNode('test', 'Test', GraphQLTypeKind.OBJECT, 'type Test {}');
            graph.addNode(node);

            expect(graph.getAllNodes()).toHaveLength(1);

            graph.clear();

            expect(graph.getAllNodes()).toHaveLength(0);
            expect(graph.hasNode('test')).toBe(false);
        });

        it('should get nodes in dependency order', () => {
            // Same test as topological sort
            const nodeA = new ScalarNode('a', 'A');
            const nodeB = new TypeNode('b', 'B', GraphQLTypeKind.OBJECT, 'type B {}', {}, ['a']);

            graph.addNode(nodeA);
            graph.addNode(nodeB);

            const ordered = graph.getNodesInDependencyOrder();

            expect(ordered[0].id).toBe('a'); // A comes first
            expect(ordered[1].id).toBe('b'); // B depends on A
        });
    });
});