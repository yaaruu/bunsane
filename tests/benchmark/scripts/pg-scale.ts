/**
 * Scale mix for the real-PG read-path harness.
 *
 * md is the historical 100k-entity mix. lg is that mix ×10 (1M entities,
 * 1.3M component rows). Unknown names are errors — never a silent md.
 *
 * Entity/component ids are md5("bunsane-bench-v1:"+seq), not sha256: core
 * Postgres has md5() and does not have sha256 without pgcrypto, which the
 * test role may not be allowed to create. The sequence is still deterministic
 * and stable across runs. Layout matches the old nextId() order (entity id,
 * then that entity's component ids) so foreign keys are computable in SQL.
 */
import { createHash } from "node:crypto";

export type ScaleName = "smoke" | "md" | "lg";

export interface ScaleCounts {
    users: number;
    products: number;
    orders: number;
    orderItems: number;
    reviews: number;
}

export interface IdLayout {
    userEntityBase: number;
    productEntityBase: number;
    orderEntityBase: number;
    itemEntityBase: number;
    reviewEntityBase: number;
    /** Highest created_at slot used by a non-review entity. */
    maxNonReviewSlot: number;
    /** created_at slot of review 0. Every review is strictly newer. */
    reviewSlotOrigin: number;
}

const MD: ScaleCounts = {
    users: 10_000,
    products: 20_000,
    orders: 30_000,
    orderItems: 30_000,
    reviews: 10_000,
};

export function resolveScale(raw: string | undefined): ScaleName {
    if (raw === undefined || raw === "" || raw === "md") return "md";
    if (raw === "smoke" || raw === "lg") return raw;
    throw new Error(`Unknown scale "${raw}". Expected smoke, md, or lg.`);
}

export function countsFor(scale: ScaleName): ScaleCounts {
    if (scale === "smoke") {
        return { users: 40, products: 40, orders: 80, orderItems: 40, reviews: 20 };
    }
    if (scale === "md") return MD;
    return {
        users: MD.users * 10,
        products: MD.products * 10,
        orders: MD.orders * 10,
        orderItems: MD.orderItems * 10,
        reviews: MD.reviews * 10,
    };
}

export function entityTotal(counts: ScaleCounts): number {
    return counts.users + counts.products + counts.orders + counts.orderItems + counts.reviews;
}

export function componentTotal(counts: ScaleCounts): number {
    return counts.users + counts.products + counts.orders * 2 + counts.orderItems + counts.reviews;
}

/** Guard the documented lg mix so a counts edit cannot silently drift. */
export function assertLgMix(): void {
    const counts = countsFor("lg");
    const entities = entityTotal(counts);
    const components = componentTotal(counts);
    if (entities !== 1_000_000 || components !== 1_300_000) {
        throw new Error(`lg mix drifted: entities=${entities} components=${components}`);
    }
}

export function idLayout(counts: ScaleCounts): IdLayout {
    const userEntityBase = 1;
    const productEntityBase = userEntityBase + counts.users * 2;
    const orderEntityBase = productEntityBase + counts.products * 2;
    const itemEntityBase = orderEntityBase + counts.orders * 3;
    const reviewEntityBase = itemEntityBase + counts.orderItems * 2;
    const maxNonReviewSlot = Math.max(
        (counts.users - 1) * 4,
        (counts.products - 1) * 4 + 1,
        (counts.orders - 1) * 4 + 2,
        (counts.orderItems - 1) * 4 + 3,
    );
    return {
        userEntityBase,
        productEntityBase,
        orderEntityBase,
        itemEntityBase,
        reviewEntityBase,
        maxNonReviewSlot,
        reviewSlotOrigin: maxNonReviewSlot + 1,
    };
}

/** Same bits as SQL bench_det_uuid. Used only to check the SQL function. */
export function detUuid(n: number): string {
    const hex = createHash("md5").update(`bunsane-bench-v1:${n}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function positiveInt(raw: string | undefined, fallback: number): number {
    const n = parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function nonNegativeInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Expected a non-negative integer, got "${raw}"`);
    }
    return n;
}

/** i % step === 0, i in [0, count). Exact for counts divisible by step. */
export function everyNth(count: number, step: number): number {
    if (count <= 0) return 0;
    return Math.floor((count - 1) / step) + 1;
}
