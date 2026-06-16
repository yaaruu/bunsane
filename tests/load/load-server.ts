/**
 * Load-test server for k6. Boots a FULL BunSane app (init + start) with a
 * REST service that drives the real Entity.save / Query paths end-to-end over
 * HTTP — so k6 measures the whole stack (HTTP + router + Entity + DB), not the
 * in-process Query layer the stress harness exercises.
 *
 * Endpoints:
 *   POST /load/write          create entity (StressUser + StressProfile), save  -> {id}
 *   POST /load/update         update a random seeded entity's bio (upsert path) -> {ok}
 *   GET  /load/read           Query StressUser by status (per-field index)       -> {count}
 *   GET  /load/gin?on=true    toggle whole-data GIN index (A/B without restart)  -> {gin}
 *   POST /load/seed?n=5000    seed N more entities into the id pool              -> {seeded,total}
 *   POST /load/cleanup        delete every entity this server created            -> {deleted}
 *
 * Run (real Postgres via pgbouncer in .env.test):
 *   DB_DISABLE_PREPARE=true LOG_LEVEL=warn CACHE_PROVIDER=noop APP_PORT=19900 \
 *     bun --env-file=.env.test tests/load/load-server.ts
 */
import App from "../../core/App";
import ServiceRegistry from "../../service/ServiceRegistry";
import BaseService from "../../service/Service";
import { httpEndpoint } from "../../rest";
import { Entity } from "../../core/Entity";
import { Query, FilterOp } from "../../query/Query";
import { DataSeeder } from "../stress/DataSeeder";
// Importing the fixtures registers @Component metadata; App.init() then
// creates their partition tables + per-field indexes.
import { StressUser, StressProfile } from "../stress/fixtures/StressTestComponents";
import db from "../../database";

const PORT = parseInt(process.env.APP_PORT || "19900", 10);
const SEED_AT_BOOT = parseInt(process.env.LOAD_SEED || "3000", 10);
const STATUSES = ["active", "inactive", "pending", "suspended"];

// In-memory pool of ids this server created (seed + writes). Updates/reads
// target it. Plain array; single process, no locking needed.
const idPool: string[] = [];
let counter = 0;

function genUser(i: number): Record<string, any> {
    return {
        name: `User ${i}`,
        email: `user${i}@example.com`,
        age: 18 + (i % 60),
        status: STATUSES[i % STATUSES.length],
        score: (i * 2654435761) % 10000,
        createdAt: new Date(),
    };
}
function genProfile(i: number): Record<string, any> {
    return { bio: `Bio ${i}`, avatarUrl: `https://cdn/${i}.png`, verified: i % 3 === 0 };
}
function pickId(): string | undefined {
    if (idPool.length === 0) return undefined;
    return idPool[(Math.random() * idPool.length) | 0];
}

class LoadTestService extends BaseService {
    @httpEndpoint({ method: "POST", path: "/load/write" })
    async write() {
        const n = counter++;
        const e = Entity.Create();
        e.add(StressUser, genUser(n));
        e.add(StressProfile, genProfile(n));
        await e.save();
        idPool.push(e.id);
        return { id: e.id };
    }

    @httpEndpoint({ method: "POST", path: "/load/update" })
    async update() {
        const id = pickId();
        if (!id) return { ok: false, reason: "empty pool" };
        const e = await Entity.FindById(id);
        if (!e) return { ok: false, reason: "not found" };
        await e.set(StressProfile, { bio: `rev-${counter++}` });
        await e.save();
        return { ok: true };
    }

    @httpEndpoint({ method: "GET", path: "/load/read" })
    async read() {
        const rows = await new Query()
            .with(StressUser, { filters: [{ field: "status", operator: FilterOp.EQ, value: "active" }] })
            .take(50)
            .exec();
        return { count: rows.length };
    }

    @httpEndpoint({ method: "GET", path: "/load/gin" })
    async gin(req: Request) {
        const on = new URL(req.url).searchParams.get("on") === "true";
        if (on) {
            await db.unsafe("CREATE INDEX IF NOT EXISTS idx_components_data_gin ON components USING GIN (data)");
        } else {
            await db.unsafe("DROP INDEX IF EXISTS idx_components_data_gin");
        }
        return { gin: on };
    }

    @httpEndpoint({ method: "POST", path: "/load/seed" })
    async seed(req: Request) {
        const n = parseInt(new URL(req.url).searchParams.get("n") || "1000", 10);
        await seedEntities(n);
        return { seeded: n, total: idPool.length };
    }

    @httpEndpoint({ method: "POST", path: "/load/cleanup" })
    async cleanup() {
        const seeder = new DataSeeder();
        const deleted = idPool.length;
        await seeder.cleanup([...idPool], 5000);
        idPool.length = 0;
        return { deleted };
    }
}

async function seedEntities(n: number): Promise<void> {
    const seeder = new DataSeeder();
    const base = counter;
    const res = await seeder.seed(StressUser, (i) => genUser(base + i), {
        totalEntities: n,
        batchSize: Math.min(1000, n),
    });
    await seeder.seedAdditionalComponent(res.entityIds, StressProfile, (i) => genProfile(base + i), 1000);
    counter += n;
    idPool.push(...res.entityIds);
}

async function main() {
    const app = new App("BunSane Load Server", "0.0.1");
    ServiceRegistry.registerService(new LoadTestService());

    console.log("Initializing app (DB + components + schema)...");
    // app.init() drives the lifecycle to APPLICATION_READY, which AUTO-starts
    // the HTTP server (bootstrap.runApplicationReadyPhase -> app.start()). Do
    // NOT call app.start() again here — that double-binds APP_PORT (EADDRINUSE).
    await app.init();

    if (SEED_AT_BOOT > 0) {
        console.log(`Seeding ${SEED_AT_BOOT} entities...`);
        const t0 = performance.now();
        await seedEntities(SEED_AT_BOOT);
        console.log(`Seeded ${idPool.length} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    }

    console.log(`Load server ready on http://localhost:${PORT}  (pool=${idPool.length})`);
}

main().catch((err) => {
    console.error("Load server failed:", err);
    process.exit(1);
});
