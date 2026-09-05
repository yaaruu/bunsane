/**
 * SEC-03 integration: the audit's injection payloads, executed for real.
 *
 * Before the fix these rewrote WHERE/ORDER BY structure; after it they are
 * either inert literals or rejected. Legitimate queries must be unaffected.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import db from '../../../database';
import { Query, FilterOp } from '../../../query/Query';
import { OrQuery } from '../../../query/OrQuery';
import { TestUser } from '../../fixtures/components/TestUser';
import { ensureComponentsRegistered } from '../../utils';

describe('SEC-03: injection payloads through real Query execution', () => {
    // No EntityTracker here: its afterEach cleanup would delete the fixtures
    // between tests. Explicit hard-delete in afterAll instead.
    let ids: string[] = [];

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser);

        const e1 = Entity.Create();
        await e1.add(TestUser, { name: 'SecA', email: 'a@sec03', age: 1 });
        await e1.save();

        const e2 = Entity.Create();
        await e2.add(TestUser, { name: 'SecB', email: 'b@sec03', age: 2 });
        await e2.save();

        ids = [e1.id, e2.id];
    });

    afterAll(async () => {
        if (ids.length) {
            await db`DELETE FROM components WHERE entity_id IN (${ids[0]}, ${ids[1]})`;
            await db`DELETE FROM entities WHERE id IN (${ids[0]}, ${ids[1]})`;
        }
    });

    test('legitimate filter returns exactly the matching row', async () => {
        const rows = await new Query()
            .with(TestUser, { filters: [Query.filter('name', FilterOp.EQ, 'SecA')] })
            .exec();
        expect(rows.length).toBe(1);
    });

    test("filter field injection \"x' OR true --\" is inert (no rows, no error)", async () => {
        const rows = await new Query()
            .with(TestUser, {
                filters: [Query.filter("x' OR true --", FilterOp.EQ, 1)],
            })
            .exec();
        // Escaped → matches a literal key that does not exist. Crucially the
        // predicate did NOT become `OR true` (which would have returned both).
        expect(rows.length).toBe(0);
    });

    test('.with() filters accept injected fields without breaking the WHERE', async () => {
        const rows = await new Query()
            .with(TestUser, {
                filters: [{ field: "name') OR true--", operator: '=', value: 'x' }],
            })
            .exec();
        expect(rows.length).toBe(0);
    });

    test('crafted filter operator is rejected outright', async () => {
        await expect(
            new Query()
                .with(TestUser, {
                    filters: [Query.filter('name', '= $1) OR true --' as any, 'SecA')],
                })
                .exec(),
        ).rejects.toThrow(/Unsupported filter operator/);
    });

    test('sortBy direction injection is normalized to ASC', async () => {
        const rows = await new Query()
            .with(TestUser)
            .sortBy(TestUser, 'age', 'ASC; SELECT pg_sleep(5)--' as any)
            .exec();
        expect(rows.length).toBeGreaterThanOrEqual(2);
        // ASC order preserved: ages ascending.
        const ages: number[] = [];
        for (const r of rows) {
            const d = await r.get(TestUser);
            if (d) ages.push(d.age);
        }
        const sorted = [...ages].sort((a, b) => a - b);
        expect(ages).toEqual(sorted);
    });

    test('OrQuery branch field injection is inert', async () => {
        const orQ = new OrQuery([
            { component: TestUser, filters: [Query.filter("name' OR true --", FilterOp.EQ, 1)] },
            { component: TestUser, filters: [Query.filter('name', FilterOp.EQ, 'SecB')] },
        ]);
        const rows = await new Query().with(orQ).exec();
        // Only the honest branch matches; the injected one is a dead literal key.
        expect(rows.length).toBe(1);
    });
});
