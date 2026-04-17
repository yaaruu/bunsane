import { describe, test, expect } from "bun:test";
import { MockRedisStreamServer } from "../../helpers/MockRedisStreamServer";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MockRedisStreamServer", () => {
    test("xadd + xlen + xrange basics", () => {
        const s = new MockRedisStreamServer();
        const id1 = s.xadd("k", "*", "data", "v1");
        const id2 = s.xadd("k", "*", "data", "v2");
        expect(s.xlen("k")).toBe(2);
        const r = s.xrange("k", "-", "+");
        expect(r.length).toBe(2);
        expect(r[0][0]).toBe(id1);
        expect(r[1][0]).toBe(id2);
    });

    test("xgroup CREATE MKSTREAM + xreadgroup with > delivers entries", async () => {
        const s = new MockRedisStreamServer();
        s.xgroup("CREATE", "k", "g", "$", "MKSTREAM");
        s.xadd("k", "*", "data", "v1");
        const r: any = await s.xreadgroup(
            "GROUP", "g", "c1",
            "COUNT", 10,
            "BLOCK", 50,
            "STREAMS", "k", ">"
        );
        expect(r).not.toBeNull();
        expect(r[0][0]).toBe("k");
        expect(r[0][1][0][1]).toEqual(["data", "v1"]);
    });

    test("xack removes from PEL", async () => {
        const s = new MockRedisStreamServer();
        s.xgroup("CREATE", "k", "g", "$", "MKSTREAM");
        s.xadd("k", "*", "data", "v1");
        const r: any = await s.xreadgroup(
            "GROUP", "g", "c1",
            "COUNT", 10,
            "BLOCK", 50,
            "STREAMS", "k", ">"
        );
        const msgId = r[0][1][0][0];
        expect(s.getPelSize("k", "g")).toBe(1);
        s.xack("k", "g", msgId);
        expect(s.getPelSize("k", "g")).toBe(0);
    });

    test("xautoclaim claims PEL entries past idle, increments deliveryCount", async () => {
        const s = new MockRedisStreamServer();
        s.xgroup("CREATE", "k", "g", "$", "MKSTREAM");
        s.xadd("k", "*", "data", "v1");
        await s.xreadgroup(
            "GROUP", "g", "c1",
            "COUNT", 10,
            "BLOCK", 50,
            "STREAMS", "k", ">"
        );
        await wait(20);
        const result: any = s.xautoclaim("k", "g", "c2", 1, "0-0");
        expect(result[0]).toBe("0-0");
        expect(result[1]).toHaveLength(1);

        const pending: any = s.xpending("k", "g", "-", "+", 100);
        expect(pending.length).toBe(1);
        expect(pending[0][1]).toBe("c2");
        expect(pending[0][3]).toBe(2);
    });

    test("xpending detail form returns delivery count", async () => {
        const s = new MockRedisStreamServer();
        s.xgroup("CREATE", "k", "g", "$", "MKSTREAM");
        s.xadd("k", "*", "data", "v1");
        const r: any = await s.xreadgroup(
            "GROUP", "g", "c1",
            "COUNT", 10,
            "BLOCK", 50,
            "STREAMS", "k", ">"
        );
        const msgId = r[0][1][0][0];
        const detail: any = s.xpending("k", "g", msgId, msgId, 1);
        expect(detail[0][0]).toBe(msgId);
        expect(detail[0][3]).toBe(1);
    });

    test("MAXLEN trims old entries", () => {
        const s = new MockRedisStreamServer();
        for (let i = 0; i < 5; i++) {
            s.xadd("k", "MAXLEN", "~", 2, "*", "data", `v${i}`);
        }
        expect(s.xlen("k")).toBe(2);
    });

    test("xread with $ blocks until new entry", async () => {
        const s = new MockRedisStreamServer();
        s.xadd("k", "*", "data", "before");
        const readPromise = s.xread("COUNT", 10, "BLOCK", 200, "STREAMS", "k", "$");
        await wait(30);
        s.xadd("k", "*", "data", "after");
        const r: any = await readPromise;
        expect(r).not.toBeNull();
        expect(r[0][1][0][1]).toEqual(["data", "after"]);
    });
});
