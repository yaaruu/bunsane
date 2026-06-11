/**
 * Guard against data loss when BUNSANE_PARTITION_STRATEGY changes.
 *
 * CreateComponentTable() used to DROP TABLE components CASCADE whenever the
 * requested partition strategy differed from the existing one — a single env
 * typo wiped all component data on boot. The decision now lives in the pure
 * partitionRecreateRefusal(): refuse when the table holds data, unless
 * BUNSANE_FORCE_PARTITION_RECREATE=true.
 *
 * Pure-function test on purpose: exercising CreateComponentTable() inside
 * bun:test wedges the shared DB connection (reproducible on both PGlite and
 * pgbouncer-backed PostgreSQL; fine outside the runner). Full end-to-end
 * verification: `bun scripts/verify-partition-guard.ts`.
 */
import { describe, test, expect } from 'bun:test';
import { partitionRecreateRefusal } from '../../../database/DatabaseHelper';

describe('partitionRecreateRefusal', () => {
    test('refuses when table has data and no force flag', () => {
        const msg = partitionRecreateRefusal(true, undefined, 'list', 'hash');
        expect(msg).toMatch(/Refusing to recreate 'components' table/);
    });

    test('refuses when force flag is set but not "true"', () => {
        expect(partitionRecreateRefusal(true, 'false', 'list', 'hash')).not.toBeNull();
        expect(partitionRecreateRefusal(true, '1', 'list', 'hash')).not.toBeNull();
        expect(partitionRecreateRefusal(true, 'TRUE', 'list', 'hash')).not.toBeNull();
    });

    test('allows when force flag is exactly "true"', () => {
        expect(partitionRecreateRefusal(true, 'true', 'list', 'hash')).toBeNull();
    });

    test('allows when table is empty regardless of flag', () => {
        expect(partitionRecreateRefusal(false, undefined, 'list', 'hash')).toBeNull();
        expect(partitionRecreateRefusal(false, 'true', 'hash', 'list')).toBeNull();
    });

    test('message names both strategies and all recovery options', () => {
        const msg = partitionRecreateRefusal(true, undefined, 'hash', 'list')!;
        expect(msg).toContain("'hash'");
        expect(msg).toContain("'list'");
        expect(msg).toContain('BUNSANE_PARTITION_STRATEGY');
        expect(msg).toContain('BUNSANE_FORCE_PARTITION_RECREATE');
        expect(msg).toContain('back up');
    });

    test('handles unknown existing strategy (legacy unpartitioned table)', () => {
        const msg = partitionRecreateRefusal(true, undefined, null, 'list');
        expect(msg).toMatch(/Refusing to recreate/);
        expect(msg).toContain("'null'");
    });
});
