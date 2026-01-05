import { describe, it, expect, beforeEach } from 'bun:test';
import { CTENode } from '../CTENode';
import { ComponentInclusionNode } from '../ComponentInclusionNode';
import { QueryContext } from '../QueryContext';
import { QueryDAG } from '../QueryDAG';

/**
 * Test Suite: CTE Pagination Bug
 * 
 * Bug Report: Pagination broken with multiple filters (CTE path)
 * 
 * Root Cause: CTENode generates CTE without LIMIT/OFFSET, so the CTE
 * materializes ALL matching entities. When LIMIT/OFFSET is applied at
 * the outer query level, it's applied to a result set that always
 * contains the same entities, causing all pages to return identical results.
 * 
 * Expected Behavior: LIMIT/OFFSET should be applied at the CTE level
 * when pagination is requested, so only the needed page of entity IDs
 * is materialized in the CTE.
 */
describe('CTE Pagination Bug - Multiple Filters Path', () => {
    let context: QueryContext;

    beforeEach(() => {
        context = new QueryContext();
    });

    describe('CTENode SQL Generation', () => {
        it('should include LIMIT in CTE SQL when limit is set', () => {
            // Setup context with multiple components (triggers CTE)
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            // Add filters to trigger CTE path (totalFilters >= 2)
            context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            
            // Set pagination
            context.limit = 10;
            context.offsetValue = 20;

            const cteNode = new CTENode();
            const result = cteNode.execute(context);

            // BUG CHECK: CTE should include LIMIT when pagination is requested
            // Currently FAILS - CTE does not include LIMIT
            expect(result.sql).toContain('LIMIT');
            expect(result.sql).toContain('OFFSET');
        });

        it('should include OFFSET in CTE SQL when offset is set', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            context.componentFilters.set("component-type-1", [
                { field: 'field1', operator: '=', value: 'value1' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'field2', operator: '=', value: 'value2' }
            ]);
            
            // Set offset only (no limit)
            context.offsetValue = 30;

            const cteNode = new CTENode();
            const result = cteNode.execute(context);

            // BUG CHECK: CTE should include OFFSET
            expect(result.sql).toContain('OFFSET');
        });

        it('should NOT include LIMIT/OFFSET in CTE when not set (limit=null, offset=0)', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            // No pagination set (defaults: limit=null, offsetValue=0)
            
            const cteNode = new CTENode();
            const result = cteNode.execute(context);

            // When no pagination, CTE should not include LIMIT
            // OFFSET 0 is optional but shouldn't be required
            expect(result.sql).not.toContain('LIMIT');
        });

        it('should place LIMIT/OFFSET before closing CTE parenthesis', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            context.componentFilters.set("component-type-1", [
                { field: 'field1', operator: '=', value: 'value1' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'field2', operator: '=', value: 'value2' }
            ]);
            
            context.limit = 10;
            context.offsetValue = 20;

            const cteNode = new CTENode();
            const result = cteNode.execute(context);

            // Verify SQL structure: LIMIT/OFFSET should be inside the CTE
            // WITH base_entities AS (
            //     SELECT DISTINCT ec.entity_id ... LIMIT X OFFSET Y
            // )
            
            const cteCloseIndex = result.sql.lastIndexOf(')');
            const limitIndex = result.sql.indexOf('LIMIT');
            const offsetIndex = result.sql.indexOf('OFFSET');
            
            if (limitIndex !== -1) {
                expect(limitIndex).toBeLessThan(cteCloseIndex);
            }
            if (offsetIndex !== -1) {
                expect(offsetIndex).toBeLessThan(cteCloseIndex);
            }
        });
    });

    describe('QueryDAG CTE Path Selection', () => {
        it('should use CTE when totalFilters >= 2', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            // Add 2 filters across components (totalFilters = 2)
            context.componentFilters.set("component-type-1", [
                { field: 'field1', operator: '=', value: 'value1' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'field2', operator: '=', value: 'value2' }
            ]);

            const dag = QueryDAG.buildBasicQuery(context);
            const nodes = dag.getNodes();
            
            // Should have CTENode when multiple filters
            const hasCTENode = nodes.some(node => node.getNodeType() === 'CTENode');
            expect(hasCTENode).toBe(true);
        });

        it('should NOT use CTE when totalFilters < 2', () => {
            context.componentIds.add("component-type-1");
            
            // Add only 1 filter (totalFilters = 1)
            context.componentFilters.set("component-type-1", [
                { field: 'field1', operator: '=', value: 'value1' }
            ]);

            const dag = QueryDAG.buildBasicQuery(context);
            const nodes = dag.getNodes();
            
            // Should NOT have CTENode with single filter
            const hasCTENode = nodes.some(node => node.getNodeType() === 'CTENode');
            expect(hasCTENode).toBe(false);
        });
    });

    describe('Pagination Consistency Across Pages', () => {
        /**
         * This test verifies the core bug: different pages should have different
         * parameter values for OFFSET in the CTE, ensuring different results.
         */
        it('should generate different OFFSET values for different pages', () => {
            // Page 1 context
            const page1Context = new QueryContext();
            page1Context.componentIds.add("component-type-1");
            page1Context.componentIds.add("component-type-2");
            page1Context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            page1Context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            page1Context.limit = 10;
            page1Context.offsetValue = 0;

            // Page 2 context
            const page2Context = new QueryContext();
            page2Context.componentIds.add("component-type-1");
            page2Context.componentIds.add("component-type-2");
            page2Context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            page2Context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            page2Context.limit = 10;
            page2Context.offsetValue = 10;

            // Page 3 context
            const page3Context = new QueryContext();
            page3Context.componentIds.add("component-type-1");
            page3Context.componentIds.add("component-type-2");
            page3Context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            page3Context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            page3Context.limit = 10;
            page3Context.offsetValue = 20;

            const cteNode = new CTENode();
            
            const page1Result = cteNode.execute(page1Context);
            const page2Result = cteNode.execute(page2Context);
            const page3Result = cteNode.execute(page3Context);

            // The CTE SQL should include OFFSET parameter
            // Verify params contain different offset values
            // (params include component IDs + limit + offset)
            
            // BUG CHECK: If CTE includes LIMIT/OFFSET, the params will differ
            // Currently FAILS - params only contain component IDs
            
            // Find offset params in each result
            const page1HasOffset = page1Result.params.includes(0) && page1Result.sql.includes('OFFSET');
            const page2HasOffset = page2Result.params.includes(10) && page2Result.sql.includes('OFFSET');
            const page3HasOffset = page3Result.params.includes(20) && page3Result.sql.includes('OFFSET');
            
            expect(page1HasOffset).toBe(true);
            expect(page2HasOffset).toBe(true);
            expect(page3HasOffset).toBe(true);
        });
    });

    describe('Full DAG Execution with Pagination', () => {
        it('should produce valid SQL with LIMIT/OFFSET for CTE path', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            
            context.limit = 10;
            context.offsetValue = 20;

            const dag = QueryDAG.buildBasicQuery(context);
            const result = dag.execute(context);

            // Full SQL should include CTE with pagination
            expect(result.sql).toContain('WITH base_entities AS');
            expect(result.sql).toContain('LIMIT');
            expect(result.sql).toContain('OFFSET');
            
            // Verify params include pagination values
            expect(result.params).toContain(10);  // limit
            expect(result.params).toContain(20);  // offset
        });

        it('should apply pagination at CTE level, not just outer query', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            
            context.limit = 10;
            context.offsetValue = 0;

            const dag = QueryDAG.buildBasicQuery(context);
            const result = dag.execute(context);

            // Find the CTE section - look for content between "WITH base_entities AS (" and the final ")"
            // before the main SELECT statement
            const cteStartIndex = result.sql.indexOf('WITH base_entities AS (');
            const mainSelectIndex = result.sql.indexOf('SELECT DISTINCT base_entities');
            
            if (cteStartIndex !== -1 && mainSelectIndex !== -1) {
                // CTE body is between the opening "(" and the ")" before the main SELECT
                const cteSqlBody = result.sql.substring(cteStartIndex, mainSelectIndex);
                
                // BUG CHECK: CTE body should contain LIMIT
                expect(cteSqlBody).toContain('LIMIT');
                expect(cteSqlBody).toContain('ORDER BY');
            } else {
                // If no CTE match, the test structure is wrong
                expect(result.sql).toContain('WITH base_entities AS');
            }
        });
    });

    describe('Sort Order with Pagination in CTE', () => {
        /**
         * Important: When adding LIMIT/OFFSET to CTE, ORDER BY must also be
         * applied before LIMIT to ensure consistent pagination results.
         */
        it('should include ORDER BY before LIMIT in CTE when sort orders are specified', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            
            // Add sort order
            context.sortOrders.push({
                component: 'TestComponent',
                property: 'createdAt',
                direction: 'DESC',
                nullsFirst: false
            });
            
            context.limit = 10;
            context.offsetValue = 20;

            const dag = QueryDAG.buildBasicQuery(context);
            const result = dag.execute(context);

            // If CTE includes pagination, it should also include ORDER BY
            // to ensure deterministic results
            const cteMatch = result.sql.match(/WITH base_entities AS \(([\s\S]*?)\)/);
            
            if (cteMatch && cteMatch[1]) {
                const cteSqlBody = cteMatch[1];
                
                // When pagination is in CTE, should have ORDER BY before LIMIT
                if (cteSqlBody.includes('LIMIT')) {
                    const orderByIndex = cteSqlBody.indexOf('ORDER BY');
                    const limitIndex = cteSqlBody.indexOf('LIMIT');
                    
                    // ORDER BY should come before LIMIT
                    expect(orderByIndex).toBeLessThan(limitIndex);
                }
            }
        });

        it('should default to entity_id ORDER when no sort specified but pagination is used', () => {
            context.componentIds.add("component-type-1");
            context.componentIds.add("component-type-2");
            
            context.componentFilters.set("component-type-1", [
                { field: 'status', operator: '=', value: 'active' }
            ]);
            context.componentFilters.set("component-type-2", [
                { field: 'userId', operator: '=', value: 'user123' }
            ]);
            
            // No sort order specified
            context.limit = 10;
            context.offsetValue = 0;

            const cteNode = new CTENode();
            const result = cteNode.execute(context);

            // When pagination is used without explicit sort, should order by entity_id
            // for deterministic results
            if (result.sql.includes('LIMIT') || result.sql.includes('OFFSET')) {
                expect(result.sql).toContain('ORDER BY');
            }
        });
    });
});

describe('Regression Tests - Single Filter Path (Non-CTE)', () => {
    /**
     * Ensure the fix doesn't break single-filter queries (non-CTE path)
     */
    let context: QueryContext;

    beforeEach(() => {
        context = new QueryContext();
    });

    it('should correctly apply LIMIT/OFFSET for single filter queries', () => {
        context.componentIds.add("component-type-1");
        
        // Only 1 filter - should NOT use CTE
        context.componentFilters.set("component-type-1", [
            { field: 'status', operator: '=', value: 'active' }
        ]);
        
        context.limit = 10;
        context.offsetValue = 20;

        const dag = QueryDAG.buildBasicQuery(context);
        const result = dag.execute(context);

        // Should NOT have CTE
        expect(result.sql).not.toContain('WITH base_entities AS');
        
        // Should still have LIMIT/OFFSET
        expect(result.sql).toContain('LIMIT');
        expect(result.sql).toContain('OFFSET');
    });

    it('should work without any filters', () => {
        context.componentIds.add("component-type-1");
        
        // No filters at all
        context.limit = 5;
        context.offsetValue = 10;

        const dag = QueryDAG.buildBasicQuery(context);
        const result = dag.execute(context);

        // Should have LIMIT/OFFSET
        expect(result.sql).toContain('LIMIT');
        expect(result.sql).toContain('OFFSET');
    });
});
