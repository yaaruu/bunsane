/**
 * FK-less hasMany / hasOne / belongsTo must resolve the right rows and pin
 * type_id so LIST partitions can prune. The old loader scanned every
 * component partition for user_id or parent_id.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { getDb } from "../../../database";
import { createRequestLoaders } from "../../../core/RequestLoaders";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import {
    BaseArcheType,
    ArcheType,
    ArcheTypeField,
    HasMany,
    HasOne,
    BelongsTo,
} from "../../../core/ArcheType";
import { createTestContextWithoutCache, ensureComponentsRegistered } from "../../utils";

@Component
class FkSqlChildLink extends BaseComponent {
    @CompData() user_id: string = "";
    @CompData() note: string = "";
}

@Component
class FkSqlParentPtr extends BaseComponent {
    @CompData() parent_id: string = "";
}

@Component
class FkSqlDecoy extends BaseComponent {
    @CompData() user_id: string = "";
    @CompData() label: string = "";
}

@ArcheType({ name: "FkSqlChild" })
class FkSqlChild extends BaseArcheType {
    @ArcheTypeField(FkSqlChildLink)
    link!: FkSqlChildLink;
}

@ArcheType({ name: "FkSqlParent" })
class FkSqlParent extends BaseArcheType {
    @ArcheTypeField(FkSqlParentPtr)
    ptr!: FkSqlParentPtr;

    @HasMany(() => FkSqlChild)
    kids!: FkSqlChild[];

    @HasOne(() => FkSqlChild)
    kid!: FkSqlChild | null;

    @BelongsTo(() => FkSqlChild)
    owner!: FkSqlChild;
}

function entityId(value: unknown): string {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
        throw new Error("relation did not return an entity");
    }
    return value.id;
}

function entityIds(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error("relation did not return a list");
    return value.map((row) => entityId(row));
}

function captureUnsafe(): { sql: string[]; restore: () => void } {
    const real = getDb();
    const original = real.unsafe.bind(real);
    const sql: string[] = [];
    real.unsafe = ((query: string, params?: unknown[]) => {
        sql.push(typeof query === "string" ? query : String(query));
        return params === undefined ? original(query) : original(query, params);
    }) as typeof real.unsafe;
    return {
        sql,
        restore: () => {
            real.unsafe = original as typeof real.unsafe;
        },
    };
}

describe("FK-less relations pin type_id", () => {
    const ctx = createTestContextWithoutCache();

    beforeAll(async () => {
        await ensureComponentsRegistered(FkSqlChildLink, FkSqlParentPtr, FkSqlDecoy);
    });

    test("hasMany, hasOne, and belongsTo resolve and the SQL includes type_id", async () => {
        const owner = ctx.tracker.create();
        owner.add(FkSqlDecoy, { user_id: "unused", label: "owner-shell" });
        await owner.save();

        const parent = ctx.tracker.create();
        parent.add(FkSqlParentPtr, { parent_id: owner.id });
        await parent.save();

        const childA = ctx.tracker.create();
        childA.add(FkSqlChildLink, { user_id: parent.id, note: "a" });
        await childA.save();

        const childB = ctx.tracker.create();
        childB.add(FkSqlChildLink, { user_id: parent.id, note: "b" });
        await childB.save();

        const decoy = ctx.tracker.create();
        decoy.add(FkSqlDecoy, { user_id: parent.id, label: "not-a-child" });
        await decoy.save();

        const resolvers = new FkSqlParent().generateFieldResolvers();
        const kids = resolvers.find((entry) => entry.fieldName === "kids");
        const kid = resolvers.find((entry) => entry.fieldName === "kid");
        const belongs = resolvers.find((entry) => entry.fieldName === "owner");
        expect(kids).toBeDefined();
        expect(kid).toBeDefined();
        expect(belongs).toBeDefined();

        const loaders = createRequestLoaders(getDb());
        const captured = captureUnsafe();
        try {
            const many = await kids!.resolver({ id: parent.id }, {}, { loaders });
            const one = await kid!.resolver({ id: parent.id }, {}, { loaders });
            const related = await belongs!.resolver({ id: parent.id }, {}, { loaders });

            const manyIds = entityIds(many).sort();
            expect(manyIds).toEqual([childA.id, childB.id].sort());
            expect(manyIds).not.toContain(decoy.id);

            const oneId = entityId(one);
            expect([childA.id, childB.id]).toContain(oneId);
            expect(oneId).not.toBe(decoy.id);
            expect(entityId(related)).toBe(owner.id);

            expect(captured.sql.some((statement) =>
                /type_id\s*=/.test(statement) && statement.includes("user_id")
            )).toBe(true);
            expect(captured.sql.some((statement) => statement.includes("type_id"))).toBe(true);
            expect(captured.sql.some((statement) => statement.includes("COALESCE(c.data->>'user_id'"))).toBe(false);
        } finally {
            captured.restore();
        }
    });
});
