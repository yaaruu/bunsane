/**
 * SEC-04: CORS wildcard+credentials must fail closed.
 *
 * The old behaviour warned and then reflected any request Origin verbatim —
 * every origin could make credentialed cross-origin reads. These tests pin
 * the refusal at config time AND the defence-in-depth check at header time.
 */
import { describe, test, expect } from 'bun:test';
import {
    assertValidCorsConfig,
    validateOrigin,
    getCorsHeaders,
} from '../../core/app/cors';
import type { CorsConfig } from '../../core/App';

describe('assertValidCorsConfig', () => {
    test('wildcard + credentials throws with guidance', () => {
        expect(() =>
            assertValidCorsConfig({ origin: '*', credentials: true })
        ).toThrow(/credentials=true with origin="\*" is not supported/);
    });

    test('explicit list + credentials is accepted', () => {
        expect(() =>
            assertValidCorsConfig({
                origin: ['https://app.example.com'],
                credentials: true,
            })
        ).not.toThrow();
    });

    test('missing origin still throws', () => {
        expect(() =>
            assertValidCorsConfig({} as CorsConfig)
        ).toThrow(/origin.*is required/i);
    });
});

describe('validateOrigin defence in depth', () => {
    test('never reflects request Origin when wildcard+credentials', () => {
        const cors: CorsConfig = { origin: '*', credentials: true };
        expect(validateOrigin(cors, 'https://evil.example')).toBeNull();
        expect(validateOrigin(cors, 'null')).toBeNull();
    });

    test('wildcard without credentials returns "*"', () => {
        const cors: CorsConfig = { origin: '*' };
        expect(validateOrigin(cors, 'https://any.example')).toBe('*');
    });

    test('exact string match allows only that origin', () => {
        const cors: CorsConfig = {
            origin: 'https://app.example.com',
            credentials: true,
        };
        expect(validateOrigin(cors, 'https://app.example.com')).toBe('https://app.example.com');
        expect(validateOrigin(cors, 'https://evil.example')).toBeNull();
    });

    test('array membership', () => {
        const cors: CorsConfig = {
            origin: ['https://a.example', 'https://b.example'],
            credentials: true,
        };
        expect(validateOrigin(cors, 'https://b.example')).toBe('https://b.example');
        expect(validateOrigin(cors, 'https://c.example')).toBeNull();
    });

    test('function predicate decides', () => {
        const cors: CorsConfig = {
            origin: (o: string) => o.endsWith('.example'),
            credentials: true,
        };
        expect(validateOrigin(cors, 'https://ok.example')).toBe('https://ok.example');
        expect(validateOrigin(cors, 'https://bad.org')).toBeNull();
    });

    test('no request Origin → no ACAO decision', () => {
        expect(validateOrigin({ origin: '*' }, null)).toBeNull();
    });
});

describe('getCorsHeaders never emits the toxic combination', () => {
    test('wildcard+credentials yields no ACAO at all', () => {
        const headers = getCorsHeaders(
            { origin: '*', credentials: true },
            new Request('https://srv/x', {
                headers: { Origin: 'https://evil.example' },
            }),
        );
        expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
        expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    test('listed origin gets reflected origin plus credentials', () => {
        const headers = getCorsHeaders(
            { origin: ['https://good.example'], credentials: true },
            new Request('https://srv/x', {
                headers: { Origin: 'https://good.example' },
            }),
        );
        expect(headers['Access-Control-Allow-Origin']).toBe('https://good.example');
        expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    });
});
