/**
 * Pool configuration guards (ticket B8b).
 *
 * Bun SQL pool timeouts are in SECONDS. The framework used to pass milliseconds
 * (`idleTimeout: 30000`, `maxLifetime: 600000`), which silently disabled
 * connection recycling for the life of the process — an idle pool never shrank
 * and a degraded connection had no age-based escape. These tests pin the units
 * and the boot-time rejection so the mix-up cannot come back unnoticed.
 */
import { describe, test, expect } from 'bun:test';
import { parsePoolSeconds, POOL_SECONDS_MAX } from '../../../database';
import { isPoolAcquisitionError, POOL_ACQUIRE_TIMEOUT_CODE } from '../../../database/poolErrors';

describe('parsePoolSeconds', () => {
    test('falls back to the default when unset or empty', () => {
        expect(parsePoolSeconds('X', undefined, 30)).toBe(30);
        expect(parsePoolSeconds('X', '', 600)).toBe(600);
    });

    test('accepts plausible second values, including 0 for "no limit"', () => {
        expect(parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', '30', 1)).toBe(30);
        expect(parsePoolSeconds('DB_POOL_MAX_LIFETIME', '600', 1)).toBe(600);
        expect(parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', '0', 30)).toBe(0);
        expect(parsePoolSeconds('DB_POOL_MAX_LIFETIME', '86400', 30)).toBe(86_400);
        expect(parsePoolSeconds('DB_CONNECTION_TIMEOUT', '5', 30)).toBe(5);
    });

    test('rejects the exact millisecond values the framework shipped through 0.5.10', () => {
        expect(() => parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', '30000', 30)).toThrow(/SECONDS/);
        expect(() => parsePoolSeconds('DB_POOL_MAX_LIFETIME', '600000', 600)).toThrow(/ms\/s mix-up/);
    });

    test('ceilings are per setting — a global cap would have missed idleTimeout=30000', () => {
        // 30 000 s is under a cap loose enough to permit a one-day maxLifetime,
        // which is why the guard is keyed by variable rather than shared.
        expect(POOL_SECONDS_MAX.DB_POOL_IDLE_TIMEOUT).toBeLessThan(30_000);
        expect(POOL_SECONDS_MAX.DB_POOL_MAX_LIFETIME).toBeGreaterThanOrEqual(86_400);
        expect(() => parsePoolSeconds('DB_CONNECTION_TIMEOUT', '30000', 30)).toThrow();
        // Same number, different setting: legal as a lifetime, illegal as idle.
        expect(parsePoolSeconds('DB_POOL_MAX_LIFETIME', '7200', 600)).toBe(7_200);
        expect(() => parsePoolSeconds('DB_CONNECTION_TIMEOUT', '7200', 30)).toThrow();
    });

    test('names the offending variable in the error so the fix is obvious', () => {
        expect(() => parsePoolSeconds('DB_POOL_MAX_LIFETIME', '600000', 600))
            .toThrow(/DB_POOL_MAX_LIFETIME/);
    });

    test('rejects non-integer and negative values', () => {
        expect(() => parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', 'abc', 30)).toThrow();
        expect(() => parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', '1.5', 30)).toThrow();
        expect(() => parsePoolSeconds('DB_POOL_IDLE_TIMEOUT', '-1', 30)).toThrow();
    });
});

describe('isPoolAcquisitionError', () => {
    test('recognises the pool-wait timeout, which is a capacity failure not a query failure', () => {
        expect(isPoolAcquisitionError(Object.assign(new Error('timeout'), {
            code: POOL_ACQUIRE_TIMEOUT_CODE,
        }))).toBe(true);
    });

    test('does not claim unrelated errors', () => {
        expect(isPoolAcquisitionError(new Error('boom'))).toBe(false);
        expect(isPoolAcquisitionError(Object.assign(new Error('x'), { code: 'ERR_POSTGRES_SYNTAX_ERROR' }))).toBe(false);
        expect(isPoolAcquisitionError(undefined)).toBe(false);
        expect(isPoolAcquisitionError(null)).toBe(false);
    });
});
