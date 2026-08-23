# Tickets: Security Audit Hardening

**Status:** All open  
**Date:** 2026-08-23  
**Basis:** Full-repo security audit; every finding verified directly against source (see audit session notes). No live exploitation was performed.  
**Scope:** Framework surfaces: endpoints/, core/app/, core/middleware/, gql/, query/, storage/, upload/, core/cache/, core/remote/. App-authored resolvers out of scope except where the framework provides no guardrail.  

### Consensus priorities

| Order | Ticket | Effort | Impact | Depends on |
|------:|--------|--------|--------|------------|
| 1 | **SEC-01** Studio API authentication + static gating | S | Highest (unauth data dump/delete) | — |
| 2 | **SEC-02** Ad-hoc SQL runner: opt-in flag + real limits | S | Highest (raw SQL console) | — |
| 3 | **SEC-03** Filter/sort identifier & operator allow-listing | M | High (SQL injection primitives) | — |
| 4 | **SEC-04** CORS wildcard+credentials reflection | S | High (credentialed cross-origin reads) | — |
| 5 | **SEC-05** Rate-limit key trust (`X-Real-IP` / `anonymous`) | S | High (bypass + shared-bucket DoS) | — |
| 6 | **SEC-06** GraphQL upload validation bypass | S | High (size/MIME checks skipped) | — |
| 7 | **SEC-07** Local storage path containment | S | Medium-High (traversal, Windows) | — |
| 8 | **SEC-08** Fail-closed error masking | S | Medium-High (stack/SQL leakage) | — |
| 9 | **SEC-09** GraphQL recon surface (introspection/GraphiQL/complexity) | M | Medium (recon + DoS) | — |
| 10 | **SEC-10** Info endpoints (`/metrics`, `/health`, Swagger) | S | Medium (internals disclosure, write amplification) | — |
| 11 | **SEC-11** Pub/sub invalidation authenticity (HMAC) | S | Medium-High (cluster cache wipe) | — |
| 12 | **SEC-12** RPC/outbox trust boundary documentation + signing | M | Medium-High (impersonation/replay) | — |
| 13 | **SEC-13** Cache pattern-invalidation DoS bounds | S | Medium | — |
| 14 | **SEC-14** Request body limits + REST upload streaming | S | Medium (memory DoS) | — |
| 15 | **SEC-15** Security headers default-on | S | Medium | — |
| 16 | **SEC-16** Env validation hardening | S | Medium (config footguns) | — |
| 17 | **SEC-17** Low-severity hardening sweep | S | Low | — |

Each ticket ships alone. Tests run under `bun tests/pglite-setup.ts tests/unit/...` and, where SQL behaviour matters, `bun run test:pg`.

---

## SEC-01 — Studio API: authenticate and gate the whole surface

### Problem
`core/app/studioRouter.ts:9` gates `/studio/api/*` only on `app.studioEnabled`. There is no auth, token, or ACL anywhere in the chain:

- `endpoints/tables.ts:93,103,110,119` — `SELECT * FROM "${tableName}"` with tableName taken raw from the URL path segment (`studioRouter.ts:51`). Any public table can be dumped, including framework tables hidden from the *listing* (the listing filter at `tables.ts:192-205` excludes them but direct paths still work).
- `endpoints/tables.ts:164` — `DELETE FROM "${tableName}" WHERE id IN (...)`: quote-breakable identifier, arbitrary table.
- `endpoints/archetypes.ts:374-395` — body-supplied `entityIds` are deleted from `components`/`entities` without ever checking they belong to the archetype named in the URL.
- `core/App.ts:133-142` — studio static assets are registered whenever `studio/dist` exists, regardless of `enableStudio()`, so the UI shell is served even on apps that never opted into studio.

### Goal
Studio becomes deny-by-default and authenticated. An app must both call `enableStudio()` AND configure a credential; without it, every studio route (API and assets) returns 404/401.

### Files
| Path | Change |
|------|--------|
| `core/App.ts` | New `enableStudio({ token })` (or `studioAuthToken` setter). Store token; pass to router. Only call `addStaticAssets("/studio", …)` when studio is enabled. |
| `core/app/studioRouter.ts` | Before any route: if no token configured → 404. If `Authorization: Bearer <token>` (or `x-studio-token`) mismatches → 401. Constant-time compare (`crypto.timingSafeEqual` over SHA-256 digests). |
| `endpoints/archetypes.ts` | Validate each requested entityId belongs to the named archetype (join through `components` by type_id) before delete; reject mismatches. |
| `endpoints/tables.ts` | Allow-list `tableName` against actual `public` tables returned by the same information_schema query used for listing (including the framework exclusions), so hidden tables are hidden consistently. |
| `docs/CONFIGURATION.md` | Document `enableStudio()` contract: off = nothing served; on = token required. |

### Acceptance criteria
- [ ] With studio never enabled: `GET /studio` (assets), `GET /studio/api/tables`, `POST /studio/api/query` all return 404.
- [ ] With studio enabled and no token configured: all `/studio/api/*` return 404 (deny-by-default).
- [ ] With token configured: requests without/mismatched token → 401; correct token passes; comparison is timing-safe.
- [ ] `DELETE /studio/api/table/<name>` rejects ids not present in `<name>`'s archetype scope; `arche-type` delete refuses foreign entityIds.
- [ ] Direct path to an excluded table (`/studio/api/table/entities`) returns 404.
- [ ] E2E test covering all four states (off / on-no-token / bad-token / good-token).

---

## SEC-02 — Ad-hoc SQL runner: explicit opt-in, real row limits

### Problem
`endpoints/query.ts` exposes a raw-SQL console behind only two weak guards:

- Line 14: enabled whenever `NODE_ENV !== 'production'` — unset (common in dev containers, CI, staging images built without env) leaves it ON.
- Line 6: `FORBIDDEN_KEYWORDS` regex misses `SET`, `CALL`, `LOCK`, `VACUUM`, `ANALYZE`, `MERGE`, `NOTIFY`, `LISTEN`. `CALL some_write_proc()` is a full write primitive if procedures exist.
- Lines 52-53: `\bLIMIT\b` matched anywhere — including inside a comment or string literal — skips appending a server-side LIMIT; all matching rows are materialised in memory before the display slice (:71-78).
- Multi-statement execution is possible: `database/gateway.ts:626` runs param-less SQL as `conn.unsafe(sql)` (simple protocol).
- Errors return raw PG messages to the client (:94-97, and `db.ts:89-93`).

### Goal
The console exists only when explicitly asked for, cannot mutate, cannot be tricked into unbounded scans, and never leaks PG internals.

### Files
| Path | Change |
|------|--------|
| `endpoints/query.ts` | Replace the NODE_ENV gate with explicit opt-in: `BUNSANE_STUDIO_QUERY=on` (default off). Log a startup warning when on. |
| `endpoints/query.ts` | Strip comments (`--`, `/* */`) and collapse string literals before keyword-testing and LIMIT detection. Keep the blacklist as belt-and-braces but treat it as unreliable. |
| `endpoints/query.ts` | Always append/force server-side `LIMIT` on the outermost statement; additionally wrap as `SELECT * FROM (<user sql>) _q LIMIT $n` where parseable, else reject multiple statements (reject `;` outside literals/comments). |
| `database/gateway.ts` | Add a `singleStatement: true` exec option that asserts exactly one statement reaches `unsafe()` (no params ⇒ force prepared/extended protocol or split-and-count). |
| `endpoints/db.ts` | Route non-capacity errors through the same masking as the app (message class only, e.g. `syntax error at ...` without full PG text) unless studio auth token belongs to an operator role. |

### Acceptance criteria
- [ ] Without `BUNSANE_STUDIO_QUERY=on`, POST `/studio/api/query` returns 403/404 regardless of NODE_ENV.
- [ ] `SELECT 'LIMIT'; <long scan>` cannot bypass the appended limit; total returned rows never exceed MAX_ROWS server-side.
- [ ] `SELECT 1; SET statement_timeout=0` and `CALL x()` are rejected before execution.
- [ ] Error responses contain no raw PG detail beyond a short classified message.
- [ ] Unit tests for comment/string stripping (`/*LIMIT*/`, `'has LIMIT inside'`, `-- LIMIT`).

---

## SEC-03 — Filter/sort identifiers and operators: allow-list at the sinks

### Problem
User-reachable strings are interpolated into SQL text rather than bound or asserted. Values ARE parameterised; identifiers and operators are not:

- `query/FilterBuilder.ts:69,95` (`buildJSONPath`/`buildJSONBPath`): `'${field}'` segments interpolated with no escaping — a single quote breaks out of the JSON path literal.
- `FilterBuilder.ts:184` (and boolean :182): `${filter.operator}` interpolated verbatim in the fallback predicate; no allow-list.
- Sources store unsanitized: `Query.filter()` (`Query.ts:~2268`) and `.with(C, { filters })` copy (`Query.ts:~339`).
- `query/OrNode.ts:107,238,438,594`: `data->>'${field}'` same interpolation (operators there are switch-safe).
- `ComponentInclusionNode.ts:~309`: `ORDER BY ${sortExpr} ${sortOrder.direction}` — direction is TS-typed only; contrast the hard-mapped allow-list at `Query.ts:1730-1733`.
- Partition table names interpolated unquoted without `assertComponentTableName`: `Query.ts:~2064` (populate), `OrNode.ts:98,223,282,407,583`.
- `database/projection/ProjectionSource.ts:32`: `entityRef` interpolated (current callers safe; no guard).

Exploitability requires an app resolver passing user-controlled `field`/`operator`/`direction` — the framework offers zero defence for that case.

### Goal
Every identifier-like string crossing the SQL text boundary passes an assertion helper; every operator crosses a closed set. Injection via filter metadata becomes impossible regardless of caller discipline.

### Files
| Path | Change |
|------|--------|
| `query/SqlIdentifier.ts` (or new `query/assertSql.ts`) | Export `assertFieldPath(s)` (JSON path segments: `[A-Za-z_][A-Za-z0-9_]*`, dot-separated), `assertOperator(op)` (closed set: `= != > < >= <= LIKE ILIKE NOT LIKE IN NOT IN IS NULL IS NOT NULL`), reuse existing `assertIdentifier`/`assertComponentTableName`. |
| `query/FilterBuilder.ts` | Call `assertFieldPath` at the top of `buildJSONPath`/`buildJSONBPath`; `assertOperator` in `buildComponentFilterCondition` before branch dispatch. |
| `query/OrNode.ts` | Assert each `filter.field` at loop entry; route through the same helpers. |
| `query/Query.ts` | Assert in `sortBy()` (property + direction ∈ {ASC, DESC}) so the guard lives at the source too; assert filters on `.with()`/`.filter()` entry. |
| `query/ComponentInclusionNode.ts` | Defence-in-depth: allow-list direction at emit. |
| `query/Query.ts` + `query/OrNode.ts` | `assertComponentTableName(partitionTable)` wherever `getPartitionTableName()` output is interpolated. |
| `database/projection/ProjectionSource.ts` | Assert `entityRef` matches a known-safe shape (`^[A-Za-z0-9_.]+$`) or convert callers to bind. |

### Acceptance criteria
- [ ] `new Query().with(C).filter("x' OR true --", '=', 1)` throws a descriptive error, does not execute.
- [ ] Operator `"= $1 OR true --"` throws at assertion.
- [ ] Same payloads via `.with(C, { filters })` and `OrQuery` branches throw.
- [ ] `sortBy(C, prop, 'ASC; SELECT pg_sleep(5)--')` throws.
- [ ] Existing suite green (`bun run test:pglite:unit` + integration); FTS builder behaviour unchanged (already asserted).
- [ ] Docs note in `docs/QUERY_LIST_GUIDE.md`: filter fields/operators must be plain identifiers; anything else throws.

---

## SEC-04 — CORS: refuse wildcard+credentials instead of reflecting

### Problem
`core/app/cors.ts:8-9` warns about `credentials:true` with `origin:'*'` but then `validateOrigin` (:23-24) reflects any request Origin verbatim (including `Origin: null`), and `getCorsHeaders:62-63` adds `Access-Control-Allow-Credentials: true`. Any website can make credentialed cross-origin reads. The identical CorsConfig object is passed straight into Yoga (`gql/index.ts:193-195`), which applies its own reflection semantics on top — the framework's reflection makes this reachable even though Yoga would have been unsafe anyway.

Secondary: `requestRouter.ts` applies framework CORS to REST but GraphQL responses get Yoga's CORS — inconsistent headers/preflight handling.

### Goal
The dangerous combination is rejected at configuration time, not warned about. Single CORS implementation for all responses.

### Files
| Path | Change |
|------|--------|
| `core/app/cors.ts` | `assertValidCorsConfig` throws on `credentials && origin === '*'` (upgrade from warn). In `validateOrigin`, never return `requestOrigin` when credentials are on and origin is `'*'` (return null → no ACAO header). Explicitly handle `Origin: null` (never reflected when credentials on). |
| `gql/index.ts` | Normalize the Yoga cors option: if credentials, expand `'*'` into an explicit origin list or strip credentials; keep one source of truth. Consider routing GraphQL through the framework's `addCorsHeaders` and disabling Yoga's plugin for consistency. |
| `tests/unit/cors.test.ts` (new) | Table-driven cases: `*`+creds (throw/no-header), exact match, array, function, `Origin: null`, no-Origin request. |

### Acceptance criteria
- [ ] `createApp({ cors: { origin:'*', credentials:true } })` throws at startup with guidance text.
- [ ] Even if constructed programmatically, no response carries both reflected origin and `Allow-Credentials: true`.
- [ ] Preflight and actual responses agree for REST and `/graphql`.

---

## SEC-05 — Rate limiter: stop trusting client-supplied IP headers

### Problem
`core/middleware/RateLimit.ts:43-44`: `X-Real-IP` is read unconditionally — `trustProxy` only gates `X-Forwarded-For`. Any client rotating `X-Real-IP` values gets unlimited fresh buckets. Without the header, every client shares the single `'anonymous'` bucket (:45), so one abuser exhausts it and locks everyone out.

### Files
| Path | Change |
|------|--------|
| `core/middleware/RateLimit.ts` | Default extractor: use `server.requestIP(req)` (Bun) when available; header values read ONLY when `trustProxy: true`. When neither yields a key, bucket per-connection (IP from socket) rather than a global constant; if truly unavailable, fail-open with a warning log instead of a shared bucket. |
| `docs/CONFIGURATION.md` | Document `trustProxy` semantics: behind one trusted proxy, set it and ensure the proxy strips/overwrites client-supplied `X-Real-IP`/`X-Forwarded-For`. |

### Acceptance criteria
- [ ] With `trustProxy:false` (default), spoofed `X-Real-IP`/`XFF` headers do NOT create separate buckets; two clients sending different fake IPs share one real-IP bucket.
- [ ] No deployment mode exists where all un-keyed traffic shares one bucket.
- [ ] With `trustProxy:true`, leftmost XFF hop is honoured (unchanged) and docs note the proxy-strip requirement.
- [ ] 429 responses include CORS-safe headers (currently absent — verify and fix if trivial).

---

## SEC-06 — GraphQL uploads: validate nested and batch files

### Problem
`gql/decorators/Upload.ts:58`: validation runs only when `args[paramIdx] instanceof File`. Bypasses:

- File arrays (`batch: true`) — a File[] fails `instanceof`, raw array passed to the service method with zero checks.
- Files nested inside an input object (`args[0].input.file`) — top-level param check misses them entirely.
- `@Upload` used without `@UploadField` — the decorator only records metadata (`Upload.ts:17-33`); nothing wraps the method, so no validation happens at all.

Combined with the 50MB default body limit (`App.ts:114`) and Yoga multipart enabled, unauthenticated multipart posts pin large bodies and skip MIME/extension/signature checks.

### Goal
Every file that reaches a service method — scalar, batch, or nested — has passed `FileValidator` under the operation's config.

### Files
| Path | Change |
|------|--------|
| `gql/decorators/Upload.ts` | `@Upload` itself wraps the method (compose with the `@UploadField` wrapper or extract a shared wrapper util). Walk values: `File` → validate; `File[]` → validate each; recurse one level into plain-object args for configured `config.field` locations. Reject unknown extra File properties when strict. |
| `gql/builders/ResolverBuilder.ts` | After arg assembly, run the same upload walk before invoking the service method (defence-in-depth; keeps generated resolvers safe even if decorators are misused). |
| `upload/FileValidator.ts` | Expose `validateFiles(files: File[], config)` batch entry returning aggregated errors. |
| Tests | Unit: nested input file validated; batch of 3 with one oversized → rejection naming the index; `@Upload`-only usage still validates. |

### Acceptance criteria
- [ ] Batch upload where the 2nd file exceeds maxFileSize is rejected (today it sails through).
- [ ] File nested in `input` object is validated.
- [ ] A mutation using only `@Upload` (no `@UploadField`) enforces validation.
- [ ] Non-File args untouched; existing upload tests green.

---

## SEC-07 — Local storage: enforce containment at the provider boundary

### Problem
- `storage/LocalStorageProvider.ts:49-50`: `store()` builds paths with `path.join(basePath, config.uploadPath, metadata.fileName)` and never calls `sanitizePath()` — containment relies wholly on upstream naming (`uuid` strategy default is safe; `"original"` + `sanitizeFileName:false` is not: `../../x` escapes basePath).
- `StorageProvider.sanitizePath` (`StorageProvider.ts:106-115`) strips `..` and normalises forward slashes only — on Windows a stored/read path containing `\` separators traverses (`delete('..\\..\\secret')`). Read/delete/getStream/copy all funnel through it.
- Stored `UploadComponent.path` values (potentially client-writable via CRUD) are later trusted by delete/getStream/copy.

### Goal
No provider method can touch a path outside `basePath`, whatever string arrives; sanitiser understands Windows separators.

### Files
| Path | Change |
|------|--------|
| `storage/StorageProvider.ts` | Rewrite `sanitizePath`: replace `\`→`/` first, then iterative `..` removal, then final containment verification. Add `assertInsideBase(fullPath, basePath)` helper: `path.resolve` both, check resolved starts with resolved base + separator (works for drive letters/UNC on win32). |
| `storage/LocalStorageProvider.ts` | Apply containment in EVERY method after join — including `store()` (compute fullPath, `assertInsideBase`, throw on violation). Log-and-throw, never silently rewrite. |
| `upload/UploadManager.ts` | When namingStrategy is `original`, always run `sanitizeFileName` (remove the escape hatch or rename to `dangerousAllowOriginalName` with a loud doc warning). |
| Tests | Windows-flavoured cases run on CI: absolute drive path, UNC `\\host\share`, `....//....//`, backslash traversal via stored path, URL-encoded `%2e%2e%2f`. |

### Acceptance criteria
- [ ] `store()` with hostile fileName under `original` strategy throws and writes nothing.
- [ ] `delete/getStream/copy('..\\..\\x')` resolve inside basePath on win32 (and POSIX unchanged).
- [ ] Resolved-path containment test proves no escape for all provider methods.
- [ ] Default uuid flow unaffected.

---

## SEC-08 — Error masking: fail-closed

### Problem
Masking is keyed on exact `NODE_ENV === 'production'`:
- `gql/index.ts:127` — unset/staging/typo'd values return original GraphQLErrors including stacks, SQL fragments, extensions.
- `endpoints/db.ts:89-93` — studio handlers always return raw `error.message` (PG internals) in every environment.
- `gql/builders/ResolverBuilder.ts:90` — uses the looser `!== 'production'` gate for `extensions.originalError`; wider than ErrorHandler's development-only policy.
- `gql/index.ts:104` — masker dereferences `error.message.includes(...)`; a thrown non-Error crashes the masker itself.
- `validateEnv.ts:25` — NODE_ENV is optional, so the most security-relevant branch in the framework hangs on an unset variable.

### Goal
Unknown environment ⇒ masked. Development-style verbosity requires the explicit value `'development'`. One shared gate.

### Files
| Path | Change |
|------|--------|
| `gql/index.ts` | Central `isVerboseErrors(): boolean` = `process.env.NODE_ENV === 'development'`. Mask branch becomes `if (!isVerboseErrors())`. Guard line 104 (`typeof error.message === 'string'`). Drop `originalMessage` duplication or restrict to verbose mode. |
| `gql/builders/ResolverBuilder.ts` | Use the same helper; remove `!== 'production'` widening. |
| `endpoints/db.ts` | Classify messages: capacity (existing), syntax/permission → short generic text + code; verbose only in development. |
| `core/ErrorHandler.ts` | Align gates with the helper; keep VALIDATION_ERROR mapping decision documented (today Zod failures become opaque 500s in production). |
| `core/validateEnv.ts` | Emit a hard warning (or fail with `BUNSANE_STRICT_ENV=on`) when NODE_ENV is unset in a process listening on a network interface. |

### Acceptance criteria
- [ ] `NODE_ENV` unset/staging/test-server: clients receive masked errors everywhere (GraphQL, REST, studio).
- [ ] Only `NODE_ENV=development` produces stacks/originalError.
- [ ] Throwing a naked string from a resolver doesn't crash masking.
- [ ] Unit tests per environment value.

---

## SEC-09 — GraphQL recon surface: introspection, GraphiQL, complexity gaps

### Problem
- Introspection and GraphiQL are never disabled (`gql/index.ts:185-190` sets neither `disableIntrospection` nor `graphiql:false`); Yoga defaults serve both in production — full schema recon plus a browser IDE on `/graphql` (GET, HTML).
- Both validation rules skip pure-introspection operations (`depthLimit.ts:66-71`, `complexityLimit.ts:76-81`) — tooling-sized `__schema` walks are unbounded.
- Complexity rule counts only INT literals (`complexityLimit.ts:40`): `first:$n` with `$n=1000000` costs 1. Fragment spreads deduped globally (:64): N aliases × expensive fragment charged once. No alias cap.
- `setGraphQLMaxComplexity(0)` silently removes the rule entirely (`App.ts:344` → `gql/index.ts:180`).

### Goal
Production defaults expose nothing recon-friendly; the complexity budget cannot be sidestepped via variables, alias repetition, or introspection exemption.

### Files
| Path | Change |
|------|--------|
| `gql/index.ts` | When `NODE_ENV === 'production'`: `graphiql: false`, `landingPage: false`, introspection disabled (Yoga `useDisableIntrospection` or schema-level). Opt-back-out via explicit option. |
| `gql/complexityLimit.ts` | Resolve VARIABLE args against `coercedVariableValues` (validation context) before reading multipliers; count fragment spread cost per USE SITE minus true recursion (charge first occurrence fully, repeats at a flat cost); add per-operation alias cap (e.g. 50) reported separately from complexity. Charge a flat high cost for `__` fields instead of skipping. |
| `gql/depthLimit.ts` | Keep introspection skip (depth is meaningless there) but rely on the complexity charge above. |
| `docs/CONFIGURATION.md` | Document GRAPHQL_MAX_COMPLEXITY (declare in validateEnv), the floor-15 depth, and the new production recon defaults. |

### Acceptance criteria
- [ ] Production: GET /graphql (HTML) → 404-ish landing; `{__schema{types{name}}}` rejected; both configurable for internal tools.
- [ ] `query($n:Int){c(first:$n){x}}` with $n=10⁶ rejected by complexity budget.
- [ ] 60 aliases of one fragment exceed the budget proportionally to uses.
- [ ] Deep-introspection walks bounded.
- [ ] Dev workflow (codegen, IDE) unaffected in non-production.

---

## SEC-10 — Info endpoints: gate metrics, soften health, mark Swagger

### Problem
- `core/app/requestRouter.ts:105-108` — `/metrics` (pool/admission/cache/scheduler internals incl. task names + lastError) served unauthenticated.
- `core/app/requestRouter.ts:114` — `/health/remote` leaks remote dependency health.
- `core/health.ts:29` — `/health` runs a real DB **write** transaction probe by default; hammering it amplifies writes on the shared pool.
- `/openapi.json` + Swagger UI always public (`requestRouter.ts:126`), enumerating every REST path; UI loaded from unpkg without SRI.

### Files
| Path | Change |
|------|--------|
| `core/App.ts` / `requestRouter.ts` | Token-gate `/metrics` and `/health/remote` (same bearer mechanism as SEC-01; reusable helper). Config: `metricsToken` env; when absent, respond 404. |
| `core/health.ts` | Support `BUNSANE_HEALTH_PROBE=read` (default stays `write` for liveness correctness per CLAUDE.md) and rate-limit health routes internally (small token bucket) so liveness probes stay responsive while abuse is shed cheaply. |
| `swagger/generator.ts` + `requestRouter.ts` | Optional `docsToken` gate for `/docs` + `/openapi.json`; pin/SRI the CDN assets or self-host from `public/`. Attach declared security scheme to operations that registered auth metadata (fixes docs claiming optional-auth falsely). |

### Acceptance criteria
- [ ] Unauthenticated `/metrics` returns 404 when no token configured; 401/200 otherwise.
- [ ] Health flood (100 rps) sheds with 429 without exhausting DB lanes.
- [ ] `/openapi.json` gatable; Swagger assets load with integrity attributes (or locally).
- [ ] Liveness probe users unaffected (write probe still default; k8s docs updated).

---

## SEC-11 — Sign pub/sub cache invalidation messages

### Problem
`core/cache/invalidation.ts:47-65` applies any JSON message from channel `bunsane:cache:invalidate`: `deleteMany(msg.keys)` or `invalidatePattern(msg.pattern)`. No signature — anyone with PUBLISH access wipes L1 caches cluster-wide (and primes targeted re-fetch storms). Redis access is currently the only trust boundary.

### Files
| Path | Change |
|------|--------|
| `core/cache/invalidation.ts` | Add HMAC-SHA256 over the message body with a shared secret (`BUNSANE_CACHE_INVALIDATION_SECRET`, auto-generated per-cluster if unset → logged once, stored in Config). Verify before applying; drop+warn on failure. Include and check a monotonic-ish timestamp window (±30s) to block replay of old wipes. |
| `core/Config.ts` / `docs/CONFIGURATION.md` | Declare the secret, rotation note, and the trust statement ("Redis network exposure == cache-control exposure" until signed). |

### Acceptance criteria
- [ ] Unsigned/tampered/stale messages are dropped with a warn log; legit cross-instance invalidation still works (multi-instance integration test).
- [ ] Missing secret on a single-instance deployment degrades gracefully (pub/sub disabled with info log, not crash).

---

## SEC-12 — RPC/outbox: document the boundary, add envelope signing

### Problem
Redis Streams RPC (`core/remote/RpcCaller.ts`, `StreamConsumer.ts`, `OutboxWorker.ts`) has:
- No auth layer of any kind between Redis XADD access and service invocation (grep: zero HMAC/auth/signature across the three files).
- `replyTo` taken from the request envelope and used as the response XADD target (`StreamConsumer.ts:393→416`) — a malicious producer redirects response payloads into arbitrary streams.
- Outbox rows carry `sourceApp` unchecked — any DB writer impersonates another producer; consumers replay without idempotency guarantees.

### Goal
Make the required Redis posture explicit and raise the bar for multi-tenant Redis: signed envelopes, constrained replyTo, idempotency guidance.

### Files
| Path | Change |
|------|--------|
| `core/remote/RpcCaller.ts` | Optional envelope signature (same HMAC helper as SEC-11, shared secret `BUNSANE_RPC_SECRET`). Consumers reject unsigned envelopes when the secret is configured (fail-closed rollout: unset = legacy behaviour + startup warn). |
| `core/remote/StreamConsumer.ts` | Validate `replyTo` against the configured stream namespace prefix (must equal `config.responseStream` family — startswith check on the configured prefix); reject otherwise. |
| `core/remote/OutboxWorker.ts` | Document + optionally enforce producer identity: outbox insert path stamps `sourceApp` from server-side config only (never from payload); consumers dedupe on `(sourceApp, correlationId)`. |
| `docs/CONFIGURATION.md` | New "Remote RPC trust model" section: Redis MUST be authenticated + network-isolated; signing defends multi-tenant/shared instances. |

### Acceptance criteria
- [ ] With `BUNSANE_RPC_SECRET` set, unsigned/tampered envelopes are ACK-dropped with a metric.
- [ ] `replyTo` pointing outside the configured namespace is rejected before dispatch.
- [ ] Outbox consumer ignores duplicate `(sourceApp, correlationId)` within retention window.
- [ ] Zero-config single-service deployments unchanged.

---

## SEC-13 — Bound pattern-based cache invalidation

### Problem
- `core/cache/RedisCache.ts:317` — `SCAN MATCH <pattern> COUNT 100` collects then deletes everything matching; a hostile or careless pattern (`*` on a big shared DB) blocks the event loop and mass-evicts.
- `MemoryCache.invalidatePattern` translates globs to regex — attacker-influenced patterns reach RegExp construction (ReDoS-shaped) and unbounded eviction.
- `RedisCache.getStats` uses `DBSIZE` (:350) — leaks occupancy of a shared Redis instance.

### Files
| Path | Change |
|------|--------|
| `core/cache/RedisCache.ts` | Cap keys per invalidation call (env `BUNSANE_CACHE_INVALIDATE_MAX`, default ~10k); when exceeded, abort with error (caller decides) rather than partial wipe. Yield between SCAN pages. |
| `core/cache/MemoryCache.ts` | Escape glob metacharacters segment-wise (`*`→`[^.]*` style) instead of raw interpolation into regex; cap matched-key deletions. |
| `core/cache/RedisCache.ts` | `getStats`: replace `DBSIZE` with prefixed-key estimate (SCAN sample extrapolation or maintain a counter) when a key prefix is configured. |

### Acceptance criteria
- [ ] `invalidatePattern('*')` on a 1M-key fixture errors out at the cap instead of deleting all.
- [ ] Pattern `*a*a*a*a*b` (catastrophic backtracking shape) completes quickly in MemoryCache.
- [ ] Stats reflect only own-prefix keys under shared Redis.

---

## SEC-14 — Right-size body limits; stream REST uploads

### Problem
- `core/App.ts:114` — 50MB default body limit applies to ALL routes (GraphQL JSON, studio query, REST JSON). Combined with Yoga multipart enabled, unauthenticated requests pin large buffers before validation.
- `rest/upload` path buffers the entire multipart body before per-file size/maxFiles checks apply.

### Files
| Path | Change |
|------|--------|
| `core/App.ts` | Per-class limits: JSON APIs default 1MB; GraphQL mutations 1MB (uploads excluded via multipart path); keep `maxRequestBodySize` override + env. Studio routes inherit the tighter JSON limit. |
| `rest/` + `upload/RestUpload.ts` | Enforce `content-length` header early-reject; stream multipart parts to validator with running byte counter; abort pipeline at per-file/per-request caps (today's caps enforced post-buffering). |
| `gql/index.ts` | Confirm Yoga multipart options carry the per-file cap so oversized parts fail mid-stream. |

### Acceptance criteria
- [ ] Default deployment rejects a 10MB JSON POST with 413 without buffering it.
- [ ] Oversized multipart part aborts mid-stream (peak RSS stays flat with a 200MB upload attempt).
- [ ] Legit 20MB upload through properly-configured route succeeds.

---

## SEC-15 — Security headers on by default

### Problem
`core/middleware/SecurityHeaders.ts` exists but nothing registers it (`App.start` / bootstrap greps find no registration). HSTS gated on NODE_ENV=production *and* manual registration; no CSP, Permissions-Policy, COOP/CORP anywhere. Swagger UI and studio load third-party scripts (unpkg) with no SRI.

### Files
| Path | Change |
|------|--------|
| `core/App.ts` | Register SecurityHeaders automatically in `start()` (before routes) with sane defaults; `securityHeaders(false)` opts out entirely. HSTS only when TLS detected/env-declared (avoid poisoning plain-HTTP localhost). |
| `core/middleware/SecurityHeaders.ts` | Add `X-Content-Type-Options`, `Referrer-Policy`, baseline CSP for framework-served HTML (studio/docs): `default-src 'self'` + pinned CDN entries with SRI hashes when external CDNs remain. Permissions-Policy minimal. COOP `same-origin` for studio/docs routes. |
| `docs/CONFIGURATION.md` | Document defaults + opt-out. |

### Acceptance criteria
- [ ] Fresh app responds to any route with the header set; curl snapshot test.
- [ ] Opt-out restores today's behaviour exactly.
- [ ] Studio/docs HTML include CSP allowing only self + pinned CDN hashes.

---

## SEC-16 — Environment validation hardening

### Problem
`core/validateEnv.ts:25` — `NODE_ENV` optional, yet it gates error masking, the ad-hoc SQL console, HSTS, and verbose CORS warnings. `GRAPHQL_MAX_COMPLEXITY` undeclared. Redis variables (`REDIS_HOST/PASSWORD/TLS`) unchecked — a prod deploy missing REDIS_PASSWORD fails silently into an unauthenticated socket assumption.

### Files
| Path | Change |
|------|--------|
| `core/validateEnv.ts` | Warn loudly (once, at boot) when NODE_ENV unset. Declare GRAPHQL_MAX_COMPLEXITY, BUNSANE_STUDIO_QUERY (SEC-02), invalidation/RPC secrets (SEC-11/12), metrics token (SEC-10). When `CACHE_PROVIDER=redis` and `NODE_ENV=production`: warn if `REDIS_PASSWORD` empty and host not loopback/link-local. Add `BUNSANE_STRICT_ENV=on` mode promoting warnings to boot failure. |
| `docs/CONFIGURATION.md` | Sync every new variable. |

### Acceptance criteria
- [ ] Boot with unset NODE_ENV prints a single clear warning naming affected behaviours.
- [ ] Production + non-loopback Redis + empty password warns (fails under STRICT_ENV).
- [ ] STRICT_ENV boot-fails on any listed gap with actionable text.

---

## SEC-17 — Low-severity hardening sweep

Batch the small items; ship as one PR with individual commits.

1. **Index hint comment breakout** — `FilterBuilder.ts:257`: assert `indexHint` against `^[A-Za-z0-9_]+$` before embedding in `/* */`.
2. **X-Request-Id sanitisation** — `RequestId.ts:24`: constrain accepted inbound header to `[A-Za-z0-9-]{1,64}`, else generate.
3. **Swagger security wiring** — `swagger/generator.ts:39`: attach declared BearerAuth to operations that registered auth metadata; stop implying open endpoints.
4. **Pre-mask schema-type leak** — `gql/index.ts:112`: drop `originalMessage` extension or gate to verbose mode (overlaps SEC-08).
5. **SDL identifier allow-list** — `gql/schema/index.ts:271`: field/type/enum names through `assertIdentifier` before SDL interpolation (defence vs future dynamic naming).
6. **Advisory lock tokens** — `AdvisoryLockBackend.ts:90-99`: derive token from `crypto.randomBytes` per acquisition attempt (store in lock row) instead of deterministic taskId hash; keep taskId only as the lock *key*.
7. **CORS single-implementation follow-up** — after SEC-04, route GraphQL responses through framework CORS and remove the dual-plugin mismatch noted at `requestRouter.ts:322`.
8. **timeBucket caller guard** — `query/timeBucket.ts:13`: assert `tsExpr`/`tzParam` shapes (identifier-or-param / interval-literal) so future callers can't regress.

### Acceptance criteria
- [ ] Each item has a focused unit test.
- [ ] No behavioural change to happy paths.

---

## Withdrawn during verification (do not implement)

- "Secret-redaction regex fails on @ passwords" — no such regex exists; pino redacts by field path (`core/Logger.ts:6-9`). Related residual risk (URL-embedded credentials in logged connection strings are NOT scrubbed) is covered by SEC-16's secret-handling notes if it ever materialises.
