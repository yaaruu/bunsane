/**
 * Row-correctness regressions for query-node fixes.
 * Executes the SQL the nodes emit (not Query.exec) so the assertions pin
 * OrNode / ComponentInclusionNode / FilterBuilder, not the exec wrapper.
 *
 * - Q-04 OR boolean equality and numeric comparison
 * - Q-05 boolean = / != / IN, including missing-field nulls
 * - Q-02 single-component sort with no filters, plus sortedCursor after
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { QueryContext } from '../../../query/QueryContext';
import { QueryDAG } from '../../../query/QueryDAG';
import { OrNode } from '../../../query/OrNode';
import { OrQuery } from '../../../query/OrQuery';
import { ComponentInclusionNode } from '../../../query/ComponentInclusionNode';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { ComponentRegistry } from '../../../core/components';
import { createTestContext, ensureComponentsRegistered } from '../../utils';
import db from '../../../database';

@Component
class NodeFlag extends BaseComponent {
    @CompData() active: boolean = false;
    @CompData() n: number = 0;
    @CompData({ indexed: true }) label: string = '';
}

@Component
class NodeBase extends BaseComponent {
    @CompData() mark: string = '';
}

@Component
class LeafOnly extends BaseComponent {
    @CompData() score: number = 0;
}

async function idsFrom(sql: string, params: unknown[]): Promise<string[]> {
    const rows = await db.unsafe<{ id: string }[]>(sql, params);
    return rows.map(r => r.id);
}

describe('query node regressions', () => {
    const ctxTracker = createTestContext();
    let run = 0;
    let flagId: string;
    let baseId: string;
    let leafId: string;

    beforeAll(async () => {
        await ensureComponentsRegistered(NodeFlag, NodeBase, LeafOnly);
        flagId = ComponentRegistry.getComponentId(NodeFlag.name)!;
        baseId = ComponentRegistry.getComponentId(NodeBase.name)!;
        leafId = ComponentRegistry.getComponentId(LeafOnly.name)!;
    });

    beforeEach(() => {
        run++;
    });

    test('OR boolean equality and numeric comparison return the matching rows', async () => {
        const label = `or-${Date.now().toString(36)}-${run}`;
        const on = ctxTracker.tracker.create();
        on.add(NodeFlag, { active: true, n: 1, label });
        await on.save();
        const off = ctxTracker.tracker.create();
        off.add(NodeFlag, { active: false, n: 20, label });
        await off.save();
        const high = ctxTracker.tracker.create();
        high.add(NodeFlag, { active: false, n: 50, label });
        await high.save();
        const missing = ctxTracker.tracker.create();
        missing.add(NodeFlag, { active: false, n: 0, label });
        await missing.save();
        await db.unsafe(
            `UPDATE components SET data = data - 'active' WHERE entity_id = $1::uuid`,
            [missing.id],
        );

        const boolNode = new OrNode(new OrQuery([
            { component: NodeFlag, filters: [
                { field: 'label', operator: '=', value: label },
                { field: 'active', operator: '=', value: true },
            ] },
        ]));
        const boolIds = await idsFrom(...(() => {
            const result = boolNode.execute(new QueryContext());
            return [result.sql, result.params] as const;
        })());
        expect(boolIds).toEqual([on.id]);

        const numNode = new OrNode(new OrQuery([
            { component: NodeFlag, filters: [
                { field: 'label', operator: '=', value: label },
                { field: 'n', operator: '>', value: 10 },
            ] },
        ]));
        const numResult = numNode.execute(new QueryContext());
        expect(new Set(await idsFrom(numResult.sql, numResult.params))).toEqual(new Set([off.id, high.id]));

        // Base component forces the OrNode fallback emitter.
        high.add(NodeBase, { mark: label });
        await high.save();
        const base = ctxTracker.tracker.create();
        base.add(NodeBase, { mark: label });
        base.add(NodeFlag, { active: true, n: 3, label });
        await base.save();
        const decoy = ctxTracker.tracker.create();
        decoy.add(NodeBase, { mark: label });
        decoy.add(NodeFlag, { active: false, n: 4, label });
        await decoy.save();

        const qctx = new QueryContext();
        qctx.componentIds.add(baseId);
        qctx.componentFilters.set(baseId, [{ field: 'mark', operator: '=', value: label }]);
        qctx.hasOrQuery = true;
        qctx.limit = 20;
        const orNode = new OrNode(new OrQuery([
            { component: NodeFlag, filters: [
                { field: 'label', operator: '=', value: label },
                { field: 'active', operator: '=', value: true },
            ] },
            { component: NodeFlag, filters: [
                { field: 'label', operator: '=', value: label },
                { field: 'n', operator: '>=', value: 50 },
            ] },
        ]));
        orNode.addDependency(new ComponentInclusionNode());
        const fallback = orNode.execute(qctx);
        expect(new Set(await idsFrom(fallback.sql, fallback.params))).toEqual(new Set([base.id, high.id]));
        expect(flagId).toBeTruthy();
    });

    test('boolean =, !=, and IN keep null semantics', async () => {
        const label = `bool-${Date.now().toString(36)}-${run}`;
        const yes = ctxTracker.tracker.create();
        yes.add(NodeFlag, { active: true, n: 1, label });
        await yes.save();
        const no = ctxTracker.tracker.create();
        no.add(NodeFlag, { active: false, n: 2, label });
        await no.save();
        const missing = ctxTracker.tracker.create();
        missing.add(NodeFlag, { active: false, n: 3, label });
        await missing.save();
        await db.unsafe(
            `UPDATE components SET data = data - 'active' WHERE entity_id = $1::uuid`,
            [missing.id],
        );

        const runFilter = async (filters: { field: string; operator: string; value: unknown }[]) => {
            const qctx = new QueryContext();
            qctx.componentIds.add(flagId);
            qctx.componentFilters.set(flagId, filters);
            qctx.limit = 20;
            const result = QueryDAG.buildBasicQuery(qctx).execute(qctx);
            return idsFrom(result.sql, result.params);
        };

        expect(await runFilter([
            { field: 'label', operator: '=', value: label },
            { field: 'active', operator: '=', value: true },
        ])).toEqual([yes.id]);
        expect(await runFilter([
            { field: 'label', operator: '=', value: label },
            { field: 'active', operator: '=', value: false },
        ])).toEqual([no.id]);
        expect(await runFilter([
            { field: 'label', operator: '=', value: label },
            { field: 'active', operator: '!=', value: true },
        ])).toEqual([no.id]);
        expect(new Set(await runFilter([
            { field: 'label', operator: '=', value: label },
            { field: 'active', operator: 'IN', value: [true, false] },
        ]))).toEqual(new Set([yes.id, no.id]));
    });

    test('single-component sort with no filters pages by the leaf scan', async () => {
        const scores = [9, 1, 5, 3, 2];
        const ids: string[] = [];
        for (const score of scores) {
            const e = ctxTracker.tracker.create();
            e.add(LeafOnly, { score });
            await e.save();
            ids.push(e.id);
        }
        const byScore = scores
            .map((score, i) => ({ score, id: ids[i]! }))
            .sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1));

        const pageCtx = new QueryContext();
        pageCtx.componentIds.add(leafId);
        pageCtx.sortOrders = [{ component: 'LeafOnly', property: 'score', direction: 'ASC', nullsFirst: false }];
        pageCtx.limit = 3;
        const page1 = QueryDAG.buildBasicQuery(pageCtx).execute(pageCtx);

        expect(page1.sql.toUpperCase()).not.toContain('EXISTS');
        expect(await idsFrom(page1.sql, page1.params)).toEqual(byScore.slice(0, 3).map(r => r.id));

        const page2Ctx = new QueryContext();
        page2Ctx.componentIds.add(leafId);
        page2Ctx.sortOrders = [{ component: 'LeafOnly', property: 'score', direction: 'ASC', nullsFirst: false }];
        page2Ctx.compositeCursor = { v: String(byScore[2]!.score), id: byScore[2]!.id };
        page2Ctx.limit = 10;
        const page2 = QueryDAG.buildBasicQuery(page2Ctx).execute(page2Ctx);

        expect(await idsFrom(page2.sql, page2.params)).toEqual(byScore.slice(3).map(r => r.id));
    });
});
