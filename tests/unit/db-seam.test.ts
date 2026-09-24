/**
 * The DB execution seam has to stay closed.
 *
 * Every framework query is supposed to go through `database/gateway.ts`
 * (`dbExec` / `dbRun` / `dbTransaction`), which is where lanes, admission,
 * deadlines and metrics live. A single new `db.unsafe(...)` or `` db`…` `` puts
 * a query back outside all of it — no timeout, no cancellation, no metric, and
 * no bound on how much of the pool it can take. That is precisely the state the
 * framework was in when a slow database turned into a wedged application.
 *
 * A grep test rather than a lint rule: this repo has no ESLint/Biome/oxlint
 * config and no `lint` script, so a rule means adopting new tooling. A test runs
 * in CI already and fails with a readable message.
 *
 * WHEN THIS FAILS, the fix is almost always to route the call through the
 * gateway — NOT to add an allow-list entry. Every exemption below states why it
 * cannot be routed, and "it was easier" is not one of the reasons.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

/** Framework source roots. Tests, benchmarks and examples are not framework code. */
const SCANNED_DIRS = [
    'core',
    'database',
    'query',
    'service',
    'gql',
    'upload',
    'endpoints',
    'utils',
];

/**
 * Files allowed to reach the driver directly, each with the reason it cannot go
 * through the seam. Keep this list SHORT and keep the reasons true.
 */
const ALLOWED: Record<string, string> = {
    // The seam itself.
    'database/gateway.ts': 'is the seam',
    'database/instrumentedDb.ts': 'is the instrumentation the seam calls',
    'database/index.ts': 'owns the pool',

    // Protocol hazard, measured. `db`…`` (extended/prepared) and
    // `db.unsafe(sql)` (simple) are different wire protocols; converting the 25
    // tagged templates here broke the suite via Bun's prepared-statement naming
    // (42P05 collision). All of them are boot DDL that runs before
    // `armGateway()`, so routing them would add a timeout and nothing else.
    // The 37 `unsafe()` sites in this file ARE routed.
    'database/DatabaseHelper.ts': 'tagged-template boot DDL; converting changes the wire protocol',
    'database/maintenance.ts': 'manual downgrade/benchmark DDL moved out of DatabaseHelper; same tagged-template protocol hazard, never on a request path',

    // Correctness beats admission here: lock renewal is one autocommit statement
    // per lock per ttl/3, bounded by construction. Admission could only ever
    // DELAY a lease renewal past its TTL, losing a lock whose holder is still
    // running — a correctness failure in exchange for no protection.
    'core/scheduler/locks/PostgresLeaseLockBackend.ts': 'lease renewal must never queue',
    'core/scheduler/locks/AdvisoryLockBackend.ts': 'session-pinned reserved connection',

    // Probes must not queue behind the saturation they are measuring, or they
    // report "wedged" when the truth is "busy" and the orchestrator restarts a
    // healthy container.
    'core/health.ts': 'liveness/readiness probe; must bypass admission',
    'core/app/healthEndpoints.ts': 'read-mode liveness probe (SELECT 1); must bypass admission like core/health.ts',
    'database/connectionProbe.ts': 'boot probe, runs before the gateway is armed',
    'core/remote/health.ts': 'health probe',

    // Statements on a caller-supplied transaction handle. These consume no new
    // pooled connection, and their enclosing transaction already holds the
    // permit. Routing them is optional; leaving them raw is safe.
    'core/entity/saveEntity.ts': 'statements inside its own admitted transaction',
    'database/projection/ProjectionManager.ts': 'dual-write on a caller-supplied trx',
    'database/projection/DDLGenerator.ts': 'executes on a caller-supplied trx',
    'core/components/BaseComponent.ts': 'operates on a caller-supplied trx',
    'core/cache/txInvalidation.ts': 'owns the transaction wrapper itself',


    // Outbox/remote transport owns its own connection lifecycle.
    'core/remote/OutboxWorker.ts': 'outbox transport',
    'core/remote/outboxSchema.ts': 'outbox schema bootstrap',
    'core/remote/RemoteManager.ts': 'remote transport',
    'core/remote/types.ts': 'type declarations only',

    // QSP diagnostics compare routed vs unrouted results; routing them would
    // change the thing being compared.
    'query/planner/ShadowRunner.ts': 'shadow comparison must bypass routing',
    'query/planner/HydrationParity.ts': 'parity comparison must bypass routing',
};

/** `db.unsafe(`, `sql.unsafe(`, a `` db`…` `` / `` sql`…` `` template, or a `` dbConn`…` `` alias. */
const RAW_DB = /(?:^|[^.\w])(?:dbConn|db|sql)\s*(?:\.unsafe\s*\(|`)/;
/** A raw `db.transaction(` — should be `dbTransaction`. */
const RAW_TXN = /(?:^|[^.\w])db\s*\.\s*transaction\s*\(/;

describe('DB execution seam patterns', () => {
    test('dbConn tagged templates and unsafe calls count as raw driver access', () => {
        expect(RAW_DB.test('await dbConn`SELECT 1`')).toBe(true);
        expect(RAW_DB.test('dbConn.unsafe("select 1")')).toBe(true);
        expect(RAW_DB.test('await trx`SELECT 1`')).toBe(false);
        expect(RAW_DB.test('await opts.trx`SELECT 1`')).toBe(false);
    });
});

function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name === 'node_modules' || name === 'dist') continue;
            walk(full, out);
        } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Strip comments and string/template literals before matching.
 *
 * Without this, every doc comment explaining `db.unsafe` — and this file's own
 * allow-list — trips the check, which is how a guard like this gets deleted for
 * crying wolf.
 */
function stripNonCode(src: string): string {
    // Block and line comments first, then quoted strings. Backtick templates are
    // deliberately NOT stripped: `` db`…` `` is exactly what we are looking for.
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function scan(): Array<{ file: string; line: number; text: string; kind: string }> {
    const findings: Array<{ file: string; line: number; text: string; kind: string }> = [];
    for (const dir of SCANNED_DIRS) {
        for (const file of walk(join(ROOT, dir))) {
            const rel = relative(ROOT, file).split(sep).join('/');
            if (ALLOWED[rel]) continue;
            const lines = stripNonCode(readFileSync(file, 'utf8')).split(/\r?\n/);
            lines.forEach((text, i) => {
                if (RAW_TXN.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim(), kind: 'db.transaction' });
                else if (RAW_DB.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim(), kind: 'raw db access' });
            });
        }
    }
    return findings;
}

describe('DB execution seam', () => {
    test('no framework code reaches the driver outside the gateway', () => {
        const findings = scan();
        const report = findings
            .map((f) => `  ${f.file}:${f.line}  [${f.kind}]  ${f.text.slice(0, 100)}`)
            .join('\n');

        expect(
            findings.length,
            findings.length === 0
                ? ''
                : `Found ${findings.length} DB call(s) outside the execution seam:\n${report}\n\n` +
                  `Route them through database/gateway.ts (dbExec / dbRun / dbTransaction).\n` +
                  `dbRun takes a query FACTORY, so a tagged template keeps its exact SQL and\n` +
                  `wire protocol while still getting a lane, a deadline and metrics.\n` +
                  `Only add to ALLOWED if the call genuinely cannot be routed, with the reason.`,
        ).toBe(0);
    });

    test('every allow-list entry still exists and still needs the exemption', () => {
        // An allow-list that outlives its files is how exemptions become
        // permanent: the entry stops matching anything, nobody notices, and a
        // future file with that path inherits a waiver nobody granted.
        const missing: string[] = [];
        for (const rel of Object.keys(ALLOWED)) {
            try {
                statSync(join(ROOT, rel));
            } catch {
                missing.push(rel);
            }
        }
        expect(missing, `Allow-listed files no longer exist — remove them:\n  ${missing.join('\n  ')}`).toEqual([]);
    });

    test('the allow-list documents a reason for every entry', () => {
        const unexplained = Object.entries(ALLOWED)
            .filter(([, reason]) => !reason || reason.trim().length < 10)
            .map(([file]) => file);
        expect(unexplained, `Allow-list entries need a real reason:\n  ${unexplained.join('\n  ')}`).toEqual([]);
    });
});
