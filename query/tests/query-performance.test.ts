import { describe, it, expect, beforeEach } from 'bun:test';
import { Query } from '../Query';
import { QueryContext } from '../QueryContext';
import { ComponentInclusionNode } from '../ComponentInclusionNode';
import { SourceNode } from '../SourceNode';
import { OrNode } from '../OrNode';
import { QueryDAG } from '../QueryDAG';
import { CTENode } from '../CTENode';
import ComponentRegistry from '../../core/ComponentRegistry';
import { BaseComponent, CompData, Component } from '../../core/Components';

// Mock components for testing
@Component
class TestComponent1 extends BaseComponent {
    @CompData()
    value!: string;
}

@Component
class TestComponent2 extends BaseComponent {
    @CompData()
    value!: string;
}

describe('Query Performance Benchmarks', () => {
  let query: Query;

  beforeEach(async () => {
    // Ensure components are registered
    await ComponentRegistry.ensureComponentsRegistered();

    query = new Query();
  });

  describe('CTE Optimization Performance', () => {
    it('should use CTE for queries with multiple component filters', async () => {
      const context = new QueryContext();

      // Add component IDs to context to simulate multiple filters
      const comp1Id = context.getComponentId(TestComponent1);
      const comp2Id = context.getComponentId(TestComponent2);
      if (comp1Id) context.componentIds.add(comp1Id);
      if (comp2Id) context.componentIds.add(comp2Id);

      // Add filters to trigger CTE optimization (>= 2 filters)
      context.componentFilters.set(comp1Id!, [{ field: 'value', operator: '=', value: 'test1' }]);
      context.componentFilters.set(comp2Id!, [{ field: 'value', operator: '=', value: 'test2' }]);

      // Build basic query - this should automatically insert CTE
      const dag = QueryDAG.buildBasicQuery(context);

      // Execute the DAG to trigger CTE
      const result = dag.execute(context);

      // Verify CTE was inserted
      expect(context.hasCTE).toBe(true);
      expect(context.cteName).toBe('base_entities');
    });

    it('should not use CTE for single component filter queries', async () => {
      const context = new QueryContext(); // Fresh context

      // Add only one component ID to context
      const comp1Id = context.getComponentId(TestComponent1);
      if (comp1Id) context.componentIds.add(comp1Id);

      // Add only one filter (should not trigger CTE)
      context.componentFilters.set(comp1Id!, [{ field: 'value', operator: '=', value: 'test' }]);

      // Build basic query - this should NOT insert CTE
      const dag = QueryDAG.buildBasicQuery(context);

      // Execute the DAG
      const result = dag.execute(context);

      // Verify no CTE was used
      expect(context.hasCTE).toBe(false);
      expect(context.cteName).toBe('');
    });

    it('should generate correct CTE SQL structure', async () => {
      const context = new QueryContext();

      // Add component IDs to context
      const comp1Id = context.getComponentId(TestComponent1);
      const comp2Id = context.getComponentId(TestComponent2);
      if (comp1Id) context.componentIds.add(comp1Id);
      if (comp2Id) context.componentIds.add(comp2Id);

      const cteNode = new CTENode();
      const result = cteNode.execute(context);

      expect(result.sql).toContain('WITH base_entities AS');
      expect(result.sql).toContain('SELECT DISTINCT ec.entity_id');
      expect(result.sql).toContain('FROM entity_components ec');
      expect(result.sql).toContain('WHERE ec.type_id IN');
      expect(result.sql).toContain('ec.deleted_at IS NULL');
    });

    it('should measure query planning time improvement', async () => {
      // This is a placeholder for actual performance measurement
      // In a real scenario, we'd run queries with and without CTE
      // and measure EXPLAIN ANALYZE output

      const context = new QueryContext();

      // Add component IDs to context
      const comp1Id = context.getComponentId(TestComponent1);
      const comp2Id = context.getComponentId(TestComponent2);
      if (comp1Id) context.componentIds.add(comp1Id);
      if (comp2Id) context.componentIds.add(comp2Id);

      // Add multiple filters to trigger CTE
      context.componentFilters.set(comp1Id!, [{ field: 'value', operator: '=', value: 'test1' }]);
      context.componentFilters.set(comp2Id!, [{ field: 'value', operator: '=', value: 'test2' }]);

      const dag = QueryDAG.buildBasicQuery(context);
      const result = dag.execute(context);

      // Verify the query structure indicates CTE optimization with LATERAL joins
      expect(result.sql).toContain('WITH base_entities AS');
      expect(result.sql).toContain('CROSS JOIN LATERAL');
      expect(result.sql).toContain('base_entities.entity_id');
      expect(result.sql).toContain('AS lat_');
    });
  });

    it('should handle multiple filters on same component with CTE', async () => {
      const context = new QueryContext();

      // Add component ID to context
      const comp1Id = context.getComponentId(TestComponent1);
      if (comp1Id) context.componentIds.add(comp1Id);

      // Add multiple filters on the same component (like the monthlyUsage query)
      context.componentFilters.set(comp1Id!, [
        { field: 'account_id', operator: '=', value: 'test-uuid' },
        { field: 'date', operator: '>=', value: '2025-10-31' },
        { field: 'date', operator: '<', value: '2025-11-30' }
      ]);

      const dag = QueryDAG.buildBasicQuery(context);
      const result = dag.execute(context);

      // Verify CTE was used for multiple filters
      expect(context.hasCTE).toBe(true);
      expect(context.cteName).toBe('base_entities');
      
      // Verify SQL structure - should have WITH clause and LATERAL joins
      expect(result.sql).toContain('WITH base_entities AS');
      expect(result.sql).toContain('CROSS JOIN LATERAL');
      expect(result.sql).toContain('AS lat_');
      
      // Should have 3 LATERAL joins for the 3 filters
      const lateralCount = (result.sql.match(/CROSS JOIN LATERAL/g) || []).length;
      expect(lateralCount).toBe(3);
    });
});