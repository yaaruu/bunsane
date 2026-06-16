# RFC: Runtime Authoring — Dynamic Components, Archetypes & Logic

**Status:** Exploring. Phase 0 implemented (live schema re-weave). Phases 1–4 not committed.
**Date:** 2026-06-15

## Goal

Let components, archetypes, and service logic be defined *outside compiled `.ts`*
and reflected into a running app — ideally without a redeploy. The originating
idea was a visual/no-code editor; this RFC records the analysis and the one
piece worth building now.

## Two axes (don't conflate them)

The feature is really two independent decisions:

1. **Authoring** — how a definition is created: hand-written `.ts`, an LLM
   prompt, a form, or a visual node graph.
2. **Runtime substrate** — what actually executes: a compiled `.ts` class
   (needs restart/deploy) vs. an interpreted JSON definition registered live.

An LLM replaces the **authoring** layer. It does *not* remove the substrate
work. The substrate is the expensive, reusable core; authoring UI is cosmetic
on top of it.

## Key finding: schema was frozen at boot

Scout of the registries (2026-06-15):

| Layer | Runtime-dynamic today? | Notes |
|-------|------------------------|-------|
| Component | Yes (mechanically) | `ComponentRegistry.register(name, typeId, ctor)` is public + idempotent. Needs a synthesized class ctor; field metadata goes to `MetadataStorage`. |
| Archetype | Yes (data) | `BaseArcheType.Create({components})` builds from a list, no decorator. Not visible to the GraphQL generator on its own. |
| GraphQL schema | **No (was the blocker)** | Schema woven **once** on `SYSTEM_REGISTERING`; `app.yoga` assigned once. No re-weave existed. |

### Partitioning matters for runtime component creation

`components` is partitioned (`BUNSANE_PARTITION_STRATEGY`, `database/DatabaseHelper.ts`):

- `list` (**default**): one partition table **per component type**. A new
  component at runtime = `CREATE TABLE ... PARTITION OF` = **ACCESS EXCLUSIVE
  lock** on the parent → stalls all component I/O. Hostile to live creation.
- `hash`: fixed N partitions created once at boot. A new component = **no DDL**,
  just a new `type_id`. Required for safe runtime component creation.

A single flat unpartitioned `components` table was *considered but never
shipped*. Hash strategy keeps partition-pruning perf **and** removes the
runtime DDL lock — preferred over flat for this feature.

## Yoga supports live schema swap (verified)

`graphql-yoga@5.15.1` `YogaSchemaDefinition` accepts a factory
`(context) => MaybePromise<GraphQLSchema>`, called per-request. Holding the
schema behind a stable ref and swapping it makes the next request observe the
new schema with no Yoga recreation and no restart. Yoga's parse/validate caches
are keyed by schema identity, so a stable ref stays warm; only a changed ref
re-primes.

## Strategic verdict (with LLM in the picture)

LLM authoring makes the **visual editor low-priority, possibly unnecessary** —
node graphs are weak exactly where logic lives (branches, async, errors), which
an LLM handles directly. Two clean product shapes:

- **A — LLM + codegen `.ts` + deploy.** Zero framework change, full `tsc`, full
  logic. Cost: needs restart/deploy; not per-end-user-live. Best ROI for an
  internal dev accelerator. The round-trip objection to codegen disappears when
  a human never edits a graph (the LLM regenerates from prompt).
- **B — LLM + interpreted JSON DSL + live re-weave.** Instant, multi-tenant, no
  deploy. Cost: build the substrate (this RFC) + an op interpreter; lose `tsc`.
  Justified only when a *running shared app* must change without redeploy.

The substrate (Phase 0) has standalone framework value regardless of the
no-code dream: hot config reload, schema feature-flags / A-B schema, plugin
systems. That is the actual near-term win.

## Phases (Gall's Law — each ships working)

- **Phase 0 — live schema re-weave. ✅ IMPLEMENTED.** See below. Unlocks every
  richer path; useful on its own.
- **Phase 1 — runtime component from JSON.** `definitions` table + a
  `synthComponentClass(spec)` that builds a `BaseComponent` subclass and pushes
  field metadata into `MetadataStorage`; a `DefinitionLoader` at boot. Requires
  `BUNSANE_PARTITION_STRATEGY=hash`.
- **Phase 2 — archetype + auto-CRUD, live.** Archetype def → `BaseArcheType.Create`
  → CRUD ops → `rebuildSchema()`. Cross-instance reload via the existing Redis
  pub/sub channel (same pattern as cache invalidation): write def → publish →
  every pod reloads + re-weaves. Covers ~70% of real use.
- **Phase 3 — custom logic.** Coarse-grained JSON op-DSL (query / get / set /
  condition / emit) interpreted against real BunSane APIs. Sandboxed, **no
  codegen, no eval**. This is the hard 80%; build only when Phase 2 limits hit.
- **Phase 4 — UI.** Thin client over the definition CRUD API + DSL. A visual
  node graph is just a view of the JSON, built last if non-technical users
  actually need it.

## Storage & code/no-code coexistence (design intent for Phases 1+)

- **Definitions live in Postgres**, not files (multi-pod / k8s safe; survives
  restart). Suggested shape:
  `definitions(id, kind, name, spec jsonb, version, enabled, source, timestamps)`.
- **Both authoring paths terminate in the SAME runtime registries.** Decorators
  are the compile-time feeder; `DefinitionLoader` is the runtime feeder; both
  call identical registration functions. The registry cannot tell origin apart.
- **Collision policy:** namespace no-code names (`source` column / prefix) and
  **code wins** — a UI def that collides with a compiled component is rejected
  with a clear error, never silently shadows code.

## Phase 0 — what was implemented (2026-06-15)

Live re-weave with no restart and no Yoga recreation:

- `service/ServiceRegistry.ts`
  - `rebuildSchema()` — re-runs `generateGraphQLSchemaV2` over the currently
    registered services, swaps the stored schema ref, bumps `schemaVersion`.
  - `getSchemaVersion()` — monotonic counter (starts at 1 after boot weave).
  - The `SYSTEM_REGISTERING` boot handler now calls `rebuildSchema()` (dedup).
- `gql/index.ts` — `createYogaInstance` accepts a `SchemaProvider`
  (`GraphQLSchema | () => GraphQLSchema | null`). A factory is passed straight
  to Yoga and read per-request; `null` falls back to a memoized static schema.
- `core/app/graphqlSetup.ts` — wires Yoga with `() => ServiceRegistry.getSchema()`
  instead of a fixed reference.
- `core/App.ts` — `rebuildGraphQLSchema(): number` convenience; re-weaves and
  returns the new schema version.

**Usage:**

```ts
// after registering a new service / mutating @GraphQLOperation metadata:
const version = app.rebuildGraphQLSchema();
// next GraphQL request serves the new schema — no restart, no Yoga rebuild.
```

**Not yet done (follow-ups):** cross-instance re-weave broadcast (Redis pub/sub),
an integration test proving a field added post-boot resolves live, and
debouncing rapid successive rebuilds.
