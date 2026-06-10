/**
 * Resolves the entity<->component membership source for query generation.
 *
 * Historically membership lived in the redundant `entity_components` junction
 * table. The `components` table already encodes membership via
 * `UNIQUE(entity_id, type_id)`, so reads can be redirected to it. This module
 * gates that redirection behind `BUNSANE_MEMBERSHIP_SOURCE`:
 *
 *   - `components` (default): read membership from `components`.
 *   - `legacy`: read from `entity_components` (instant rollback). Behavior is
 *     byte-identical to the pre-redirect query generation.
 *
 * The env var is read at call time (not module load) so tests can flip it.
 *
 * Phase 1 of docs/ENTITY_COMPONENTS_REMOVAL_PLAN.md.
 */

import { assertComponentTableName, InvalidIdentifierError } from "./SqlIdentifier";

const LEGACY_TABLE = "entity_components";
const COMPONENTS_TABLE = "components";

export interface MembershipSource {
    /**
     * The table to scan for membership rows. Feeds raw SQL — already validated
     * against the allow-list.
     */
    table: string;
    /**
     * Whether the legacy `component_id`-join style applies. When false, the
     * membership rows live in `components` and joins to component data collapse
     * to single-table predicates (`c.entity_id = ? AND c.type_id = ?`).
     */
    isLegacy: boolean;
}

/**
 * Resolve the configured membership source. Reads `BUNSANE_MEMBERSHIP_SOURCE`
 * at call time; defaults to `components`.
 */
export function getMembershipSource(): MembershipSource {
    const raw = (process.env.BUNSANE_MEMBERSHIP_SOURCE || COMPONENTS_TABLE).toLowerCase();
    const isLegacy = raw === "legacy";
    const table = isLegacy ? LEGACY_TABLE : COMPONENTS_TABLE;

    // Defensive: both names are static, but they feed raw SQL — validate
    // against an explicit allow-list of exactly the two known table names so a
    // regression here cannot widen injection surface. `entity_components` does
    // not match the `components*` component-table pattern, so it gets the
    // explicit check; `components` is additionally run through the shared
    // allow-list validator for consistency.
    if (isLegacy) {
        if (table !== LEGACY_TABLE) {
            throw new InvalidIdentifierError("membershipSource.table", table);
        }
    } else {
        assertComponentTableName(table, "membershipSource.table");
    }

    return { table, isLegacy };
}

/** Convenience: the membership table name only. */
export function getMembershipTable(): string {
    return getMembershipSource().table;
}
