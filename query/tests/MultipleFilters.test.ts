import { describe, it, expect, beforeEach } from 'bun:test';
import { ComponentInclusionNode } from '../ComponentInclusionNode';
import { QueryContext } from '../QueryContext';
import { CTENode } from '../CTENode';

describe('ComponentInclusionNode - Multiple Filters on Same Component', () => {
    let context: QueryContext;

    beforeEach(() => {
        context = new QueryContext();
    });

    it('should correctly place WHERE conditions with CTE and LATERAL joins for multiple filters', () => {
        // Simulate the GoogleMapAccountQuota query scenario
        const componentId = "d3b0e253d8e48e78d700b05416d50d54915ad5e9af909afe3364a05aa3f1029e";
        context.componentIds.add(componentId);

        // Add filters: account_id = X, date >= Y, date < Z
        context.componentFilters.set(componentId, [
            { field: 'account_id', operator: '=', value: '019a8839-dc72-7644-894e-fc005d1a62c3' },
            { field: 'date', operator: '>=', value: '2025-10-31' },
            { field: 'date', operator: '<', value: '2025-11-30' }
        ]);

        // First execute CTE node to set up base_entities
        const cteNode = new CTENode();
        cteNode.execute(context);

        // Then execute ComponentInclusionNode with LATERAL joins
        const inclusionNode = new ComponentInclusionNode();
        const result = inclusionNode.execute(context);

        // Verify SQL structure (ComponentInclusionNode doesn't include CTE, that's added by QueryDAG)
        expect(result.sql).toContain('CROSS JOIN LATERAL');
        expect(result.sql).toContain('base_entities.entity_id');

        // Critical: Verify WHERE clause comes BEFORE ORDER BY
        const whereIndex = result.sql.indexOf(' WHERE ');
        const orderByIndex = result.sql.indexOf(' ORDER BY');
        
        if (whereIndex !== -1 && orderByIndex !== -1) {
            expect(whereIndex).toBeLessThan(orderByIndex);
        }

        // Verify no syntax errors in generated SQL structure
        // Should have: SELECT ... FROM ... LATERAL ... WHERE ... ORDER BY
        expect(result.sql).toMatch(/SELECT DISTINCT base_entities\.entity_id as id FROM base_entities/);
        expect(result.sql).toMatch(/CROSS JOIN LATERAL[\s\S]*WHERE[\s\S]*ORDER BY/);
        
        // Verify all LATERAL conditions are present in WHERE clause
        expect(result.sql).toContain('lat_d3b0e253_account_id_0 IS NOT NULL');
        expect(result.sql).toContain('lat_d3b0e253_date_1 IS NOT NULL');
        expect(result.sql).toContain('lat_d3b0e253_date_2 IS NOT NULL');

        // Verify the structure doesn't have WHERE/AND after ORDER BY
        const afterOrderBy = result.sql.substring(orderByIndex);
        expect(afterOrderBy).not.toContain(' WHERE ');
        expect(afterOrderBy).not.toMatch(/^\s*ORDER BY[\s\S]*\bAND\b/);
    });

    it('should handle WHERE clause insertion when no existing WHERE exists', () => {
        const componentId = "test-component-id";
        context.componentIds.add(componentId);

        context.componentFilters.set(componentId, [
            { field: 'field1', operator: '=', value: 'value1' },
            { field: 'field2', operator: '>', value: 10 }
        ]);

        // Execute with CTE
        const cteNode = new CTENode();
        cteNode.execute(context);

        const inclusionNode = new ComponentInclusionNode();
        const result = inclusionNode.execute(context);

        // Should have WHERE keyword (not AND) since no WHERE existed before
        expect(result.sql).toMatch(/\bWHERE\b[\s\S]*lat_.*IS NOT NULL/);
    });

    it('should handle WHERE clause insertion when existing WHERE clause is present', () => {
        const componentId = "test-component-id";
        context.componentIds.add(componentId);
        context.withId = "specific-entity-id"; // This adds a WHERE clause

        context.componentFilters.set(componentId, [
            { field: 'field1', operator: '=', value: 'value1' }
        ]);

        // Execute with CTE
        const cteNode = new CTENode();
        cteNode.execute(context);

        const inclusionNode = new ComponentInclusionNode();
        const result = inclusionNode.execute(context);

        // Should use AND keyword since WHERE already exists
        expect(result.sql).toMatch(/WHERE[\s\S]*AND[\s\S]*lat_.*IS NOT NULL/);
    });
});
