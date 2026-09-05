/**
 * Pure analysis helpers for the Studio ad-hoc SQL runner (SEC-02).
 *
 * No database imports — everything here is string/text analysis so unit tests
 * can run without a connection. The runner uses these BEFORE executing:
 *
 *  - `stripSqlLiterals` neutralises comments, string literals and dollar-quoted
 *    bodies so keyword scans and semicolon detection cannot be fooled by text
 *    hidden inside them (the old `\bLIMIT\b` / blacklist regexes were);
 *  - `findTopLevelSemicolons` rejects multi-statement payloads, which matter
 *    because param-less statements run through Bun's simple protocol;
 *  - `assertRunnableSingleSelect` combines both plus an extended keyword
 *    blacklist (SET/CALL/VACUUM/MERGE/… were never covered).
 */

const FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
    'GRANT', 'REVOKE', 'COPY', 'EXECUTE', 'DO',
    // Missing from the original blacklist.
    'SET', 'CALL', 'LOCK', 'VACUUM', 'ANALYZE', 'ANALYSE', 'MERGE', 'NOTIFY',
    'LISTEN', 'UNLISTEN', 'LOAD', 'CLUSTER', 'REINDEX', 'COMMENT', 'REFRESH',
] as const;

interface ScanState {
    /** Text safe for keyword/semicolon analysis (literals blanked). */
    stripped: string[];
    inSingle: boolean;
    inDouble: boolean;
    inLineComment: boolean;
    inBlockComment: boolean;
    /** Dollar-quote tag currently open, e.g. '$$' or '$fn$'. */
    dollarTag: string | null;
}

function isDollarTagStart(sql: string, i: number): string | null {
    if (sql[i] !== '$') return null;
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/.exec(sql.slice(i));
    return match ? match[0] : null;
}

/**
 * Return `sql` with the contents of string literals, quoted identifiers,
 * comments and dollar-quoted bodies replaced by spaces. Statement structure
 * (semicolons, keywords, parentheses) outside those regions is preserved.
 */
export function stripSqlLiterals(sql: string): string {
    const s: ScanState = {
        stripped: [],
        inSingle: false,
        inDouble: false,
        inLineComment: false,
        inBlockComment: false,
        dollarTag: null,
    };

    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i]!;
        const next = sql[i + 1];

        if (s.inLineComment) {
            if (ch === '\n') { s.inLineComment = false; s.stripped.push('\n'); }
            else s.stripped.push(' ');
            continue;
        }
        if (s.inBlockComment) {
            if (ch === '*' && next === '/') { s.inBlockComment = false; s.stripped.push('  '); i++; }
            else s.stripped.push(ch === '\n' ? '\n' : ' ');
            continue;
        }
        if (s.inSingle) {
            if (ch === "'" && next === "'") { s.stripped.push('  '); i++; continue; }
            if (ch === "'") { s.inSingle = false; }
            s.stripped.push(ch === '\n' ? '\n' : ' ');
            continue;
        }
        if (s.inDouble) {
            if (ch === '"' && next === '"') { s.stripped.push('  '); i++; continue; }
            if (ch === '"') { s.inDouble = false; }
            s.stripped.push(ch === '\n' ? '\n' : ' ');
            continue;
        }
        if (s.dollarTag !== null) {
            const tag = s.dollarTag;
            if (sql.startsWith(tag, i)) {
                s.dollarTag = null;
                i += tag.length - 1;
                s.stripped.push(' '.repeat(tag.length));
                continue;
            }
            s.stripped.push(ch === '\n' ? '\n' : ' ');
            continue;
        }

        // Normal code region.
        if (ch === '-' && next === '-') { s.inLineComment = true; s.stripped.push('  '); i++; continue; }
        if (ch === '/' && next === '*') { s.inBlockComment = true; s.stripped.push('  '); i++; continue; }
        if (ch === "'") { s.inSingle = true; s.stripped.push(' '); continue; }
        if (ch === '"') { s.inDouble = true; s.stripped.push(' '); continue; }
        const tag = isDollarTagStart(sql, i);
        if (tag) { s.dollarTag = tag; s.stripped.push(' '.repeat(tag.length)); i += tag.length - 1; continue; }
        s.stripped.push(ch);
    }

    return s.stripped.join('');
}

/** Offsets of `;` that sit outside literals/comments (i.e. statement breaks). */
export function findTopLevelSemicolons(stripped: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < stripped.length; i++) {
        if (stripped[i] === ';') out.push(i);
    }
    return out;
}

export interface SqlGuardResult {
    ok: boolean;
    status: number;
    error?: string;
    /**
     * The executable single statement: original text minus any trailing
     * semicolon (comments preserved — they are harmless once we wrap).
     */
    statement?: string;
}

/**
 * Vet a user-supplied statement for execution by the studio runner:
 * single statement, no forbidden keywords outside literals/comments.
 */
export function assertRunnableSingleSelect(rawSql: string): SqlGuardResult {
    const trimmed = rawSql.trim();
    if (!trimmed) {
        return { ok: false, status: 400, error: 'SQL query is required' };
    }

    const stripped = stripSqlLiterals(trimmed);

    const semicolons = findTopLevelSemicolons(stripped);
    let statement = trimmed;

    if (semicolons.length > 1) {
        return {
            ok: false,
            status: 400,
            error: 'Only a single SQL statement is allowed',
        };
    }
    if (semicolons.length === 1) {
        const pos = semicolons[0]!;
        // Anything meaningful AFTER the terminator means a second, unterminated
        // statement (e.g. `SELECT 1; DELETE x`) — simple protocol would run it.
        if (/\S/.test(stripped.slice(pos + 1))) {
            return {
                ok: false,
                status: 400,
                error: 'Only a single SQL statement is allowed',
            };
        }
        statement = trimmed.slice(0, pos);
    }

    const upper = stripped.toUpperCase();
    for (const kw of FORBIDDEN_KEYWORDS) {
        if (new RegExp(`\\b${kw}\\b`).test(upper)) {
            return {
                ok: false,
                status: 400,
                error: 'Only read-only (SELECT/WITH) queries are allowed',
            };
        }
    }

    return { ok: true, status: 200, statement };
}
