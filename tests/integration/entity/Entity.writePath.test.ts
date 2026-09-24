/**
 * Entity write/read regressions:
 * - a failed component write leaves flags dirty so the next save() reissues SQL
 * - component and entity updated_at move on a dirty save
 * - DB failures are ComponentLoadError, confirmed absence is ComponentMissingError
 * - eager load revives Date fields
 * - remove() of an unloaded component still deletes on save
 * - saveMany / EntityManager.savePendingEntities persist a batch in one transaction
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { sql, type SQL } from "bun";
import db from "../../../database";
import { Entity } from "../../../core/Entity";
import { ComponentLoadError, ComponentMissingError } from "../../../core/entity/errors";
import { CacheManager, COMPONENT_TOMBSTONE } from "../../../core/cache/CacheManager";
import { ComponentRegistry } from "../../../core/components";
import EntityManager from "../../../core/EntityManager";
import { TestUser, TestProduct, TestOrder } from "../../fixtures/components";
import { createTestContext, ensureComponentsRegistered } from "../../utils";
import { drainPendingCacheOps } from "../../../core/entity/pendingOps";

type ManagerInternals = {
    entityQueue: Entity[];
    savePendingEntities(): Promise<void>;
};

function manager(): ManagerInternals {
    return EntityManager as unknown as ManagerInternals;
}

function rowData(row: { data: unknown }): Record<string, unknown> {
    const parsed = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    throw new Error("component data was not an object");
}

function isDirty(entity: Entity): boolean {
    return (entity as unknown as { _dirty: boolean })._dirty;
}

describe("Entity write path", () => {
    const ctx = createTestContext();
    let userTypeId = "";
    let productTypeId = "";
    let orderTypeId = "";

    beforeAll(async () => {
        await ensureComponentsRegistered(TestUser, TestProduct, TestOrder);
        userTypeId = ComponentRegistry.getComponentId("TestUser")!;
        productTypeId = ComponentRegistry.getComponentId("TestProduct")!;
        orderTypeId = ComponentRegistry.getComponentId("TestOrder")!;
    });

    test("failed component insert leaves flags dirty and the retry writes rows", async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: "retry", email: "retry@example.com", age: 3 });
        const comp = entity.getInMemory(TestUser)!;
        comp.id = "not-a-uuid";

        await expect(entity.save()).rejects.toThrow();

        expect(entity._persisted).toBe(false);
        expect(isDirty(entity)).toBe(true);
        expect((comp as unknown as { _persisted: boolean })._persisted).toBe(false);
        const rolledBack = await db`SELECT id FROM entities WHERE id = ${entity.id}`;
        expect(rolledBack.length).toBe(0);

        comp.id = "";
        await entity.save();

        expect(entity._persisted).toBe(true);
        expect(isDirty(entity)).toBe(false);
        const rows = await db`SELECT id, data FROM components WHERE entity_id = ${entity.id} AND type_id = ${userTypeId} AND deleted_at IS NULL`;
        expect(rows.length).toBe(1);
        expect(rowData(rows[0]!).name).toBe("retry");
    });

    test("failed component update keeps dirty flags and the retry writes the new row", async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: "before", email: "before@example.com", age: 4 });
        entity.add(TestProduct, { sku: "SKU", name: "keep", price: 1, inStock: true });
        await entity.save();

        const before = await db`SELECT updated_at FROM entities WHERE id = ${entity.id}`;
        const beforeAt = new Date(before[0]!.updated_at as string | Date).getTime();

        entity.remove(TestProduct);
        await entity.set(TestUser, { name: "after-retry" });
        const comp = entity.getInMemory(TestUser)!;
        const realId = comp.id;
        comp.id = "not-a-uuid";

        await expect(entity.save()).rejects.toThrow();

        expect(entity._persisted).toBe(true);
        expect(isDirty(entity)).toBe(true);
        expect((comp as unknown as { _dirty: boolean })._dirty).toBe(true);
        expect(entity.removedComponents.has(productTypeId)).toBe(true);
        const stillOld = await db`SELECT data FROM components WHERE entity_id = ${entity.id} AND type_id = ${userTypeId} AND deleted_at IS NULL`;
        expect(rowData(stillOld[0]!).name).toBe("before");

        comp.id = realId;
        await entity.save();

        const userRows = await db`SELECT data, updated_at FROM components WHERE entity_id = ${entity.id} AND type_id = ${userTypeId} AND deleted_at IS NULL`;
        expect(rowData(userRows[0]!).name).toBe("after-retry");
        const productRows = await db`SELECT id FROM components WHERE entity_id = ${entity.id} AND type_id = ${productTypeId} AND deleted_at IS NULL`;
        expect(productRows.length).toBe(0);
        const after = await db`SELECT updated_at FROM entities WHERE id = ${entity.id}`;
        const afterAt = new Date(after[0]!.updated_at as string | Date).getTime();
        const componentAt = new Date(userRows[0]!.updated_at as string | Date).getTime();
        expect(afterAt).toBeGreaterThan(beforeAt);
        expect(componentAt).toBeGreaterThan(beforeAt);
    });

    test("getOrThrow distinguishes a missing component from a failed read", async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: "present", email: "p@example.com", age: 5 });
        await entity.save();

        const fresh = new Entity(entity.id);
        await expect(fresh.getOrThrow(TestProduct)).rejects.toBeInstanceOf(ComponentMissingError);

        function failingTrx(): never {
            throw new Error("simulated read failure");
        }
        const again = new Entity(entity.id);
        await expect(again.get(TestUser, { trx: failingTrx as unknown as SQL })).rejects.toBeInstanceOf(ComponentLoadError);
        expect(again._missingComponents.has(userTypeId)).toBe(false);
        await expect(again.getOrThrow(TestUser, { trx: failingTrx as unknown as SQL })).rejects.toBeInstanceOf(ComponentLoadError);
    });

    test("LoadComponents and LoadMultiple revive Date fields", async () => {
        const createdAt = new Date("2024-06-15T10:30:00.000Z");
        const entity = ctx.tracker.create();
        entity.add(TestOrder, {
            orderNumber: "ORD-DATE",
            total: 12,
            status: "open",
            createdAt,
        });
        await entity.save();

        const eager = new Entity(entity.id);
        await Entity.LoadComponents([eager], [orderTypeId]);
        const loaded = eager.getInMemory(TestOrder);
        expect(loaded?.createdAt).toBeInstanceOf(Date);
        expect(loaded?.createdAt.toISOString()).toBe(createdAt.toISOString());

        const many = await Entity.LoadMultiple([entity.id]);
        const fromMany = many[0]?.getInMemory(TestOrder);
        expect(fromMany?.createdAt).toBeInstanceOf(Date);
        expect(fromMany?.createdAt.toISOString()).toBe(createdAt.toISOString());

        // A later save that does not replace the date must not throw.
        await eager.set(TestOrder, { status: "closed" });
        await expect(eager.save()).resolves.toBe(true);
    });

    test("remove() of an unloaded component deletes it on save; has() is memory-only", async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: "keep", email: "keep@example.com", age: 6 });
        entity.add(TestProduct, { sku: "DEL", name: "gone", price: 2, inStock: false });
        await entity.save();

        const bare = new Entity(entity.id);
        bare.setPersisted(true);
        bare.setDirty(false);
        expect(bare.has(TestProduct)).toBe(false);
        expect(await bare.hasPersisted(TestUser)).toBe(true);
        expect(bare.has(TestUser)).toBe(true);

        const deleter = new Entity(entity.id);
        deleter.setPersisted(true);
        deleter.setDirty(false);
        expect(deleter.remove(TestProduct)).toBe(true);
        expect(deleter.wasRemoved(TestProduct)).toBe(true);
        expect(await deleter.get(TestProduct)).toBeNull();
        await deleter.save();

        const left = await db`SELECT id FROM components WHERE entity_id = ${entity.id} AND type_id = ${productTypeId} AND deleted_at IS NULL`;
        expect(left.length).toBe(0);
        const user = await db`SELECT id FROM components WHERE entity_id = ${entity.id} AND type_id = ${userTypeId} AND deleted_at IS NULL`;
        expect(user.length).toBe(1);
    });

    test("saveMany persists and updates a batch; pending entities use it", async () => {
        const batch = [1, 2, 3].map((age) => {
            const entity = ctx.tracker.create();
            entity.add(TestUser, { name: `batch-${age}`, email: `b${age}@example.com`, age });
            return entity;
        });

        await Entity.saveMany(batch);

        for (const entity of batch) {
            expect(entity._persisted).toBe(true);
            expect(isDirty(entity)).toBe(false);
        }
        const ids = batch.map((entity) => entity.id);
        const inserted = await db`SELECT id FROM entities WHERE id IN ${sql(ids)}`;
        expect(inserted.length).toBe(3);

        for (const entity of batch) {
            await entity.set(TestUser, { age: 90 });
        }
        await Entity.saveMany(batch);
        const updated = await db`SELECT data FROM components WHERE entity_id IN ${sql(ids)} AND type_id = ${userTypeId}`;
        expect(updated.length).toBe(3);
        for (const row of updated) {
            expect(rowData(row).age).toBe(90);
        }

        const queued = ctx.tracker.create();
        queued.add(TestUser, { name: "queued", email: "queued@example.com", age: 8 });
        manager().entityQueue.length = 0;
        manager().entityQueue.push(queued);
        await manager().savePendingEntities();
        expect(queued._persisted).toBe(true);
        expect(manager().entityQueue.includes(queued)).toBe(false);
        const queuedRows = await db`SELECT id FROM components WHERE entity_id = ${queued.id} AND deleted_at IS NULL`;
        expect(queuedRows.length).toBe(1);
    });

    test("LoadComponents skipCache bypasses a tombstone and otherwise writes one", async () => {
        const entity = ctx.tracker.create();
        entity.add(TestUser, { name: "cached", email: "cached@example.com", age: 9 });
        await entity.save();
        await Entity.drainPendingSideEffects();

        const cacheManager = CacheManager.getInstance();
        await cacheManager.initialize({
            enabled: true,
            provider: "memory",
            strategy: "write-through",
            defaultTTL: 60_000,
            entity: { enabled: false, ttl: 60_000 },
            component: { enabled: true, ttl: 60_000, negativeCacheEnabled: true, negativeCacheTtl: 60_000 },
            query: { enabled: false, ttl: 60_000, maxSize: 100 },
        });
        await cacheManager.getProvider().clear();

        const reader = new Entity(entity.id);
        await Entity.LoadComponents([reader], [productTypeId]);
        await drainPendingCacheOps();
        expect(reader.hasInMemory(TestProduct)).toBe(false);
        const [tombstone] = await cacheManager.getComponents([{ entityId: entity.id, typeId: productTypeId }]);
        expect(tombstone).toBe(COMPONENT_TOMBSTONE);

        await db`INSERT INTO components (id, entity_id, type_id, name, data, created_at, updated_at)
                 VALUES (${crypto.randomUUID()}, ${entity.id}, ${productTypeId}, ${"TestProduct"}, ${{ sku: "late", name: "late", price: 3, inStock: true }}, now(), now())`;

        const cached = new Entity(entity.id);
        await Entity.LoadComponents([cached], [productTypeId]);
        expect(cached.hasInMemory(TestProduct)).toBe(false);

        const fresh = new Entity(entity.id);
        await Entity.LoadComponents([fresh], [productTypeId], true);
        expect(fresh.getInMemory(TestProduct)?.name).toBe("late");

        await cacheManager.getProvider().clear();
        await cacheManager.initialize({
            enabled: false,
            provider: "memory",
            strategy: "write-invalidate",
            defaultTTL: 60_000,
            entity: { enabled: false, ttl: 60_000 },
            component: { enabled: false, ttl: 60_000 },
            query: { enabled: false, ttl: 60_000, maxSize: 100 },
        });
    });
});
