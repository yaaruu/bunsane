/**
 * Probe-window sizing is a pure function of page size and pg_class.reltuples.
 * Unknown or non-positive stats keep the cap. A page that cannot fit in the
 * cap skips the probe.
 */
import { describe, expect, test } from "bun:test";
import { entitySortProbeWindow } from "../../../query/entitySort";

const cap = 5000;

describe("entitySortProbeWindow", () => {
    test("unknown or non-positive stats use the cap", () => {
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: null, leaves: [10], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: 0, leaves: [10], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: -1, leaves: [10], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: 1000, leaves: [0], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: 1000, leaves: [-5], combine: "or", cap,
        })).toEqual({ probe: true, window: cap });
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: 1000, leaves: [], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
        expect(entitySortProbeWindow({
            pageLimit: 21, entities: 1000, leaves: [10, null], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
    });

    test("window is min(cap, max(64, ceil(4 * pageLimit / f)))", () => {
        // f = 100/1000, needed = 10/0.1 = 100, 4*100 = 400
        expect(entitySortProbeWindow({
            pageLimit: 10, entities: 1000, leaves: [100], combine: "and", cap,
        })).toEqual({ probe: true, window: 400 });
        // 4 * needed = 40, floor wins
        expect(entitySortProbeWindow({
            pageLimit: 10, entities: 100, leaves: [100], combine: "and", cap,
        })).toEqual({ probe: true, window: 64 });
        // scaled past the cap, still inside needed
        expect(entitySortProbeWindow({
            pageLimit: 2000, entities: 4000, leaves: [4000], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
    });

    test("AND uses the smallest leaf; OR sums leaves and caps at the entity count", () => {
        expect(entitySortProbeWindow({
            pageLimit: 10, entities: 1000, leaves: [10, 100], combine: "and", cap,
        })).toEqual({ probe: true, window: 4000 });
        // sum 1600 capped at 1000 → f = 1 → floor
        expect(entitySortProbeWindow({
            pageLimit: 10, entities: 1000, leaves: [800, 800], combine: "or", cap,
        })).toEqual({ probe: true, window: 64 });
    });

    test("needed above the cap skips; equal to the cap still probes", () => {
        // f = 1/1000, needed = 6/0.001 = 6000 > 5000
        expect(entitySortProbeWindow({
            pageLimit: 6, entities: 1000, leaves: [1], combine: "and", cap,
        })).toEqual({ probe: false });
        // needed = 5/0.001 = 5000, not greater
        expect(entitySortProbeWindow({
            pageLimit: 5, entities: 1000, leaves: [1], combine: "and", cap,
        })).toEqual({ probe: true, window: cap });
    });

    test("an unbounded page sizes from the membership estimate", () => {
        expect(entitySortProbeWindow({
            pageLimit: null, entities: 1000, leaves: [100], combine: "and", cap,
        })).toEqual({ probe: true, window: 400 });
        expect(entitySortProbeWindow({
            pageLimit: null, entities: 10000, leaves: [6000], combine: "and", cap,
        })).toEqual({ probe: false });
    });
});
