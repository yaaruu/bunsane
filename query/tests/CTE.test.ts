import { describe, it, expect, beforeEach } from 'bun:test';
import { CTENode } from '../CTENode';
import { QueryContext } from '../QueryContext';
import ComponentRegistry from '../../core/ComponentRegistry';
import { BaseComponent, CompData, Component } from '../../core/Components';

// Mock components for testing
@Component
class TestComponent1 extends BaseComponent {
    @CompData()
    field1!: string;
}

@Component
class TestComponent2 extends BaseComponent {
    @CompData()
    field2!: number;
}

describe('CTENode', () => {
    let context: QueryContext;

    beforeEach(async () => {
        // Ensure components are registered
        await ComponentRegistry.ensureComponentsRegistered();

        context = new QueryContext();
        // Add component IDs to context
        const comp1Id = context.getComponentId(TestComponent1);
        const comp2Id = context.getComponentId(TestComponent2);
        if (comp1Id) context.componentIds.add(comp1Id);
        if (comp2Id) context.componentIds.add(comp2Id);
    });

    it('should generate CTE SQL for multiple components', () => {
        const cteNode = new CTENode();
        const result = cteNode.execute(context);

        expect(result.sql).toContain('WITH base_entities AS');
        expect(result.sql).toContain('SELECT DISTINCT ec.entity_id');
        expect(result.sql).toContain('FROM entity_components ec');
        expect(result.sql).toContain('WHERE ec.type_id IN');
        expect(result.sql).toContain('ec.deleted_at IS NULL');

        // Check that CTE metadata is set
        expect(context.hasCTE).toBe(true);
        expect(context.cteName).toBe('base_entities');
    });

    it('should include component type parameters in CTE', () => {
        const cteNode = new CTENode();
        const result = cteNode.execute(context);

        // Should have parameters for component type IDs
        expect(result.params.length).toBeGreaterThan(0);
        expect(result.sql).toMatch(/\$[0-9]+/); // Should contain parameter placeholders
    });

    it('should handle excluded component types', () => {
        const excludedCompId = context.getComponentId(TestComponent1);
        if (excludedCompId) {
            context.excludedComponentIds.add(excludedCompId);
        }

        const cteNode = new CTENode();
        const result = cteNode.execute(context);

        expect(result.sql).toContain('NOT EXISTS');
        expect(result.sql).toContain('ec_ex.type_id IN');
    });

    it('should handle excluded entity IDs', () => {
        context.excludedEntityIds.add('test-entity-id');

        const cteNode = new CTENode();
        const result = cteNode.execute(context);

        expect(result.sql).toContain('ec.entity_id NOT IN');
    });

    it('should throw error when no components are specified', () => {
        const emptyContext = new QueryContext();

        const cteNode = new CTENode();
        expect(() => cteNode.execute(emptyContext)).toThrow('CTENode requires at least one component type');
    });

    it('should return correct node type', () => {
        const cteNode = new CTENode();
        expect(cteNode.getNodeType()).toBe('CTENode');
    });
});