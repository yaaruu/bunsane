# RFC: Split `core/App.ts`

**Status:** Draft
**Author:** uray@qyubit.io (drafted with Claude)
**Branch target:** `refactor/app-split` (off `main`)
**Date:** 2026-05-09
**Companion work:** `refactor/archetype-split` (commit `a886b45`) — same playbook applied to `core/ArcheType.ts`.

---

## 1. Summary

Split `core/App.ts` (1477 LOC, single God class) into a thin orchestrator (~400 LOC) plus 6–8 focused modules under `core/app/`. Public API surface (`new App(...)`, `app.use()`, `app.setCors()`, `app.start()`, `app.shutdown()`, etc.) remains byte-identical. No behavior change. Each step independently verifiable by the existing test suite.

## 2. Motivation

`App.ts` is the boot path for every entrypoint in the framework. Today it owns:

- HTTP request routing (REST + GraphQL + Studio + health + metrics + OpenAPI/Swagger UI).
- CORS validation + header injection.
- GraphQL schema build + Yoga instance creation + plugin pipe + depth/complexity limits.
- REST endpoint collection from `ServiceRegistry` + OpenAPI spec generation.
- Lifecycle phase orchestration (`DATABASE_INITIALIZING` → `DATABASE_READY` → `SYSTEM_REGISTERING` → `SYSTEM_READY` → `APPLICATION_READY`).
- Scheduler bootstrap + scheduled-task registration.
- RemoteManager bootstrap + remote handler registration.
- Process signal/error handlers (SIGTERM, SIGINT, unhandledRejection, uncaughtException).
- Graceful shutdown ordering (HTTP drain → scheduler → remote → cache → DB pool).
- Prepared-statement cache warm-up.
- Metrics aggregation (`/metrics`).

Concrete pain points observed in the file:

| Method | Lines | Concern |
|---|---|---|
| `init()` | 151–495 (~345) | Phase switch + phase listener + DB prep + component registration. Multiple nested phases each running 30–80 LOC of business logic. |
| `handleRequest()` | 663–1090 (~430) | Health, metrics, OpenAPI, Swagger UI, Studio API (4 sub-paths), static assets, REST router, GraphQL fall-through. |
| `shutdown()` | 1365–1456 (~91) | Reasonable size today but couples directly to 5 subsystems. |
| `warmUpPreparedStatementCache` | 1183–1237 | Unrelated to anything else `App` does. |
| Studio API block inside `handleRequest` | 810–917 (~107) | Belongs in `studioEndpoint` module, not request router. |

Effects today:

1. **Hard to read.** Anyone changing CORS behavior reads through 1500 LOC to find the 80 LOC that matter.
2. **Hard to test.** Health-endpoint logic, OpenAPI generation, Studio routing all require an `App` instance even though they're pure functions of state.
3. **Hard to extend.** Adding a new subsystem (e.g. tracing) means another branch in `init()` and another endpoint in `handleRequest`, growing the monolith.
4. **Coupling risk.** `handleRequest()` already references 8 modules transitively. Moving anything risks an import cycle.

## 3. Goals / Non-Goals

### Goals

- Reduce `App.ts` to ≤500 LOC.
- Each new module <500 LOC, single concern.
- Zero change to public API (`App` class methods, `CorsConfig`, `AppConfig` exports).
- Zero change to phase ordering, shutdown ordering, signal handling, or error handling.
- All extractions verified by `tsc --noEmit` clean + `bun run test:pglite` green per step.
- Each step is an independently revertable commit.

### Non-Goals

- **No DI introduction.** Project rule: singletons + global exports (per `MEMORY.md`). Extracted modules accept `App` (or its state subset) as a parameter; they do not receive an injection container.
- **No new abstractions** (router DSL, middleware framework, plugin SPI v2, etc.). This is an extraction, not a redesign.
- **No type-only changes** that would force consumer updates. `App` continues to default-export the same class.
- **No fix to existing bugs** as part of this refactor. Issues found get filed and fixed in separate PRs.

## 4. Proposed Layout

```
core/
  App.ts                    # ~400 LOC: class skeleton + public API + delegates
  app/
    cors.ts                 # ~100 LOC: validateOrigin, getCorsHeaders, addCorsHeaders, validateCorsConfig
    bootstrap.ts            # ~250 LOC: phase listener body, phase-specific handlers
    graphqlSetup.ts         # ~80  LOC: yoga instance build, depth/complexity envvar resolution
    restRegistry.ts         # ~120 LOC: REST endpoint collection from services + OpenAPI tagging
    requestRouter.ts        # ~250 LOC: handleRequest body, dispatch table, request signal plumbing
    healthEndpoints.ts      # ~80  LOC: /health, /health/ready, /health/remote handlers
    studioRouter.ts         # ~120 LOC: /studio/api/* sub-router (lifts existing block)
    metricsCollector.ts     # ~40  LOC: collectMetrics
    preparedStatementWarmup.ts # ~60 LOC: warmUpPreparedStatementCache
    processHandlers.ts      # ~80  LOC: register/unregister SIGTERM/SIGINT/unhandled/uncaught
    shutdown.ts             # ~100 LOC: shutdown body + waitForHttpDrain
```

### Module responsibilities

#### `app/cors.ts`
- `validateOrigin(config, requestOrigin) → string | null`
- `getCorsHeaders(config, req?) → Record<string, string>`
- `addCorsHeaders(response, config, req?) → Response`
- `assertValidCorsConfig(cors)` — throws if `origin === undefined`, etc.

`App` keeps `setCors` as a public method but its body becomes `assertValidCorsConfig(cors); this.config.cors = cors;`. CORS state lives on `App.config.cors`; pure functions take it as a parameter.

#### `app/bootstrap.ts`
- `runDatabaseReadyPhase(app)` — wraps `warmUpPreparedStatementCache`.
- `runSystemReadyPhase(app)` — cache health check, GraphQL setup (delegates to `graphqlSetup`), scheduler init, remote init, REST endpoint collection (delegates to `restRegistry`), final `setPhase(APPLICATION_READY)`.
- `runApplicationReadyPhase(app)` — `app.start()` outside test env.
- `createPhaseListener(app)` returns the closure currently inlined inside `init()`.

`App.init()` becomes:
```ts
async init() {
  this.openAPISpecGenerator = new OpenAPISpecGenerator(...);
  this.registerProcessHandlers();
  validateEnv();
  if (this.cacheConfig) await CacheManager.initialize({ ...defaultCacheConfig, ...this.cacheConfig });
  for (const plugin of this.plugins) plugin.init?.(this);
  this.phaseListener = createPhaseListener(this);
  ApplicationLifecycle.addPhaseListener(this.phaseListener);
  if (currentPhase === DATABASE_INITIALIZING) {
    if (!(await HasValidBaseTable())) await PrepareDatabase();
    else await EnsureDatabaseMigrations();
    ApplicationLifecycle.setPhase(DATABASE_READY);
    await ComponentRegistry.registerAllComponents();
    ApplicationLifecycle.setPhase(SYSTEM_REGISTERING);
  }
}
```

#### `app/requestRouter.ts`
- `handleRequest(app, req)` — top-level dispatcher. Pulls path/method, attaches abort signal, runs the dispatch table.
- Dispatch table lives here as a `Map<string, (app, req, url) => Promise<Response>>` for static paths plus regex for dynamic REST.
- Calls `healthEndpoints`, `studioRouter`, `metricsCollector`, OpenAPI/docs handlers.

This is the largest extraction — and the one with the highest risk because of subtle order-dependence. Mitigation: keep every `if (url.pathname === ...)` branch in the same order in the new module. No reordering.

#### `app/healthEndpoints.ts`
- `handleHealth()`, `handleReady(app)`, `handleRemoteHealth(app)`.

Each returns `{ result, httpStatus }` so the router applies CORS uniformly. Today these are inline blocks; they become 8–10 LOC functions.

#### `app/studioRouter.ts`
- `routeStudio(app, url, req, method) → Promise<Response | null>` — returns `null` if not a studio path so the main router falls through.
- Today: 107 LOC inline in `handleRequest`. Lifted with no change.

#### `app/processHandlers.ts`
- `registerProcessHandlers(app)`, `unregisterProcessHandlers(app)`.
- Returns and stores handler refs on `app` (same shape as today).

#### `app/shutdown.ts`
- `shutdown(app)` body (HTTP drain → scheduler → remote → cache → DB → lifecycle disposal → handler unregister).
- `waitForHttpDrain(server, timeoutMs)`.

### Cross-cutting decisions

- **`App` instance passed by reference.** Extracted functions take `app: App` (or a typed slice) and mutate state via existing setters/fields. We do not refactor private fields into a separate `AppState` type — that's a non-goal change.
- **No lazy require for these.** Unlike the ArcheType extraction (which had circular type deps with `BaseArcheType`), the App extractions are leaves: they import `App` only as a type. Use `import type { default as App } from "../App"` to avoid runtime cycles.
- **Logger reuse.** Each module creates its own child logger: `MainLogger.child({ scope: "App.cors" })`. Matches existing `scope: 'app'` conventions in the file.
- **Error semantics preserved exactly.** The `SYSTEM_READY` failure path (line 451–467) is load-bearing — it sets `isReady=false`, logs fatal, and `process.exit(1)` outside test env (memory: H-K8S-1 / C09). Extraction keeps this exit path intact and tested.

## 5. Migration Plan

Each step is a separate commit on `refactor/app-split`. Run `tsc --noEmit` and `bun run test:pglite` between steps. Skip a step if its preconditions aren't met after the prior commit.

### Step 1 — `cors.ts` (lowest risk, smallest blast)
- Move `validateOrigin`, `getCorsHeaders`, `addCorsHeaders` to `core/app/cors.ts`.
- Each takes `app.config.cors` (or a `CorsConfig`) explicitly; no `this`.
- `App` methods become 1-line delegates.
- **Verify:** existing CORS tests pass. Check `tests/e2e` for CORS assertions.

### Step 2 — `processHandlers.ts`
- Lift `registerProcessHandlers` / `unregisterProcessHandlers`.
- **Verify:** signal handler tests if any; otherwise sanity-test by sending SIGINT in a dev run.

### Step 3 — `shutdown.ts` + `waitForHttpDrain`
- Lift the entire `shutdown()` body + helper.
- `App.shutdown()` becomes `return runShutdown(this)`.
- **Verify:** shutdown ordering tests (memory: C10, C14 referenced).

### Step 4 — `metricsCollector.ts` + `preparedStatementWarmup.ts`
- Pure leaves. Move and re-import.
- **Verify:** `/metrics` endpoint test (E2E).

### Step 5 — `healthEndpoints.ts`
- Move `/health`, `/health/ready`, `/health/remote` handlers.
- Each returns `{ result, httpStatus }`; router wraps in `Response` with CORS.
- **Verify:** health endpoint tests (`tests/e2e`).

### Step 6 — `studioRouter.ts`
- Lift the entire `if (this.studioEnabled && pathname.startsWith("/studio/api/"))` block.
- **Verify:** Studio is opt-in (`enableStudio()`) so most tests don't exercise it. Manual smoke test with `STUDIO_ENABLED=true` env.

### Step 7 — `graphqlSetup.ts` + `restRegistry.ts`
- Extract Yoga instance build + GraphQL depth/complexity envvar resolution.
- Extract REST endpoint collection loop (lines 347–446) including OpenAPI spec generation per endpoint.
- **Verify:** GraphQL schema tests (`bun run test:graphql`), REST endpoint tests.

### Step 8 — `bootstrap.ts`
- Move the `switch (phase)` body into per-phase functions.
- `App.init()` shrinks to the skeleton above.
- **Highest risk step** — this is where lifecycle ordering bugs would surface. Mitigation: do this last, after all leaves are extracted, so any test failure isolates to the orchestrator.
- **Verify:** full test suite. Pay attention to `tests/integration` (boot-sensitive).

### Step 9 — `requestRouter.ts`
- Move `handleRequest` body. By this point everything it calls is already extracted, so this is largely cut/paste.
- `App.handleRequest()` becomes `return handleRequest(this, req)`.
- **Verify:** every E2E test (HTTP path coverage).

### Order rationale

Leaves first (cors, processHandlers, shutdown, metrics, prepStmtWarmup, healthEndpoints, studioRouter), then composites (graphqlSetup, restRegistry), then orchestrators (bootstrap, requestRouter). This minimizes the number of in-flight extractions when the riskiest steps run.

## 6. Verification Strategy

For every step:

1. `tsc --noEmit` — must show only the 4 pre-existing `gql/index.ts` errors.
2. `bun run test:pglite` — full suite (currently 770 pass / 0 fail post-archetype-split).
3. `bun run test:e2e` — covers HTTP routing, CORS, health, OpenAPI.
4. Manual smoke at the end: `bun examples/<some-app>/index.ts`, hit `/health`, `/openapi.json`, `/graphql`.
5. **Lifecycle assertion:** before & after Step 8 + Step 9, capture the printed phase log on a clean boot and `diff` them. Phase order must be byte-identical.

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Phase listener ordering bug in `bootstrap.ts` extraction | High | Step 8 done last, after every dependency lifted. `diff` the boot log before/after. |
| Studio path order in `requestRouter` changes a fall-through | Medium | Keep branch order identical; extract as one block, not per-handler. |
| `handleRequest` abort-signal plumbing breaks | Medium | The signal-combine logic stays in the router (not split). Test with deliberate slow handlers. |
| Import cycle between `App` and `bootstrap` (or `requestRouter`) | Medium | Use `import type` for `App` in extracted modules. Verified by `tsc --noEmit` per step. |
| `setRemoteManager(null)` in shutdown is missed | Low | Lifted as part of `shutdown.ts`; verified by remote-shutdown tests. |
| `process.exit(1)` path on SYSTEM_READY failure removed accidentally | High | Step 8 includes a regression test asserting that `runSystemReadyPhase` rethrows in `NODE_ENV=test`. |
| Hidden coupling: `composedHandler` set in `start()` but bound to `handleRequest` | Medium | Keep the `bind(this)` site in `App.start()` (not in `requestRouter`). The function `handleRequest` is exported from the module but the bound reference lives on `App`. |

## 8. Rollback

Each step is a single commit. Roll back with `git revert <sha>`. Because every step preserves the public API, partial rollback (steps 1–6 kept, 7–9 reverted) is also safe.

If the whole branch needs to be abandoned: `git checkout main; git branch -D refactor/app-split`. No state outside git.

## 9. Out of Scope (Follow-ups)

Items observed during analysis but explicitly not addressed here:

- **`handleRequest` cyclomatic complexity.** Even after extraction, `requestRouter` has ~15 branches. Could later be a registration-based dispatch (`app.registerRoute(method, path, handler)`) — but that's a feature, not a refactor.
- **`enforceDocs` warning text.** Hardcoded "Don't use this endpoint until it's properly documented!" in `init()`. Extraction preserves it; cleanup is separate.
- **Studio API duplication.** Several `studio/api/*` paths repeat the same `parseInt(url.searchParams.get(...))` pattern. After extraction these are obvious to dedupe — but again, separate PR.
- **Metrics shape.** `/metrics` returns ad-hoc JSON. Prometheus exposition format is a future concern.
- **Prepared-statement warmup heuristics.** "First 5 components, first 3 for multi-component" is arbitrary. Tunable later.

## 10. Decision Required

- [ ] Approve scope and 9-step plan.
- [ ] Approve module names / locations under `core/app/`.
- [ ] Confirm: no public API change, no behavior change, no DI introduction.

Once approved, work proceeds on `refactor/app-split` with one commit per step. Estimated effort: 4–6 focused hours given the test suite already in place.
