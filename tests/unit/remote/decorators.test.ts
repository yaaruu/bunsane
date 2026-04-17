import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    RemoteEvent,
    RemoteRpc,
    registerRemoteHandlers,
} from "../../../core/remote/decorators";
import {
    setRemoteManager,
    getRemoteManager,
} from "../../../core/remote/RemoteManager";
import type { RemoteHandler, RpcHandler } from "../../../core/remote/types";

describe("@RemoteEvent + @RemoteRpc decorators", () => {
    test("RemoteEvent stores handler metadata on constructor", () => {
        class S {
            @RemoteEvent({ event: "foo.bar" })
            handleFooBar() {}
        }
        const meta = (S as any).__remoteHandlers;
        expect(meta).toHaveLength(1);
        expect(meta[0]).toMatchObject({
            event: "foo.bar",
            methodName: "handleFooBar",
            kind: "event",
        });
        expect(meta[0].handlerId).toBe("S.handleFooBar");
    });

    test("RemoteRpc stores handler metadata with rpc_request kind", () => {
        class R {
            @RemoteRpc({ event: "order.get" })
            getOrder() {
                return { id: "x" };
            }
        }
        const meta = (R as any).__remoteHandlers;
        expect(meta).toHaveLength(1);
        expect(meta[0].kind).toBe("rpc_request");
        expect(meta[0].event).toBe("order.get");
    });

    test("custom id overrides default", () => {
        class S {
            @RemoteEvent({ event: "a", id: "custom-id" })
            h() {}
        }
        const meta = (S as any).__remoteHandlers;
        expect(meta[0].handlerId).toBe("custom-id");
    });

    test("duplicate handler id on same class is skipped", () => {
        class S {
            @RemoteEvent({ event: "a", id: "dup" })
            h1() {}
            @RemoteEvent({ event: "b", id: "dup" })
            h2() {}
        }
        const meta = (S as any).__remoteHandlers;
        expect(meta).toHaveLength(1);
        expect(meta[0].event).toBe("a"); // first wins
    });

    test("mixed RemoteEvent + RemoteRpc coexist on one class", () => {
        class S {
            @RemoteEvent({ event: "e1" })
            onE1() {}
            @RemoteRpc({ event: "r1" })
            handleR1() {
                return 1;
            }
        }
        const meta = (S as any).__remoteHandlers;
        expect(meta).toHaveLength(2);
        expect(meta.map((m: any) => m.kind).sort()).toEqual([
            "event",
            "rpc_request",
        ]);
    });

    test("metadata is isolated per class constructor", () => {
        class A {
            @RemoteEvent({ event: "a.evt" })
            h() {}
        }
        class B {
            @RemoteEvent({ event: "b.evt" })
            h() {}
        }
        expect((A as any).__remoteHandlers).toHaveLength(1);
        expect((B as any).__remoteHandlers).toHaveLength(1);
        expect((A as any).__remoteHandlers[0].event).toBe("a.evt");
        expect((B as any).__remoteHandlers[0].event).toBe("b.evt");
    });
});

describe("registerRemoteHandlers", () => {
    beforeEach(() => {
        setRemoteManager(null);
    });

    afterEach(() => {
        setRemoteManager(null);
    });

    test("no-op when service has no decorated handlers", () => {
        class S {}
        // Should not throw, should not touch manager
        registerRemoteHandlers(new S());
        expect(getRemoteManager()).toBeNull();
    });

    test("skips registration when manager is not initialized", () => {
        class S {
            @RemoteEvent({ event: "x" })
            h() {}
        }
        // No manager set — should warn but not throw
        expect(() => registerRemoteHandlers(new S())).not.toThrow();
    });

    test("routes event handlers to manager.on()", () => {
        const calls: Array<{
            event: string;
            handlerId: string;
            kind: "event" | "rpc";
        }> = [];
        const mockManager = {
            on(event: string, _fn: RemoteHandler, handlerId: string) {
                calls.push({ event, handlerId, kind: "event" });
            },
            onRpc(event: string, _fn: RpcHandler, handlerId: string) {
                calls.push({ event, handlerId, kind: "rpc" });
            },
        } as any;
        setRemoteManager(mockManager);

        class S {
            @RemoteEvent({ event: "e1" })
            ehandler() {}
            @RemoteRpc({ event: "r1" })
            rhandler() {
                return 1;
            }
        }

        registerRemoteHandlers(new S());

        expect(calls).toHaveLength(2);
        expect(calls.find((c) => c.event === "e1")?.kind).toBe("event");
        expect(calls.find((c) => c.event === "r1")?.kind).toBe("rpc");
    });

    test("handler bound to service instance", async () => {
        let receivedThis: any = null;
        const mockManager = {
            on(_event: string, fn: RemoteHandler, _id: string) {
                // Invoke right away to verify binding
                fn({} as any, {} as any);
            },
            onRpc() {},
        } as any;
        setRemoteManager(mockManager);

        class S {
            tag = "instance-tag";
            @RemoteEvent({ event: "e1" })
            handler() {
                receivedThis = this.tag;
            }
        }

        registerRemoteHandlers(new S());
        // Give microtask for any await inside handler to settle
        await Promise.resolve();
        expect(receivedThis).toBe("instance-tag");
    });

    test("missing method on instance is skipped (no throw)", () => {
        const mockManager = { on() {}, onRpc() {} } as any;
        setRemoteManager(mockManager);

        class S {}
        // Inject fake metadata referencing a non-existent method
        (S as any).__remoteHandlers = [
            {
                event: "e1",
                methodName: "doesNotExist",
                handlerId: "S.doesNotExist",
                kind: "event",
            },
        ];

        expect(() => registerRemoteHandlers(new S())).not.toThrow();
    });
});
