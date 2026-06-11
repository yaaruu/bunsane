// End-to-end check of the partition strategy switch guard against the DB in
// .env.test: CreateComponentTable() must REFUSE (throw) when the requested
// strategy differs from the live table's strategy and the table contains data,
// leaving table + data untouched.
// Run: bun scripts/verify-partition-guard.ts
// Lives as a script because calling CreateComponentTable() inside bun:test
// wedges the DB connection (see tests/integration/database/PartitionStrategyGuard.test.ts).
const envFile = await Bun.file(".env.test").text();
for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const { CreateComponentTable, GetPartitionStrategy } = await import("../database/DatabaseHelper");
const db = (await import("../database")).default;

const strategyBefore = await GetPartitionStrategy();
const rowsBefore = (await db.unsafe(`SELECT COUNT(*)::int AS n FROM components`))[0].n;
console.log(`[verify] strategy: ${strategyBefore}, component rows: ${rowsBefore}`);

if (rowsBefore === 0) {
    console.log("[verify] SKIP — components table empty, guard only protects non-empty tables");
    process.exit(0);
}

process.env.BUNSANE_PARTITION_STRATEGY = strategyBefore === "hash" ? "list" : "hash";
delete process.env.BUNSANE_FORCE_PARTITION_RECREATE;

let failed = false;
const t0 = performance.now();
try {
    await CreateComponentTable();
    console.error("[verify] FAIL — CreateComponentTable did not throw on strategy mismatch with data");
    failed = true;
} catch (e: any) {
    const ok = /Refusing to recreate 'components' table/.test(e.message);
    console.log(`[verify] threw after ${Math.round(performance.now() - t0)}ms (${ok ? "expected" : "UNEXPECTED"} error):`, e.message.slice(0, 120));
    if (!ok) failed = true;
}

const strategyAfter = await GetPartitionStrategy();
const rowsAfter = (await db.unsafe(`SELECT COUNT(*)::int AS n FROM components`))[0].n;
console.log(`[verify] after: strategy ${strategyAfter}, rows ${rowsAfter}`);
if (strategyAfter !== strategyBefore || rowsAfter !== rowsBefore) {
    console.error("[verify] FAIL — table or data changed");
    failed = true;
}

console.log(failed ? "[verify] FAILED" : "[verify] PASSED");
process.exit(failed ? 1 : 0);
