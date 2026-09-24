// Persistence path for Entity (save / doSave / doDelete / saveMany) and
// post-commit side effects. Extracted from Entity.ts (RFC_REFACTOR_TARGETS
// §3.2). Pure functions take the entity instance as the first parameter.
//
// Persisted/dirty flags and the removal sets are mutated only after every
// statement in the transaction succeeds (entity upsert, deletes, inserts,
// component upserts, QSP projection, read-model sync). A rolled-back save
// must leave the instance dirty so the next save() reissues every statement.
import { logger } from "../Logger";
import { QUERY_TIMEOUT_MS } from "../../database";
import { dbTransaction } from "../../database/gateway";
import { runWithSignal } from "../../database/cancellable";
import ComponentRegistry from "../components/ComponentRegistry";
import type { BaseComponent } from "../components";
import { uuidv7 } from "../../utils/uuid";
import { sql, SQL } from "bun";
import EntityHookManager from "../EntityHookManager";
import { EntityCreatedEvent, EntityUpdatedEvent } from "../events/EntityLifecycleEvents";
import { trackSideEffect } from "./pendingOps";
import { handleCacheAfterSave, runPostDeleteSideEffects } from "./cacheStrategies";
import { ProjectionManager } from "../../database/projection";
import { ReadModelManager } from "../../database/readmodel";
import type { Entity } from "../Entity";

/**
 * How long the client-side timer waits BEYOND the deadline it hands the gateway.
 *
 * The two used to fire at the same instant, which made the resulting error a
 * coin flip: the server bound raises `DbStatementTimeoutError` (carrying lane,
 * label and budget), the client timer raises a plain `Error`, and a caller
 * matching on the type would catch it only sometimes.
 *
 * They are not peers. `SET LOCAL statement_timeout` actually stops the work and
 * releases the pool slot; the client timer only stops *waiting* — an aborted
 * statement keeps running (docs/POOLING.md B8a). So the server bound is the
 * primary and gets to win, and this timer is the backstop for the cases it
 * cannot cover: PGlite, `BUNSANE_DB_SERVER_TIMEOUT=off`, a caller-supplied
 * transaction, or work between statements that no statement timeout can see.
 */
export const SAVE_CLIENT_BACKSTOP_MS = 2_000;

/** Rows per multi-row INSERT / upsert / delete chunk. */
const SAVE_ROW_CHUNK = 500;

export type SaveContext = {
    loaders?: { componentsByEntityType?: { clear(key: { entityId: string; typeId: string }): void } };
    trx?: SQL;
    signal?: AbortSignal;
};

export type SaveManyOptions = {
    trx?: SQL;
    signal?: AbortSignal;
    context?: SaveContext;
};

/** Protected persistence bits. This module is their writer. */
type PersistenceFlags = { _dirty: boolean; _persisted: boolean };

function flagsOf(target: object): PersistenceFlags {
    return target as unknown as PersistenceFlags;
}

function entityIsDirty(entity: Entity): boolean {
    return flagsOf(entity)._dirty;
}

type ComponentWriteRow = {
    id: string;
    entity_id: string;
    name: string;
    type_id: string;
    data: Record<string, unknown>;
};

type EntitySavePlan = {
    entity: Entity;
    removedTypeIds: string[];
    toInsert: ComponentWriteRow[];
    toUpdate: ComponentWriteRow[];
    insertedComps: BaseComponent[];
    updatedComps: BaseComponent[];
};

type CapturedSave = {
    entity: Entity;
    wasNew: boolean;
    changedComponentTypeIds: string[];
    removedComponentTypeIds: string[];
};

export async function saveEntity(entity: Entity, trx?: SQL, context?: SaveContext): Promise<boolean> {
    return saveMany([entity], { trx, context });
}

/**
 * Persist many entities in one admission and one transaction.
 *
 * One multi-row entity upsert (insert new ids, bump `updated_at` on conflict),
 * one batched delete, one batched component insert, and one batched upsert,
 * each chunked at 500 rows. Hooks and cache invalidation run post-commit,
 * per entity, the same way `save()` does.
 */
export async function saveMany(entities: Entity[], opts?: SaveManyOptions): Promise<boolean> {
    if (entities.length === 0) return true;

    const unique: Entity[] = [];
    const seen = new Set<string>();
    for (const entity of entities) {
        if (seen.has(entity.id)) continue;
        seen.add(entity.id);
        unique.push(entity);
    }

    // Capture pre-save state BEFORE executeBatch mutates persisted/dirty flags.
    const captured: CapturedSave[] = unique.map((entity) => ({
        entity,
        wasNew: !entity._persisted,
        changedComponentTypeIds: getDirtyComponents(entity),
        removedComponentTypeIds: Array.from(entity.removedComponents),
    }));

    // Await registry readiness BEFORE opening the transaction so a slow
    // partition DDL cannot hold a pg session idle in transaction (H-DB-4).
    for (const entity of unique) {
        if (!entityIsDirty(entity)) continue;
        for (const comp of entity.components.values()) {
            const compName = comp.constructor.name;
            if (!ComponentRegistry.isComponentReady(compName)) {
                await ComponentRegistry.getReadyPromise(compName);
            }
        }
    }

    const profile = process.env.DB_SAVE_PROFILE === "true";
    const phaseStart = profile ? performance.now() : 0;
    const phases: Record<string, number> = {};
    const anyDirty = unique.some(entityIsDirty);
    const context = opts?.context;
    const callerTrx = opts?.trx ?? context?.trx;

    if (anyDirty) {
        const controller = new AbortController();
        const timeoutMs = QUERY_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        const timeoutLabel = unique.length === 1
            ? `entity ${unique[0]!.id}`
            : `${unique.length} entities`;
        const timeoutHandle = setTimeout(() => {
            const err = new Error(`Entity save timeout for ${timeoutLabel} after ${timeoutMs}ms`);
            logger.error(
                { scope: "Entity.save", entityId: unique.length === 1 ? unique[0]!.id : undefined, count: unique.length, timeoutMs },
                err.message,
            );
            controller.abort(err);
        }, timeoutMs + SAVE_CLIENT_BACKSTOP_MS);

        const callerSignal = opts?.signal;
        const onCallerAbort = () => controller.abort(callerSignal?.reason);
        if (callerSignal) {
            if (callerSignal.aborted) controller.abort(callerSignal.reason);
            else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }

        try {
            const dbStart = profile ? performance.now() : 0;
            if (callerTrx) {
                await executeBatch(unique, callerTrx, controller.signal);
            } else {
                await dbTransaction(
                    async (newTrx) => {
                        await executeBatch(unique, newTrx, controller.signal);
                    },
                    {
                        lane: "request",
                        label: unique.length === 1 ? "entity.save" : "entity.saveMany",
                        deadline,
                        signal: controller.signal,
                    },
                );
            }
            if (profile) phases.db = performance.now() - dbStart;
            clearTimeout(timeoutHandle);
        } catch (error) {
            clearTimeout(timeoutHandle);
            if (controller.signal.aborted) {
                throw controller.signal.reason ?? error;
            }
            throw error;
        } finally {
            if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
            if (!controller.signal.aborted) controller.abort();
        }
    }

    const profileForPost = profile && unique.length === 1;
    for (const cap of captured) {
        const sideEffectPromise = new Promise<void>((resolve) => {
            queueMicrotask(() => {
                runPostCommitSideEffects(
                    cap.entity,
                    cap.wasNew,
                    cap.changedComponentTypeIds,
                    cap.removedComponentTypeIds,
                    context,
                    profileForPost ? phases : undefined,
                    profileForPost ? phaseStart : undefined,
                ).finally(() => resolve());
            });
        });
        trackSideEffect(sideEffectPromise);
    }

    return true;
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
    context: SaveContext | undefined,
    phases: Record<string, number> | undefined,
    phaseStart: number | undefined,
): Promise<void> {
    const profile = phases !== undefined && phaseStart !== undefined;

    const cacheStart = profile ? performance.now() : 0;
    try {
        await handleCacheAfterSave(entity, changedComponentTypeIds, removedComponentTypeIds, context);
    } catch (err) {
        logger.warn({ scope: "cache", entityId: entity.id, err }, "post-commit cache invalidation failed");
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
        logger.error({ scope: "hooks", entityId: entity.id, err }, "post-commit lifecycle hooks failed");
    }
    if (profile) phases!.hooks = performance.now() - hookStart;

    if (profile) {
        phases!.total = performance.now() - phaseStart!;
        logger.info({ scope: "Entity.save.profile", entityId: entity.id, phases }, "Entity.save phase timings");
    }
}

function logSkipNotDirty(entity: Entity): void {
    if (!logger.isLevelEnabled?.("trace")) return;
    let dirtyComponents: string[] = [];
    try {
        dirtyComponents = getDirtyComponents(entity);
    } catch {
        // best-effort diagnostics only
    }
    const removedTypeIds = Array.from(entity.removedComponents);
    const entityType = entity.constructor?.name ?? "Entity";
    logger.trace(
        {
            component: "Entity",
            entity: {
                type: entityType,
                id: entity.id,
                persisted: entity._persisted,
                dirty: flagsOf(entity)._dirty,
            },
            components: {
                total: entity.components.size,
                dirtyCount: dirtyComponents.length,
                dirtyPreview: dirtyComponents.slice(0, 10),
            },
            removedComponents: {
                count: removedTypeIds.length,
                typeIdsPreview: removedTypeIds.slice(0, 10),
            },
        },
        "[Entity.doSave] Skipping save because entity is not dirty",
    );
}

function planEntity(entity: Entity): EntitySavePlan {
    const removedTypeIds = Array.from(entity.removedComponents);
    const toInsert: ComponentWriteRow[] = [];
    const toUpdate: ComponentWriteRow[] = [];
    const insertedComps: BaseComponent[] = [];
    const updatedComps: BaseComponent[] = [];

    if (entity.components.size === 0) {
        logger.trace(`No components to save for entity ${entity.id}`);
    }

    const traceEnabled = logger.isLevelEnabled?.("trace") === true;

    for (const comp of entity.components.values()) {
        const compName = comp.constructor.name;
        if (!ComponentRegistry.isComponentReady(compName)) {
            throw new Error(`Component ${compName} not ready; call save() (not doSave) or await registry readiness before the transaction.`);
        }
        const compFlags = flagsOf(comp);
        if (!compFlags._persisted) {
            if (comp.id === "") {
                comp.id = uuidv7();
            }
            toInsert.push({
                id: comp.id,
                entity_id: entity.id,
                name: compName,
                type_id: comp.getTypeID(),
                data: comp.serializableData(),
            });
            insertedComps.push(comp);
        } else if (compFlags._dirty) {
            if (!comp.id || comp.id.trim() === "") {
                logger.error(`Cannot update component: id is empty or invalid. Component data: ${JSON.stringify(comp.serializableData()).substring(0, 200)}`);
                throw new Error("Cannot update component: component id is empty or invalid");
            }
            const data = comp.serializableData();
            if (traceEnabled) {
                logger.trace({ componentId: comp.id, data }, "[Entity.doSave] Updating component");
            }
            toUpdate.push({
                id: comp.id,
                entity_id: entity.id,
                name: compName,
                type_id: comp.getTypeID(),
                data,
            });
            updatedComps.push(comp);
        }
    }

    return { entity, removedTypeIds, toInsert, toUpdate, insertedComps, updatedComps };
}

function applySaveFlags(plans: EntitySavePlan[]): void {
    for (const plan of plans) {
        const entity = plan.entity;
        for (const typeId of plan.removedTypeIds) {
            entity.savedRemovedComponents.add(typeId);
        }
        if (plan.removedTypeIds.length > 0) {
            entity.removedComponents.clear();
        }
        for (const comp of plan.insertedComps) {
            comp.setPersisted(true);
            comp.setDirty(false);
        }
        for (const comp of plan.updatedComps) {
            comp.setDirty(false);
        }
        entity.setPersisted(true);
        entity.setDirty(false);
    }
}

async function forChunks<T>(rows: T[], run: (chunk: T[]) => Promise<void>): Promise<void> {
    if (rows.length === 0) return;
    if (rows.length <= SAVE_ROW_CHUNK) {
        await run(rows);
        return;
    }
    for (let i = 0; i < rows.length; i += SAVE_ROW_CHUNK) {
        await run(rows.slice(i, i + SAVE_ROW_CHUNK));
    }
}

async function upsertEntityRows(
    trx: SQL,
    entities: Entity[],
    run: <T>(q: Promise<T> | T) => Promise<T>,
): Promise<void> {
    // One statement for new ids and for the updated_at bump on rows that
    // already exist. NOW() is transaction_timestamp(), so the component
    // upsert in this same transaction stamps the same instant. QSP reads
    // entities.updated_at after this statement and therefore mirrors it.
    if (entities.length === 1) {
        const id = entities[0]!.id;
        await run(trx`INSERT INTO entities (id) VALUES (${id}) ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`);
        return;
    }
    const rows = entities.map((entity) => ({ id: entity.id }));
    await forChunks(rows, async (chunk) => {
        await run(trx`INSERT INTO entities ${sql(chunk, "id")} ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`);
    });
}

async function deleteRemoved(
    trx: SQL,
    plans: EntitySavePlan[],
    run: <T>(q: Promise<T> | T) => Promise<T>,
): Promise<void> {
    const pairs: Array<{ entity_id: string; type_id: string }> = [];
    for (const plan of plans) {
        for (const typeId of plan.removedTypeIds) {
            pairs.push({ entity_id: plan.entity.id, type_id: typeId });
        }
    }
    if (pairs.length === 0) return;

    const firstEntityId = pairs[0]!.entity_id;
    const singleEntity = pairs.every((pair) => pair.entity_id === firstEntityId);
    if (singleEntity) {
        const typeIds = pairs.map((pair) => pair.type_id);
        await run(trx`DELETE FROM components WHERE entity_id = ${firstEntityId} AND type_id IN ${sql(typeIds)}`);
        return;
    }

    const byType = new Map<string, string[]>();
    for (const pair of pairs) {
        const list = byType.get(pair.type_id);
        if (list) list.push(pair.entity_id);
        else byType.set(pair.type_id, [pair.entity_id]);
    }
    for (const [typeId, entityIds] of byType) {
        await forChunks(entityIds, async (chunk) => {
            await run(trx`DELETE FROM components WHERE type_id = ${typeId} AND entity_id IN ${sql(chunk)}`);
        });
    }
}

async function insertComponents(
    trx: SQL,
    rows: ComponentWriteRow[],
    run: <T>(q: Promise<T> | T) => Promise<T>,
): Promise<void> {
    await forChunks(rows, async (chunk) => {
        await run(trx`INSERT INTO components ${sql(chunk, "id", "entity_id", "name", "type_id", "data")}`);
    });
}

async function upsertComponents(
    trx: SQL,
    rows: ComponentWriteRow[],
    run: <T>(q: Promise<T> | T) => Promise<T>,
): Promise<void> {
    // Conflict target is the (id, type_id) PRIMARY KEY, which contains the
    // partition key type_id — required for ON CONFLICT on the partitioned
    // components table. created_at is preserved; updated_at moves.
    await forChunks(rows, async (chunk) => {
        await run(trx`INSERT INTO components ${sql(chunk, "id", "entity_id", "name", "type_id", "data")} ON CONFLICT (id, type_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
    });
}

async function executeBatch(entities: Entity[], trx: SQL, signal?: AbortSignal): Promise<boolean> {
    for (const entity of entities) {
        if (!entity.id || entity.id.trim() === "") {
            logger.error("Cannot save entity: id is empty or invalid");
            throw new Error("Cannot save entity: id is empty or invalid");
        }
    }

    const dirty = entities.filter(entityIsDirty);
    if (dirty.length === 0) {
        for (const entity of entities) logSkipNotDirty(entity);
        return true;
    }
    for (const entity of entities) {
        if (!entityIsDirty(entity)) logSkipNotDirty(entity);
    }

    // Plans are built before any SQL so a serializableData throw cannot leave
    // a prefix of the batch flagged clean. Id minting is the only mutation
    // here; it is idempotent across a retry.
    const plans = dirty.map(planEntity);
    const run = <T>(q: Promise<T> | T): Promise<T> => runWithSignal<T>(q, signal);

    await upsertEntityRows(trx, dirty, run);
    await deleteRemoved(trx, plans, run);

    const toInsert: ComponentWriteRow[] = [];
    const toUpdate: ComponentWriteRow[] = [];
    for (const plan of plans) {
        for (const row of plan.toInsert) toInsert.push(row);
        for (const row of plan.toUpdate) toUpdate.push(row);
    }
    await insertComponents(trx, toInsert, run);
    await upsertComponents(trx, toUpdate, run);

    if (ProjectionManager.enabled) {
        for (const plan of plans) {
            const touched = [
                ...plan.insertedComps.map((comp) => comp.getTypeID()),
                ...plan.updatedComps.map((comp) => comp.getTypeID()),
                ...plan.removedTypeIds,
            ];
            if (touched.length === 0) continue;
            await ProjectionManager.instance.upsertProjection(plan.entity, touched, trx);
        }
    }

    for (const entity of dirty) {
        await ReadModelManager.instance.syncOnSave(entity, trx);
    }

    applySaveFlags(plans);
    return true;
}

export async function doSave(entity: Entity, trx: SQL, signal?: AbortSignal): Promise<boolean> {
    return executeBatch([entity], trx, signal);
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
    // Shared with the gateway, as in `save` above: one budget covering the wait
    // for capacity and the transaction itself.
    const deadline = Date.now() + timeoutMs;
    const timeoutHandle = setTimeout(() => {
        const err = new Error(`Entity delete timeout for entity ${entity.id} after ${timeoutMs}ms`);
        logger.error({ scope: "Entity.doDelete", entityId: entity.id, timeoutMs }, err.message);
        // Backstop, same as save: let the server bound produce the legible error.
        controller.abort(err);
    }, timeoutMs + SAVE_CLIENT_BACKSTOP_MS);

    const signal = controller.signal;
    const run = <T>(q: Promise<T> | T): Promise<T> => runWithSignal<T>(q, signal);

    try {
        await dbTransaction(async (trx) => {
            // Independent tables, no FK constraints. Issued sequentially:
            // multiple concurrent in-flight queries on one connection
            // deadlock single-backend servers (PGlite test harness), and a
            // single wire serializes them anyway — Promise.all gave no real
            // pipelining here.
            if (force) {
                await run(trx`DELETE FROM components WHERE entity_id = ${entity.id}`);
                await run(trx`DELETE FROM entities WHERE id = ${entity.id}`);
            } else {
                await run(trx`UPDATE entities SET deleted_at = CURRENT_TIMESTAMP WHERE id = ${entity.id} AND deleted_at IS NULL`);
                await run(trx`UPDATE components SET deleted_at = CURRENT_TIMESTAMP WHERE entity_id = ${entity.id} AND deleted_at IS NULL`);
            }
            if (ProjectionManager.enabled) {
                await ProjectionManager.instance.deleteProjection(entity.id, force, trx);
            }
            await ReadModelManager.instance.syncOnDelete(entity.id, force, trx);
        }, { lane: "request", label: "entity.delete", deadline, signal: controller.signal });
        clearTimeout(timeoutHandle);

        // Fire-and-forget post-commit side effects: lifecycle hooks + cache
        // invalidation. Errors are logged, never propagate to caller.
        // Tracked in pendingSideEffects (same as the save path) so
        // Entity.drainPendingSideEffects() / shutdown can await cache
        // invalidation — otherwise a script that deletes then exits leaves
        // the write-through cache serving deleted rows.
        trackSideEffect(new Promise<void>((resolve) => {
            queueMicrotask(() => {
                runPostDeleteSideEffects(entity, !force).finally(() => resolve());
            });
        }));

        return true;
    } catch (error) {
        clearTimeout(timeoutHandle);
        if (signal.aborted) {
            logger.error({ scope: "Entity.doDelete", entityId: entity.id }, `Entity delete aborted: ${signal.reason ?? error}`);
        } else {
            logger.error({ scope: "Entity.doDelete", entityId: entity.id, err: error }, "Failed to delete entity");
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
        const compFlags = flagsOf(component);
        if (compFlags._dirty || !compFlags._persisted) {
            dirtyComponents.push(component.getTypeID());
        }
    }
    return dirtyComponents;
}
