// Persistence path for Entity (save / doSave / doDelete) and post-commit
// side effects. Extracted from Entity.ts (RFC_REFACTOR_TARGETS §3.2). This
// is the framework's hottest path — behavior is byte-identical to the
// original inline implementation. Pure functions take the entity instance
// as the first parameter.
import { logger } from "../Logger";
import db, { QUERY_TIMEOUT_MS } from "../../database";
import { runWithSignal } from "../../database/cancellable";
import ComponentRegistry from "../components/ComponentRegistry";
import { uuidv7 } from "../../utils/uuid";
import { sql, SQL } from "bun";
import EntityHookManager from "../EntityHookManager";
import { EntityCreatedEvent, EntityUpdatedEvent } from "../events/EntityLifecycleEvents";
import { trackSideEffect } from "./pendingOps";
import { handleCacheAfterSave, runPostDeleteSideEffects } from "./cacheStrategies";
import type { Entity } from "../Entity";

export async function saveEntity(entity: Entity, trx?: SQL, context?: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal }): Promise<boolean> {
    // Capture pre-save state BEFORE doSave mutates persisted/dirty flags.
    const wasNew = !entity._persisted;
    const changedComponentTypeIds = getDirtyComponents(entity);
    const removedComponentTypeIds = Array.from(entity.removedComponents);

    // Pre-flight: await ComponentRegistry readiness for every component on
    // this entity BEFORE opening the transaction. Previously doSave awaited
    // ComponentRegistry.getReadyPromise inside the executeSave loop, so a
    // slow DDL (partition creation) would keep the PG transaction open and
    // idle-in-transaction waiting on registry state. (H-DB-4).
    for (const comp of entity.components.values()) {
        const compName = comp.constructor.name;
        if (!ComponentRegistry.isComponentReady(compName)) {
            await ComponentRegistry.getReadyPromise(compName);
        }
    }

    const profile = process.env.DB_SAVE_PROFILE === 'true';
    const phaseStart = profile ? performance.now() : 0;
    const phases: Record<string, number> = {};

    // AbortController cancels in-flight queries and propagates ROLLBACK
    // when the wall-clock timer fires. Throwing from inside the transaction
    // callback triggers Bun SQL's auto-ROLLBACK, releasing the pooled connection.
    const controller = new AbortController();
    const timeoutMs = QUERY_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
        const err = new Error(`Entity save timeout for entity ${entity.id} after ${timeoutMs}ms`);
        logger.error({ scope: 'Entity.save', entityId: entity.id, timeoutMs }, err.message);
        controller.abort(err);
    }, timeoutMs);

    try {
        const dbStart = profile ? performance.now() : 0;
        if (trx) {
            await doSave(entity, trx, controller.signal);
        } else {
            await db.transaction(async (newTrx) => {
                await doSave(entity, newTrx, controller.signal);
            });
        }
        if (profile) phases.db = performance.now() - dbStart;

        clearTimeout(timeoutHandle);

        // Post-commit side effects are fire-and-forget so Redis / hook
        // latency cannot consume the save budget or block the caller.
        // Tracked in pendingSideEffects so tests/shutdown can drain
        // background work before asserting or tearing down.
        const sideEffectPromise = new Promise<void>((resolve) => {
            queueMicrotask(() => {
                runPostCommitSideEffects(
                    entity,
                    wasNew,
                    changedComponentTypeIds,
                    removedComponentTypeIds,
                    context,
                    profile ? phases : undefined,
                    profile ? phaseStart : undefined,
                ).finally(() => resolve());
            });
        });
        trackSideEffect(sideEffectPromise);

        return true;
    } catch (error) {
        clearTimeout(timeoutHandle);
        if (controller.signal.aborted) {
            throw controller.signal.reason ?? error;
        }
        throw error;
    } finally {
        // Ensure AbortController listeners are released even on success.
        if (!controller.signal.aborted) controller.abort();
    }
}

/**
 * Fire-and-forget post-commit work: cache invalidation + lifecycle hooks.
 * Runs outside the save budget. Errors are logged and swallowed so cache
 * or hook failures never surface as save failures.
 */
async function runPostCommitSideEffects(
    entity: Entity,
    wasNew: boolean,
    changedComponentTypeIds: string[],
    removedComponentTypeIds: string[],
    context: { loaders?: { componentsByEntityType?: any }; trx?: SQL; signal?: AbortSignal } | undefined,
    phases: Record<string, number> | undefined,
    phaseStart: number | undefined,
): Promise<void> {
    const profile = phases !== undefined && phaseStart !== undefined;

    const cacheStart = profile ? performance.now() : 0;
    try {
        await handleCacheAfterSave(entity, changedComponentTypeIds, removedComponentTypeIds, context);
    } catch (err) {
        logger.warn({ scope: 'cache', entityId: entity.id, err }, 'post-commit cache invalidation failed');
    }
    if (profile) phases!.cache = performance.now() - cacheStart;

    const hookStart = profile ? performance.now() : 0;
    try {
        if (wasNew) {
            await EntityHookManager.executeHooks(new EntityCreatedEvent(entity));
        } else if (changedComponentTypeIds.length > 0) {
            await EntityHookManager.executeHooks(new EntityUpdatedEvent(entity, changedComponentTypeIds));
        }
    } catch (err) {
        logger.error({ scope: 'hooks', entityId: entity.id, err }, 'post-commit lifecycle hooks failed');
    }
    if (profile) phases!.hooks = performance.now() - hookStart;

    if (profile) {
        phases!.total = performance.now() - phaseStart!;
        logger.info({ scope: 'Entity.save.profile', entityId: entity.id, phases }, 'Entity.save phase timings');
    }
}

export async function doSave(entity: Entity, trx: SQL, signal?: AbortSignal): Promise<boolean> {
    // Validate entity ID to prevent PostgreSQL UUID parsing errors
    if (!entity.id || entity.id.trim() === '') {
        logger.error(`Cannot save entity: id is empty or invalid`);
        throw new Error(`Cannot save entity: id is empty or invalid`);
    }

    if (!(entity as any)._dirty) {
        // Diagnostics object is non-trivial to build (component walk +
        // preview mapping) — gate on the active level so the not-dirty
        // fast path stays allocation-free in production.
        if (logger.isLevelEnabled?.('trace')) {
            let dirtyComponents: string[] = [];
            try {
                dirtyComponents = getDirtyComponents(entity);
            } catch {
                // best-effort diagnostics only
            }

            const removedTypeIds = Array.from(entity.removedComponents);
            const entityType = (entity as any)?.constructor?.name ?? "Entity";
            const dirtyComponentPreview = dirtyComponents.slice(0, 10).map((component) => {
                const anyComponent = component as any;
                return {
                    type: anyComponent?.constructor?.name ?? "Component",
                    typeId: typeof anyComponent?.getTypeID === "function" ? anyComponent.getTypeID() : undefined,
                    id: anyComponent?.id,
                    persisted: anyComponent?._persisted,
                    dirty: anyComponent?._dirty,
                };
            });

            logger.trace(
                {
                    component: "Entity",
                    entity: {
                        type: entityType,
                        id: entity.id,
                        persisted: entity._persisted,
                        dirty: (entity as any)._dirty,
                    },
                    components: {
                        total: entity.components.size,
                        dirtyCount: dirtyComponents.length,
                        dirtyPreview: dirtyComponentPreview,
                    },
                    removedComponents: {
                        count: removedTypeIds.length,
                        typeIdsPreview: removedTypeIds.slice(0, 10),
                    },
                },
                "[Entity.doSave] Skipping save because entity is not dirty"
            );
        }
        return true;
    }

    // Cancellation goes through the shared `runWithSignal` helper so
    // every db.unsafe / trx`...` callsite in the framework uses the same
    // pattern: on abort the in-flight Bun SQL Query is cancelled, the
    // transaction callback throws, Bun emits ROLLBACK, and the pooled
    // backend connection is released. Without this a wall-clock timeout
    // leaks the backend into `idle in transaction` under pgbouncer
    // transaction-mode pooling.
    const run = <T>(q: any): Promise<T> => runWithSignal<T>(q, signal);

    const executeSave = async (saveTrx: SQL) => {
        if (!entity._persisted) {
            await run(saveTrx`INSERT INTO entities (id) VALUES (${entity.id}) ON CONFLICT DO NOTHING`);
            entity._persisted = true;
        }

        // Delete removed components from database. `components` is the
        // single source of membership truth — one DELETE per removal batch.
        if (entity.removedComponents.size > 0) {
            const typeIds = Array.from(entity.removedComponents);
            await run(saveTrx`DELETE FROM components WHERE entity_id = ${entity.id} AND type_id IN ${sql(typeIds)}`);
            // Move to savedRemovedComponents so resolvers can still detect removed components
            // This is needed because DataLoader may have stale cached data for this request
            for (const typeId of typeIds) {
                entity.savedRemovedComponents.add(typeId);
            }
            entity.removedComponents.clear();
        }

        if (entity.components.size === 0) {
            logger.trace(`No components to save for entity ${entity.id}`);
            return;
        }

        // Batch inserts and updates for better performance
        const componentsToInsert = [];
        const componentsToUpdate = [];

        for (const comp of entity.components.values()) {
            const compName = comp.constructor.name;
            // Registry readiness is pre-flighted in save() before the
            // transaction starts (H-DB-4). This assert catches a
            // theoretical race if a caller skipped save() and jumped
            // straight to doSave — we refuse to await inside the txn so
            // a slow DDL cannot hold a pg session idle in transaction.
            if (!ComponentRegistry.isComponentReady(compName)) {
                throw new Error(`Component ${compName} not ready; call save() (not doSave) or await registry readiness before the transaction.`);
            }

            if (!(comp as any)._persisted) {
                if (comp.id === "") {
                    comp.id = uuidv7();
                }
                componentsToInsert.push({
                    id: comp.id,
                    entity_id: entity.id,
                    name: compName,
                    type_id: comp.getTypeID(),
                    data: comp.serializableData()
                });
                (comp as any).setPersisted(true);
                (comp as any).setDirty(false);
            } else if ((comp as any)._dirty) {
                componentsToUpdate.push({
                    id: comp.id,
                    data: comp.serializableData()
                });
                (comp as any).setDirty(false);
            }
        }

        // Perform batch inserts
        if (componentsToInsert.length > 0) {
            await run(saveTrx`INSERT INTO components ${sql(componentsToInsert, 'id', 'entity_id', 'name', 'type_id', 'data')}`);
        }

        // Perform updates. Validate all ids up front (synchronous, fails
        // fast), then fire the UPDATEs together via Promise.all so they
        // pipeline on the transaction connection instead of paying one
        // serial round-trip per dirty component.
        if (componentsToUpdate.length > 0) {
            const traceEnabled = logger.isLevelEnabled?.('trace') === true;
            for (const comp of componentsToUpdate) {
                // Validate component ID to prevent PostgreSQL UUID parsing errors
                if (!comp.id || comp.id.trim() === '') {
                    logger.error(`Cannot update component: id is empty or invalid. Component data: ${JSON.stringify(comp.data).substring(0, 200)}`);
                    throw new Error(`Cannot update component: component id is empty or invalid`);
                }
                // Level-gated: per-component log-object allocation in the
                // write hot path is pure waste when trace is off.
                if (traceEnabled) {
                    logger.trace({ componentId: comp.id, data: comp.data }, `[Entity.doSave] Updating component`);
                }
            }
            await Promise.all(
                componentsToUpdate.map(comp =>
                    run(saveTrx`UPDATE components SET data = ${comp.data} WHERE id = ${comp.id}`)
                )
            );
        }
    };

    await executeSave(trx);

    entity.setDirty(false);

    return true;
}

export async function doDelete(entity: Entity, force: boolean = false): Promise<boolean> {
    if (!entity._persisted) {
        logger.warn("Entity is not persisted, cannot delete.");
        return false;
    }

    // AbortController cancels in-flight queries on wall-clock timeout so a
    // hanging DELETE cannot leak backends into `idle in transaction` under
    // pgbouncer transaction pool mode. Same pattern as Entity.save.
    const controller = new AbortController();
    const timeoutMs = QUERY_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
        const err = new Error(`Entity delete timeout for entity ${entity.id} after ${timeoutMs}ms`);
        logger.error({ scope: 'Entity.doDelete', entityId: entity.id, timeoutMs }, err.message);
        controller.abort(err);
    }, timeoutMs);

    const signal = controller.signal;
    const run = <T>(q: any): Promise<T> => runWithSignal<T>(q, signal);

    try {
        await db.transaction(async (trx) => {
            // Independent tables, no FK constraints — pipeline the
            // statements on the transaction connection instead of paying
            // serial round-trips while holding the connection.
            if (force) {
                await Promise.all([
                    run(trx`DELETE FROM components WHERE entity_id = ${entity.id}`),
                    run(trx`DELETE FROM entities WHERE id = ${entity.id}`),
                ]);
            } else {
                await Promise.all([
                    run(trx`UPDATE entities SET deleted_at = CURRENT_TIMESTAMP WHERE id = ${entity.id} AND deleted_at IS NULL`),
                    run(trx`UPDATE components SET deleted_at = CURRENT_TIMESTAMP WHERE entity_id = ${entity.id} AND deleted_at IS NULL`),
                ]);
            }
        });
        clearTimeout(timeoutHandle);

        // Fire-and-forget post-commit side effects: lifecycle hooks + cache
        // invalidation. Errors are logged, never propagate to caller.
        queueMicrotask(() => runPostDeleteSideEffects(entity, !force));

        return true;
    } catch (error) {
        clearTimeout(timeoutHandle);
        if (signal.aborted) {
            logger.error({ scope: 'Entity.doDelete', entityId: entity.id }, `Entity delete aborted: ${signal.reason ?? error}`);
        } else {
            logger.error({ scope: 'Entity.doDelete', entityId: entity.id, err: error }, 'Failed to delete entity');
        }
        // Re-throw so callers can distinguish DB failures (pool exhausted,
        // lock timeout, etc.) from "entity not found" / not persisted,
        // which still returns `false`. Previously any error produced the
        // same `false` return, hiding infrastructure problems (H-OBS-4).
        throw error instanceof Error ? error : new Error(String(error));
    } finally {
        if (!signal.aborted) controller.abort();
    }
}

/**
 * Get list of component type IDs that are dirty
 */
export function getDirtyComponents(entity: Entity): string[] {
    const dirtyComponents: string[] = [];
    for (const component of entity.components.values()) {
        // Include both dirty (modified) components AND new (not persisted) components
        // New components need to be cached after save, not just modified ones
        if ((component as any)._dirty || !(component as any)._persisted) {
            dirtyComponents.push(component.getTypeID());
        }
    }
    return dirtyComponents;
}
