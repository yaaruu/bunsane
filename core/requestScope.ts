import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestLoaders } from "./RequestLoaders";
import type { PerRequestCounters } from "../database/instrumentedDb";

/**
 * Ambient per-request context carrying the request's DataLoaders,
 * AbortSignal and per-request counters via AsyncLocalStorage.
 *
 * Why: explicit `context` threading only reaches call sites that accept a
 * context parameter. `@ArcheTypeFunction` bodies, `Unwrap()`, and service
 * helpers call `entity.get(Component)` bare — without this scope every such
 * call is an individual SELECT (N+1 per parent row). The GraphQL request
 * plugin (`createRequestContextPlugin`) wraps execution in
 * `runWithRequestScope`, so `Entity._loadComponent` and the relation
 * population helpers can fall back to the request's batching DataLoaders
 * when no explicit context is provided.
 *
 * Imports are type-only — no runtime dependency cycle with Entity/loaders.
 */
export interface RequestScope {
    loaders: RequestLoaders;
    signal?: AbortSignal;
    perRequest?: PerRequestCounters;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runWithRequestScope<T>(scope: RequestScope, fn: () => T): T {
    return storage.run(scope, fn);
}

export function getRequestScope(): RequestScope | undefined {
    return storage.getStore();
}
