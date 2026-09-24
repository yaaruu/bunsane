import { describe, test, expect, afterEach, spyOn } from "bun:test";
import type { LifecycleEvent } from "../../../core/events/EntityLifecycleEvents";
import {
    createRegistryState,
    registerEntityHook,
    removeHook,
    clearAllHooks,
    type RegistryState,
} from "../../../core/hooks/registry";
import { createDispatcherState, executeHooks } from "../../../core/hooks/dispatcher";
import { getMetadataStorage } from "../../../core/metadata";

function eventOf(type: string, typeIds: string[] = []): LifecycleEvent {
    return {
        getEventType: () => type,
        getEntity: () => ({
            componentList: () => typeIds.map((id) => ({ getTypeID: () => id })),
        }),
    } as unknown as LifecycleEvent;
}

describe("hook dispatcher fast path", () => {
    let registry: RegistryState;
    const dispatcher = createDispatcherState();

    afterEach(() => {
        if (registry) clearAllHooks(registry);
    });

    test("no-hook events return before performance.now", async () => {
        registry = createRegistryState();
        const now = spyOn(performance, "now");
        try {
            await executeHooks(registry, dispatcher, eventOf("entity.created"));
            expect(now).not.toHaveBeenCalled();
        } finally {
            now.mockRestore();
        }
    });

    test("removed last hook restores the no-hook fast path", async () => {
        registry = createRegistryState();
        const id = registerEntityHook(registry, "entity.created", () => {}, {});
        removeHook(registry, id);
        const now = spyOn(performance, "now");
        try {
            await executeHooks(registry, dispatcher, eventOf("entity.created"));
            expect(now).not.toHaveBeenCalled();
        } finally {
            now.mockRestore();
        }
    });

    test("async:true hooks are not awaited on the execute path", async () => {
        registry = createRegistryState();
        const order: string[] = [];
        let releaseAsync: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseAsync = resolve;
        });
        let asyncDone = false;
        registerEntityHook(registry, "entity.created", () => {
            order.push("sync");
        }, {});
        registerEntityHook(registry, "entity.created", async () => {
            order.push("async-start");
            await gate;
            asyncDone = true;
        }, { async: true });

        await executeHooks(registry, dispatcher, eventOf("entity.created"));
        // Sync ran inline. executeHooks resolved while the async hook was still
        // blocked on `gate`, so it was not awaited on the save path.
        expect(order[0]).toBe("sync");
        expect(asyncDone).toBe(false);

        releaseAsync();
        await gate;
        await Promise.resolve();
        expect(asyncDone).toBe(true);
    });

    test("sync hooks that return a promise are still awaited", async () => {
        registry = createRegistryState();
        let releaseSync: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseSync = resolve;
        });
        let finished = false;
        registerEntityHook(registry, "entity.created", async () => {
            await gate;
            finished = true;
        }, { async: false });

        let resolved = false;
        const pending = executeHooks(registry, dispatcher, eventOf("entity.created")).then(() => {
            resolved = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(finished).toBe(false);

        releaseSync();
        await pending;
        expect(finished).toBe(true);
    });

    test("component-target type ids are applied from registration, not rebuilt per event", async () => {
        registry = createRegistryState();
        class NeedsTag {}
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId("NeedsTag");
        let calls = 0;
        const original = storage.getComponentId.bind(storage);
        storage.getComponentId = (name: string) => {
            calls++;
            return original(name);
        };
        try {
            let ran = false;
            registerEntityHook(registry, "entity.created", () => {
                ran = true;
            }, {
                componentTarget: { includeComponents: [NeedsTag as new () => never] },
            });
            calls = 0;

            await executeHooks(registry, dispatcher, eventOf("entity.created", []));
            expect(ran).toBe(false);
            expect(calls).toBe(0);

            await executeHooks(registry, dispatcher, eventOf("entity.created", [typeId]));
            expect(ran).toBe(true);
            expect(calls).toBe(0);
        } finally {
            storage.getComponentId = original;
        }
    });
});
