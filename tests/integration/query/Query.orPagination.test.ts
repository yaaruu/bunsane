/**
 * Integration tests for OR-query pagination + multi-tag membership.
 *
 * Regression coverage for the "search results vanish beyond page 1" bug:
 *
 *   Query().with(UserTag).without(DriverTag).with(or([...search...]))
 *          .offset(o).take(n)
 *
 * builds a DAG where ComponentInclusionNode (the base set of UserTag,
 * non-Driver entities) is the root and OrNode is the leaf. The base node used
 * to bake the caller's LIMIT/OFFSET into ITS OWN SQL, so OrNode embedded an
 * already-paginated base:
 *
 *   FROM (SELECT entity_id FROM components ... ORDER BY entity_id LIMIT n OFFSET o) AS base
 *   WHERE EXISTS (... name ILIKE '%term%')
 *
 * i.e. the OR/search filter only ever saw the first page of base entities
 * (ordered by entity_id). Any match whose entity_id sorted beyond that page
 * silently disappeared, while count() — which strips pagination — still
 * reported it. Fix: OrNode nulls limit/offset before building the base and
 * paginates the final OR-filtered result instead.
 *
 * These tests force matches to sort AFTER page 1 by assigning them high-band
 * UUIDs (`ffffffff-...`) and the non-matching "noise" entities low-band UUIDs
 * (`00000000-...`). entity_id ASC therefore lists all noise first — so under
 * the bug a small `take()` base contains zero matches and the search returns
 * nothing; under the fix the matches are recovered. This makes the regression
 * deterministic rather than probabilistic.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Query, FilterOp, or } from '../../../query/Query';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { createTestContext, ensureComponentsRegistered } from '../../utils';

// Pure membership markers ("tags"). A real app uses these to distinguish user
// kinds (customer vs driver) independent of profile data.
@Component
class SearchUserTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}

@Component
class SearchDriverTag extends BaseComponent {
    @CompData({ nullable: true }) note?: string;
}

// Searchable profile data. Both fields are search targets (name OR phone),
// mirroring the app's buildUserSearchOr(term).
@Component
class SearchProfile extends BaseComponent {
    @CompData({ indexed: true }) name: string = '';
    @CompData({ indexed: true }) phone: string = '';
}

/** OR over the two searchable fields — the shape the app builds per term. */
function searchOr(term: string) {
    return or([
        { component: SearchProfile, filters: [Query.filter('name', FilterOp.ILIKE, `%${term}%`)] },
        { component: SearchProfile, filters: [Query.filter('phone', FilterOp.ILIKE, `%${term}%`)] },
    ]);
}

let scenarioCounter = 0;

/**
 * A fresh, isolated data scenario:
 * - a globally-unique `term` that appears ONLY in matching entities, so
 *   count()/exec() scoped by it ignore any leftover rows from other tests.
 * - id minters that assign deterministic UUID bands so noise sorts before
 *   matches under `ORDER BY entity_id ASC`.
 */
function newScenario() {
    scenarioCounter++;
    const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const tag = `${rand}${scenarioCounter.toString(16).padStart(4, '0')}`.slice(0, 12);
    const term = `srch${tag}`; // unique; only matching names/phones embed it
    let lowCount = 0;
    let highCount = 0;
    const mint = (band: '00000000' | 'ffffffff', i: number): string => {
        const idx = i.toString(16).padStart(12, '0');
        // 8-4-4-4-12, version nibble 4, variant nibble 8 → valid UUID.
        return `${band}-${tag.slice(0, 4)}-4${tag.slice(4, 7)}-8${tag.slice(7, 10)}-${idx}`;
    };
    return {
        term,
        /** UUID that sorts BEFORE every match id (noise / page-1 fillers). */
        lowId: () => mint('00000000', lowCount++),
        /** UUID that sorts AFTER every low id (the search matches). */
        highId: () => mint('ffffffff', highCount++),
    };
}

describe('Query — OR pagination + multi-tag membership', () => {
    const ctx = createTestContext();

    beforeAll(async () => {
        await ensureComponentsRegistered(SearchUserTag, SearchDriverTag, SearchProfile);
    });

    type Kind = 'user' | 'driver' | 'user+driver';

    /** Create one entity with the given tags + profile and a chosen id band. */
    async function addEntity(opts: {
        id: string;
        kind: Kind;
        name: string;
        phone: string;
    }): Promise<string> {
        const e = ctx.tracker.create(opts.id);
        if (opts.kind === 'user' || opts.kind === 'user+driver') e.add(SearchUserTag, {});
        if (opts.kind === 'driver' || opts.kind === 'user+driver') e.add(SearchDriverTag, {});
        e.add(SearchProfile, { name: opts.name, phone: opts.phone });
        await e.save();
        return e.id;
    }

    // -----------------------------------------------------------------------
    // The core regression: search must not drop matches beyond page 1.
    // -----------------------------------------------------------------------
    describe('regression: paginated OR-search keeps matches beyond page 1', () => {
        test('small take() still returns matches that sort after the page-1 base', async () => {
            const scn = newScenario();

            // 8 non-matching customers (low band → sort first).
            for (let i = 0; i < 8; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Nobody ${i}`, phone: `1000${i}` });
            }
            // 2 matching customers (high band → sort last). Their NAME carries the term.
            const m1 = await addEntity({ id: scn.highId(), kind: 'user', name: `Helmi ${scn.term} A`, phone: '90001' });
            const m2 = await addEntity({ id: scn.highId(), kind: 'user', name: `Helmi ${scn.term} B`, phone: '90002' });

            // take(3) < 8 noise rows: under the bug the base is the first 3
            // (all noise) → 0 matches. Under the fix the OR filter runs on the
            // full base → both matches survive within the take(3) page.
            const results = await new Query()
                .with(SearchUserTag)
                .without(SearchDriverTag)
                .with(searchOr(scn.term))
                .offset(0)
                .take(3)
                .exec();

            const ids = results.map(e => e.id);
            expect(ids).toContain(m1);
            expect(ids).toContain(m2);
            expect(results.length).toBe(2);
        });

        test('count() and exec() agree (the count-right / list-empty telltale)', async () => {
            const scn = newScenario();
            for (let i = 0; i < 10; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Filler ${i}`, phone: `200${i}` });
            }
            const matchIds: string[] = [];
            for (let i = 0; i < 5; i++) {
                matchIds.push(await addEntity({ id: scn.highId(), kind: 'user', name: `Match ${scn.term} ${i}`, phone: `300${i}` }));
            }

            const baseQuery = () =>
                new Query().with(SearchUserTag).without(SearchDriverTag).with(searchOr(scn.term));

            const total = await baseQuery().count();
            const firstPage = await baseQuery().offset(0).take(2).exec();

            // count() never lied (it strips pagination); the bug was exec()
            // returning fewer than count() because the base was pre-paginated.
            expect(total).toBe(5);
            expect(firstPage.length).toBe(2);
        });

        test('paginating every page recovers the full match set, no gaps/dupes', async () => {
            const scn = newScenario();
            for (let i = 0; i < 12; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Noise ${i}`, phone: `400${i}` });
            }
            const expected = new Set<string>();
            for (let i = 0; i < 5; i++) {
                expected.add(await addEntity({ id: scn.highId(), kind: 'user', name: `Hit ${scn.term} ${i}`, phone: `500${i}` }));
            }

            const pageSize = 2;
            const collected: string[] = [];
            for (let offset = 0; offset < 10; offset += pageSize) {
                const page = await new Query()
                    .with(SearchUserTag)
                    .without(SearchDriverTag)
                    .with(searchOr(scn.term))
                    .offset(offset)
                    .take(pageSize)
                    .exec();
                collected.push(...page.map(e => e.id));
                if (page.length < pageSize) break;
            }

            // Every match recovered exactly once.
            expect(new Set(collected).size).toBe(collected.length); // no dupes across pages
            expect(new Set(collected)).toEqual(expected);
            expect(collected.length).toBe(5);
        });

        test('match only on the SECOND OR branch (phone) is also recovered', async () => {
            const scn = newScenario();
            for (let i = 0; i < 6; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Plain ${i}`, phone: `700${i}` });
            }
            // Term lives in PHONE, not name → exercises the phone OR branch.
            const phoneMatch = await addEntity({ id: scn.highId(), kind: 'user', name: 'No Term Here', phone: `+62-${scn.term}` });

            const results = await new Query()
                .with(SearchUserTag)
                .without(SearchDriverTag)
                .with(searchOr(scn.term))
                .take(3)
                .exec();

            expect(results.map(e => e.id)).toContain(phoneMatch);
            expect(results.length).toBe(1);
        });

        test('offset past the match set returns empty (not a wrong page)', async () => {
            const scn = newScenario();
            for (let i = 0; i < 6; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Bg ${i}`, phone: `800${i}` });
            }
            for (let i = 0; i < 3; i++) {
                await addEntity({ id: scn.highId(), kind: 'user', name: `End ${scn.term} ${i}`, phone: `810${i}` });
            }

            const beyond = await new Query()
                .with(SearchUserTag)
                .without(SearchDriverTag)
                .with(searchOr(scn.term))
                .offset(5) // only 3 matches exist
                .take(10)
                .exec();

            expect(beyond.length).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Multi-tag membership: customer vs driver vs both.
    // -----------------------------------------------------------------------
    describe('multi-tag membership', () => {
        test('without(DriverTag) excludes a dual-tagged (user+driver) entity from customer search', async () => {
            const scn = newScenario();
            // A pure customer match, and a dual-tagged user+driver match with the same term.
            const customer = await addEntity({ id: scn.highId(), kind: 'user', name: `Cust ${scn.term}`, phone: '111' });
            const dual = await addEntity({ id: scn.highId(), kind: 'user+driver', name: `Dual ${scn.term}`, phone: '222' });
            // Some low-band noise to ensure pagination is in play.
            for (let i = 0; i < 5; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `N ${i}`, phone: `33${i}` });
            }

            const results = await new Query()
                .with(SearchUserTag)
                .without(SearchDriverTag)
                .with(searchOr(scn.term))
                .take(10)
                .exec();

            const ids = results.map(e => e.id);
            expect(ids).toContain(customer);   // pure customer kept
            expect(ids).not.toContain(dual);   // user+driver excluded by without()
        });

        test('driver search (with DriverTag) returns its own matches — symmetric to customer search', async () => {
            const scn = newScenario();
            // Noise drivers + matching drivers, all high/low banded.
            for (let i = 0; i < 7; i++) {
                await addEntity({ id: scn.lowId(), kind: 'driver', name: `Drv ${i}`, phone: `44${i}` });
            }
            const d1 = await addEntity({ id: scn.highId(), kind: 'driver', name: `Pilot ${scn.term} 1`, phone: '901' });
            const d2 = await addEntity({ id: scn.highId(), kind: 'driver', name: `Pilot ${scn.term} 2`, phone: '902' });

            const results = await new Query()
                .with(SearchDriverTag)
                .with(searchOr(scn.term))
                .take(2) // smaller than noise count → would drop matches under the bug
                .exec();

            const ids = results.map(e => e.id);
            expect(ids).toContain(d1);
            expect(ids).toContain(d2);
            expect(results.length).toBe(2);
        });

        test('with(UserTag).with(DriverTag) returns only dual-tagged entities (intersection) and paginates correctly', async () => {
            const scn = newScenario();
            // 4 user-only, 4 driver-only, 5 dual.
            for (let i = 0; i < 4; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `UOnly ${scn.term} ${i}`, phone: `50${i}` });
                await addEntity({ id: scn.lowId(), kind: 'driver', name: `DOnly ${scn.term} ${i}`, phone: `51${i}` });
            }
            const dualIds = new Set<string>();
            for (let i = 0; i < 5; i++) {
                dualIds.add(await addEntity({ id: scn.highId(), kind: 'user+driver', name: `Both ${scn.term} ${i}`, phone: `52${i}` }));
            }

            // Intersection (AND) path — not OR — scoped by the shared term.
            const all = await new Query()
                .with(SearchUserTag)
                .with(SearchDriverTag)
                .with(SearchProfile, { filters: [Query.filter('name', FilterOp.ILIKE, `%${scn.term}%`)] })
                .take(100)
                .exec();

            expect(new Set(all.map(e => e.id))).toEqual(dualIds);

            // Page through the intersection — union of pages == full dual set.
            const collected = new Set<string>();
            for (let offset = 0; offset < 6; offset += 2) {
                const page = await new Query()
                    .with(SearchUserTag)
                    .with(SearchDriverTag)
                    .with(SearchProfile, { filters: [Query.filter('name', FilterOp.ILIKE, `%${scn.term}%`)] })
                    .offset(offset)
                    .take(2)
                    .exec();
                page.forEach(e => collected.add(e.id));
                if (page.length < 2) break;
            }
            expect(collected).toEqual(dualIds);
        });
    });

    // -----------------------------------------------------------------------
    // OR union across DIFFERENT components, on top of a base tag, paginated.
    // -----------------------------------------------------------------------
    describe('OR union across components + base tag', () => {
        test('union of two component branches, bounded page, no duplicates', async () => {
            const scn = newScenario();
            for (let i = 0; i < 6; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Z ${i}`, phone: `60${i}` });
            }
            // One matches via name branch, one via phone branch.
            const byName = await addEntity({ id: scn.highId(), kind: 'user', name: `Named ${scn.term}`, phone: '999' });
            const byPhone = await addEntity({ id: scn.highId(), kind: 'user', name: 'Unrelated', phone: `${scn.term}-phone` });

            const results = await new Query()
                .with(SearchUserTag)
                .without(SearchDriverTag)
                .with(searchOr(scn.term))
                .take(4)
                .exec();

            const ids = results.map(e => e.id);
            expect(ids).toContain(byName);
            expect(ids).toContain(byPhone);
            expect(ids.length).toBe(new Set(ids).size); // no dupes
            expect(results.length).toBe(2);
        });
    });

    // -----------------------------------------------------------------------
    // Guard: standalone OR (no base component) must remain correct. This path
    // (OrNode as root, no dependency) was NOT the bug, but the fix must not
    // regress it.
    // -----------------------------------------------------------------------
    describe('standalone OR (no base component) pagination', () => {
        test('matches are returned despite many non-matching profiles sorting first', async () => {
            const scn = newScenario();
            for (let i = 0; i < 8; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Misc ${i}`, phone: `70${i}` });
            }
            const a = await addEntity({ id: scn.highId(), kind: 'user', name: `Solo ${scn.term} A`, phone: '981' });
            const b = await addEntity({ id: scn.highId(), kind: 'user', name: `Solo ${scn.term} B`, phone: '982' });

            // No .with(tag) base — OrNode is the root node here.
            const results = await new Query()
                .with(searchOr(scn.term))
                .take(3)
                .exec();

            const ids = results.map(e => e.id);
            expect(ids).toContain(a);
            expect(ids).toContain(b);
            expect(results.length).toBe(2);
        });
    });

    // -----------------------------------------------------------------------
    // Scale smoke: a small page over a larger noise set must still find the
    // few real matches (and stay bounded). Exercises the bug at volume.
    // -----------------------------------------------------------------------
    describe('scale smoke', () => {
        test('search over ~80 noise users returns the 4 real matches within a small page', async () => {
            const scn = newScenario();
            for (let i = 0; i < 80; i++) {
                await addEntity({ id: scn.lowId(), kind: 'user', name: `Bulk User ${i}`, phone: `6${i.toString().padStart(4, '0')}` });
            }
            const expected = new Set<string>();
            for (let i = 0; i < 4; i++) {
                expected.add(await addEntity({ id: scn.highId(), kind: 'user', name: `VIP ${scn.term} ${i}`, phone: `95${i}` }));
            }

            const results = await new Query()
                .with(SearchUserTag)
                .without(SearchDriverTag)
                .with(searchOr(scn.term))
                .take(10) // far smaller than the 80 noise rows
                .exec();

            expect(new Set(results.map(e => e.id))).toEqual(expected);
        });
    });
});
