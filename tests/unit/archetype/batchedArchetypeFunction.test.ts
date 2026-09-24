import { describe, test, expect } from "bun:test";
import { rejectBatchMiss } from "../../../core/archetype/functionReturn";
import { Entity } from "../../../core/Entity";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import {
    BaseArcheType,
    ArcheType,
    ArcheTypeField,
    ArcheTypeFunction,
    weaveAllArchetypes,
} from "../../../core/ArcheType";
import DataLoader from "dataloader";

@Component
class BatchFnInfo extends BaseComponent {
    @CompData() label: string = "";
}

@ArcheType({ name: "BatchFnArch" })
class BatchFnArch extends BaseArcheType {
    @ArcheTypeField(BatchFnInfo)
    info!: BatchFnInfo;

    @ArcheTypeFunction({
        returnType: "number",
        batch: true,
        args: [{ name: "since", type: String, nullable: true }],
    })
    async total(
        parents: readonly Entity[],
        _ctx: unknown,
        args?: Record<string, unknown>,
    ): Promise<Map<string, number>> {
        BatchFnArch.calls.push({
            size: parents.length,
            ids: parents.map((parent) => parent.id),
            since: typeof args?.since === "string" ? args.since : null,
            receiver: this,
        });
        const out = new Map<string, number>();
        for (const parent of parents) out.set(parent.id, parent.id.length);
        return out;
    }

    @ArcheTypeFunction({
        returnType: "number",
        args: [{ name: "since", type: String, nullable: true }],
    })
    async each(entity: Entity): Promise<number> {
        BatchFnArch.perRow += 1;
        return entity.id.length;
    }

    @ArcheTypeFunction({ returnType: "number", batch: true })
    async boom(_parents: readonly Entity[], _ctx: unknown): Promise<Map<string, number>> {
        throw new Error("batch failed");
    }

    @ArcheTypeFunction({ returnType: "number", batch: true })
    async partial(parents: readonly Entity[], _ctx: unknown): Promise<Map<string, number>> {
        const first = parents[0];
        return first ? new Map([[first.id, 7]]) : new Map();
    }

    static calls: Array<{ size: number; ids: string[]; since: string | null; receiver: unknown }> = [];
    static perRow = 0;
}

@ArcheType({ name: "BatchFnBad" })
class BatchFnBad extends BaseArcheType {
    // @ts-expect-error batch: true requires (parents, ctx, args?) => Map
    @ArcheTypeFunction({ returnType: "number", batch: true })
    async bad(entity: Entity): Promise<number> {
        return entity.id.length;
    }
}

function context() {
    return {
        loaders: {
            archetypeFunctionBatches: new Map<string, DataLoader<Entity, unknown, string>>(),
        },
    };
}

function resolver(field: string) {
    const found = new BatchFnArch().generateFieldResolvers().find(
        (entry) => entry.typeName === "BatchFnArch" && entry.fieldName === field,
    );
    if (!found) throw new Error(`missing resolver ${field}`);
    return found.resolver;
}

describe("batched @ArcheTypeFunction", () => {
    test("N parents call the method once and keep per-parent values", async () => {
        BatchFnArch.calls = [];
        const parents = [new Entity("aa"), new Entity("bbb"), new Entity("c")];
        const ctx = context();
        const values = await Promise.all(parents.map((parent) => resolver("total")(parent, {}, ctx)));
        expect(BatchFnArch.calls).toHaveLength(1);
        expect(BatchFnArch.calls[0]?.size).toBe(3);
        expect(BatchFnArch.calls[0]?.ids.sort()).toEqual(["aa", "bbb", "c"]);
        expect(BatchFnArch.calls[0]?.receiver).toBeInstanceOf(BatchFnArch);
        expect(values).toEqual([2, 3, 1]);
    });

    test("different args batch separately", async () => {
        BatchFnArch.calls = [];
        const ctx = context();
        const total = resolver("total");
        await Promise.all([
            total(new Entity("aa"), { since: "2020" }, ctx),
            total(new Entity("bbb"), { since: "2020" }, ctx),
            total(new Entity("c"), { since: "2021" }, ctx),
        ]);
        expect(BatchFnArch.calls).toHaveLength(2);
        const bySince = new Map(BatchFnArch.calls.map((call) => [call.since, call.size]));
        expect(bySince.get("2020")).toBe(2);
        expect(bySince.get("2021")).toBe(1);
    });

    test("non-batch functions still run once per parent", async () => {
        BatchFnArch.perRow = 0;
        const parents = [new Entity("aa"), new Entity("bbb"), new Entity("c")];
        const ctx = context();
        const values = await Promise.all(parents.map((parent) => resolver("each")(parent, {}, ctx)));
        expect(BatchFnArch.perRow).toBe(3);
        expect(values).toEqual([2, 3, 1]);
    });

    test("a rejected batch fails every parent in that batch", async () => {
        const parents = [new Entity("aa"), new Entity("bbb")];
        const ctx = context();
        const boom = resolver("boom");
        await expect(Promise.all(parents.map((parent) => boom(parent, {}, ctx)))).rejects.toThrow(/batch failed/);
    });

    test("a missing map key resolves null", async () => {
        const parents = [new Entity("aa"), new Entity("bbb")];
        const ctx = context();
        const values = await Promise.all(parents.map((parent) => resolver("partial")(parent, {}, ctx)));
        expect(values[0]).toBe(7);
        expect(values[1]).toBeNull();
    });


    test("a non-null batch miss is an error for that parent", () => {
        expect(rejectBatchMiss(true, "Order", "count", "e1")).toBeNull();
        const err = rejectBatchMiss(false, "Order", "count", "e1");
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toContain("non-null");
        expect(err?.message).toContain("e1");
    });
    test("batch and non-batch emit the same field signature", () => {
        const sdl = weaveAllArchetypes() ?? "";
        const lines = sdl.split("\n");
        const batched = lines.find((line) => line.includes("total(") || /\btotal:/.test(line));
        const plain = lines.find((line) => line.includes("each(") || /\beach:/.test(line));
        expect(batched).toBeDefined();
        expect(plain).toBeDefined();
        expect(batched!.replace("total", "FIELD")).toBe(plain!.replace("each", "FIELD"));
    });
});
