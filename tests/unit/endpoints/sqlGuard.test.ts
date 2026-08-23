/**
 * SEC-02: SQL vetting for the Studio ad-hoc query runner.
 *
 * Pure-function tests — no database. The old implementation regex-tested raw
 * text, so a keyword or "LIMIT" hidden inside a comment/string literal could
 * bypass every control; these pin the literal-aware replacement.
 */
import { describe, test, expect } from 'bun:test';
import {
    stripSqlLiterals,
    findTopLevelSemicolons,
    assertRunnableSingleSelect,
} from '../../../endpoints/sqlGuard';

describe('stripSqlLiterals', () => {
    test('blanks line comments', () => {
        const stripped = stripSqlLiterals('SELECT 1 -- DROP TABLE x');
        expect(stripped.includes('DROP')).toBe(false);
        expect(stripped.toUpperCase()).toContain('SELECT 1');
    });

    test('comment content cannot be found afterwards', () => {
        const stripped = stripSqlLiterals('SELECT 1 /* LIMIT 999999 */');
        expect(stripped.includes('LIMIT')).toBe(false);
        expect(stripped.toUpperCase()).toContain('SELECT');
    });

    test('string literal contents are blanked but quotes preserved as space', () => {
        const stripped = stripSqlLiterals("SELECT 'DELETE FROM t' AS k");
        expect(stripped.includes('DELETE')).toBe(false);
        expect(stripped.toUpperCase()).toContain('AS K'.toUpperCase());
    });

    test('escaped quote inside string stays in-string', () => {
        const stripped = stripSqlLiterals("SELECT 'it''s; still; a string'");
        // The semicolons are inside the literal → not visible.
        expect(findTopLevelSemicolons(stripped)).toHaveLength(0);
    });

    test('dollar-quoted bodies are blanked', () => {
        const stripped = stripSqlLiterals("SELECT $$; DELETE FROM secret$$ AS k");
        expect(findTopLevelSemicolons(stripped)).toHaveLength(0);
        expect(stripped.includes('DELETE')).toBe(false);
    });

    test('tagged dollar-quote requires matching terminator', () => {
        const stripped = stripSqlLiterals("SELECT $fn$; DELETE$fn$ AS k");
        expect(findTopLevelSemicolons(stripped)).toHaveLength(0);
    });
});

describe('assertRunnableSingleSelect', () => {
    test('plain select passes and keeps its statement', () => {
        const r = assertRunnableSingleSelect('SELECT 1');
        expect(r.ok).toBe(true);
        expect(r.statement).toBe('SELECT 1');
    });

    test('trailing terminator is stripped', () => {
        const r = assertRunnableSingleSelect('SELECT 1;');
        expect(r.ok).toBe(true);
        expect(r.statement).toBe('SELECT 1');
    });

    test('trailing terminator followed by comment is stripped', () => {
        const r = assertRunnableSingleSelect('SELECT 1; -- done');
        expect(r.ok).toBe(true);
        expect(r.statement).toBe('SELECT 1');
    });

    test('multi-statement payloads are rejected', () => {
        expect(assertRunnableSingleSelect('SELECT 1; SELECT 2').ok).toBe(false);
        expect(assertRunnableSingleSelect("SELECT 'a';DELETE x").ok).toBe(false);
    });

    test('a second statement hiding behind a string literal is caught', () => {
        // stripped has one ';' but suffix is meaningful.
        const r = assertRunnableSingleSelect("SELECT 'x'; DELETE FROM t");
        expect(r.ok).toBe(false);
    });

    test('LIMIT hidden in a comment no longer suppresses anything (passes vetting)', () => {
        // Vetting must ALLOW it (comments are inert); row bounds come from wrapping.
        const r = assertRunnableSingleSelect('/* LIMIT */ SELECT generate_series(1,1000)');
        expect(r.ok).toBe(true);
    });

    test('keywords inside literals/comments do not false-positive', () => {
        expect(assertRunnableSingleSelect("SELECT 'DROP TABLE users' AS note").ok).toBe(true);
        expect(assertRunnableSingleSelect('SELECT 1 /* UPDATE */').ok).toBe(true);
    });

    test('extended blacklist catches previously-missed statements', () => {
        for (const bad of [
            'SET statement_timeout = 0',
            'CALL some_proc()',
            'VACUUM ANALYZE',
            'LOCK TABLE t IN ACCESS EXCLUSIVE MODE',
            'MERGE INTO t USING s ON true WHEN MATCHED DO NOTHING',
            'LISTEN channel',
            "LOAD 'lib.so'",
        ]) {
            const r = assertRunnableSingleSelect(bad);
            expect(r.ok, `${bad} must be rejected`).toBe(false);
        }
    });

    test('identifiers merely containing keyword substrings pass', () => {
        expect(assertRunnableSingleSelect('SELECT created_at FROM events').ok).toBe(true);
    });

    test('empty input rejected', () => {
        expect(assertRunnableSingleSelect('   ').ok).toBe(false);
    });
});
