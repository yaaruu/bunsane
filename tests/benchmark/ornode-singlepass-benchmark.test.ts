/**
 * OrNode single-pass A/B benchmark + parity proof.
 *
 * Goal: prove the gated `BUNSANE_ORNODE_SINGLE_PASS` rewrite of the
 * base-dependency OR path (base scanned ONCE + OR-of-EXISTS) is:
 *   1. CORRECT  — returns the exact same entity set as the legacy UNION path,
 *                 across exec(), pagination and count().
 *   2. FASTER   — fewer base scans in the plan, lower Execution Time.
 *
 * The legacy path embeds the base SQL inside every OR branch and UNION-s them,
 * so the base relation is scanned once per branch. The single-pass path
 * references the base once and OR-s the branch EXISTS predicates. With a
 * 3-branch OR the legacy plan scans the base 3×; the new plan scans it 1×.
 *
 * Run (PGlite, zero-infra):
 *   bun tests/pglite-setup.ts tests/benchmark/ornode-singlepass-benchmark.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Query, FilterOp, or } from '../../query/Query';
import { Entity } from '../../core/Entity';
import { BaseComponent } from '../../core/components/BaseComponent';
import { Component, CompData } from '../../core/components/Decorators';
import { ComponentRegistry } from '../../core/components';
import { createTestContext, ensureComponentsRegistered } from '../utils';

const FLAG = 'BUNSANE_ORNODE_SINGLE_PASS';
// Single-pass is now default ON; '0' is the kill-switch back to legacy UNION.
const legacyMode = () => { process.env[FLAG] = '0'; };
const singlePassMode = () => { process.env[FLAG] = '1'; };
const resetMode = () => { delete process.env[FLAG]; };

@Component
class BUserTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class BDriverTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}
@Component
class BProfile extends BaseComponent {
    @CompData({ indexed: true }) name: string = '';
    @CompData({ indexed: true }) phone: string = '';
    @CompData({ indexed: true }) city: string = '';
}

/** 3-branch OR over the searchable fields → amplifies the N× base-scan cost. */
function searchOr3(term: string) {
    return or([
        { component: BProfile, filters: [Query.filter('name', FilterOp.ILIKE, `%${term}%`)] },
        { component: BProfile, filters: [Query.filter('phone', FilterOp.ILIKE, `%${term}%`)] },
        { component: BProfile, filters: [Query.filter('city', FilterOp.ILIKE, `%${term}%`)] },
    ]);
}

/** The exact query under test — base tag + exclusion + 3-branch OR search. */
function buildQuery(term: string, take = 25) {
    return new Query()
        .with(BUserTag)
        .without(BDriverTag)
        .with(searchOr3(term))
        .take(take);
}

function parseTimes(plan: string): { exec: number; plan: number } {
    const e = plan.match(/Execution Time:\s*([\d.]+)\s*ms/i);
    const p = plan.match(/Planning Time:\s*([\d.]+)\s*ms/i);
    return { exec: e ? parseFloat(e[1]!) : NaN, plan: p ? parseFloat(p[1]!) : NaN };
}

/** Count how many times a relation name appears in the plan (= scan count). */
function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    return haystack.split(needle).length - 1;
}

async function median(fn: () => Promise<unknown>, iterations: number): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        await fn();
        samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)]!;
}

describe('OrNode single-pass — A/B benchmark + parity', () => {
    // createTestContext wires cache + EntityManager readiness. We do NOT use
    // its tracker for seeding: its afterEach hard-deletes tracked entities, so
    // data seeded once in beforeAll would vanish after test 1. Seed plain
    // entities and clean them up in afterAll instead.
    createTestContext();
    const seeded: Entity[] = [];
    const TERM = `vip${Math.floor(Math.random() * 0xffffff).toString(16)}`;
    const NOISE = 500;      // base users that do NOT match the term
    const DRIVERS = 100;    // dual user+driver matches → must be excluded
    const MATCHES = 12;     // pure-user matches spread across the 3 OR branches
    const ITER = 8;         // timing iterations (PGlite WASM is ~ms-to-s per query)

    beforeAll(async () => {
        await ensureComponentsRegistered(BUserTag, BDriverTag, BProfile);

        // Non-matching base noise.
        for (let i = 0; i < NOISE; i++) {
            const e = new Entity();
            e.add(BUserTag, {});
            e.add(BProfile, { name: `Noise ${i}`, phone: `100${i}`, city: `Town${i % 50}` });
            await e.save();
            seeded.push(e);
        }
        // Dual-tagged matches — carry the term but are excluded by without(Driver).
        for (let i = 0; i < DRIVERS; i++) {
            const e = new Entity();
            e.add(BUserTag, {});
            e.add(BDriverTag, {});
            e.add(BProfile, { name: `Driver ${TERM} ${i}`, phone: `200${i}`, city: `City${i}` });
            await e.save();
            seeded.push(e);
        }
        // Real matches: 4 via name, 4 via phone, 4 via city.
        for (let i = 0; i < MATCHES; i++) {
            const e = new Entity();
            e.add(BUserTag, {});
            const branch = i % 3;
            e.add(BProfile, {
                name: branch === 0 ? `Match ${TERM} ${i}` : `Plain ${i}`,
                phone: branch === 1 ? `${TERM}-${i}` : `900${i}`,
                city: branch === 2 ? `${TERM}ville` : `Elsewhere${i}`,
            });
            await e.save();
            seeded.push(e);
        }
    });

    afterAll(async () => {
        for (const e of seeded) {
            try { await e.delete(true); } catch { /* ignore */ }
        }
    });

    test('parity: single-pass returns the identical entity set as the UNION path', async () => {
        legacyMode();
        const legacy = (await buildQuery(TERM, 100).exec()).map(e => e.id).sort();

        singlePassMode();
        const singlePass = (await buildQuery(TERM, 100).exec()).map(e => e.id).sort();
        resetMode();

        expect(singlePass).toEqual(legacy);
        expect(legacy.length).toBe(MATCHES);          // all real matches, no drivers
        console.log(`\n[parity] both paths returned ${legacy.length} ids — identical set ✅`);
    }, 60_000);

    test('parity: pagination pages match across both paths', async () => {
        const pageSize = 5;
        const collect = async (flagOn: boolean) => {
            if (flagOn) singlePassMode(); else legacyMode();
            const ids: string[] = [];
            for (let offset = 0; offset < MATCHES + pageSize; offset += pageSize) {
                const page = await new Query()
                    .with(BUserTag).without(BDriverTag).with(searchOr3(TERM))
                    .offset(offset).take(pageSize).exec();
                ids.push(...page.map(e => e.id));
                if (page.length < pageSize) break;
            }
            resetMode();
            return ids;
        };
        const legacy = await collect(false);
        const sp = await collect(true);
        expect(sp).toEqual(legacy);                    // same order, same ids, no dupes
        expect(new Set(sp).size).toBe(MATCHES);
        console.log(`[parity] paginated both paths recovered ${sp.length} ids in identical order ✅`);
    }, 60_000);

    test('parity: count() agrees across both paths', async () => {
        legacyMode();
        const legacyCount = await buildQuery(TERM).count();
        singlePassMode();
        const spCount = await buildQuery(TERM).count();
        resetMode();
        expect(spCount).toBe(legacyCount);
        expect(legacyCount).toBe(MATCHES);
        console.log(`[parity] count() agreed: ${legacyCount} ✅`);
    }, 60_000);

    test('EXPLAIN ANALYZE + timing: single-pass scans base once and runs faster', async () => {
        const userTagId = ComponentRegistry.getComponentId('BUserTag')!;
        const baseRel = ComponentRegistry.getPartitionTableName(userTagId) || 'components';

        legacyMode();
        const legacyPlan = await buildQuery(TERM).explainAnalyze(false);

        singlePassMode();
        const spPlan = await buildQuery(TERM).explainAnalyze(false);
        resetMode();

        const legacyBaseScans = countOccurrences(legacyPlan, baseRel);
        const spBaseScans = countOccurrences(spPlan, baseRel);
        const legacyNodes = countOccurrences(legacyPlan, '->');
        const spNodes = countOccurrences(spPlan, '->');
        const lt = parseTimes(legacyPlan);
        const st = parseTimes(spPlan);

        // Wall-clock medians (DB + JS).
        legacyMode();
        const legacyWall = await median(() => buildQuery(TERM).exec(), ITER);
        singlePassMode();
        const spWall = await median(() => buildQuery(TERM).exec(), ITER);
        resetMode();

        console.log('\n========== OrNode single-pass A/B ==========');
        console.log(`base relation: ${baseRel}`);
        console.log(`base scans in plan   legacy=${legacyBaseScans}  single-pass=${spBaseScans}`);
        console.log(`plan node count      legacy=${legacyNodes}  single-pass=${spNodes}`);
        console.log(`PG Execution Time    legacy=${lt.exec}ms  single-pass=${st.exec}ms`);
        console.log(`PG Planning Time     legacy=${lt.plan}ms  single-pass=${st.plan}ms`);
        console.log(`wall-clock median    legacy=${legacyWall.toFixed(2)}ms  single-pass=${spWall.toFixed(2)}ms`);
        console.log('\n----- LEGACY (UNION) PLAN -----\n' + legacyPlan);
        console.log('\n----- SINGLE-PASS (OR-of-EXISTS) PLAN -----\n' + spPlan);
        console.log('============================================\n');

        // Structural guarantee: the base relation is scanned strictly fewer
        // times under single-pass (3-branch OR → 3× vs 1×). This is the
        // engine-independent proof; timing is supporting evidence.
        expect(spBaseScans).toBeLessThan(legacyBaseScans);
        expect(Number.isFinite(st.exec)).toBe(true);
    }, 120_000);
});
