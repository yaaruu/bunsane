/**
 * In-memory Redis Streams shim for Tier 2 integration tests.
 *
 * Implements only the commands the remote subsystem issues:
 *   xadd, xreadgroup, xread, xack, xgroup CREATE, xpending,
 *   xautoclaim, xlen, xrange, ping
 *
 * Shared server: multiple MockRedisClient instances pointing at the same
 * server simulate separate app processes talking to one Redis.
 */

interface StreamEntry {
    id: string;
    fields: string[]; // flat [k,v,k,v,...]
}

interface PelEntry {
    msgId: string;
    consumer: string;
    deliveredAt: number;
    deliveryCount: number;
}

interface ConsumerGroup {
    name: string;
    consumers: Set<string>;
    pel: Map<string, PelEntry>;
    /** Highest ID delivered via ">" — next read starts after this. */
    lastDeliveredId: string;
}

interface Stream {
    key: string;
    entries: StreamEntry[];
    groups: Map<string, ConsumerGroup>;
    lastGeneratedTs: number;
    seqWithinMs: number;
}

const MIN_ID = "0-0";

function parseId(id: string): [number, number] {
    const dash = id.indexOf("-");
    if (dash < 0) return [Number(id), 0];
    return [Number(id.slice(0, dash)), Number(id.slice(dash + 1))];
}

function idLess(a: string, b: string): boolean {
    const [at, as] = parseId(a);
    const [bt, bs] = parseId(b);
    if (at !== bt) return at < bt;
    return as < bs;
}

function idGreater(a: string, b: string): boolean {
    const [at, as] = parseId(a);
    const [bt, bs] = parseId(b);
    if (at !== bt) return at > bt;
    return as > bs;
}

export class MockRedisStreamServer {
    private streams = new Map<string, Stream>();
    /** Fault injection for tests that need to simulate XADD failures. */
    public xaddShouldFail = false;

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    private getOrCreateStream(key: string): Stream {
        let s = this.streams.get(key);
        if (!s) {
            s = {
                key,
                entries: [],
                groups: new Map(),
                lastGeneratedTs: 0,
                seqWithinMs: 0,
            };
            this.streams.set(key, s);
        }
        return s;
    }

    private generateId(stream: Stream): string {
        const now = Date.now();
        if (now === stream.lastGeneratedTs) {
            stream.seqWithinMs++;
        } else {
            stream.lastGeneratedTs = now;
            stream.seqWithinMs = 0;
        }
        return `${now}-${stream.seqWithinMs}`;
    }

    /**
     * XADD key [MAXLEN [~] N] * field value [field value ...]
     * Returns the generated id.
     */
    xadd(key: string, ...args: any[]): string {
        if (this.xaddShouldFail) {
            throw new Error("MOCK_XADD_FAIL");
        }
        const stream = this.getOrCreateStream(key);

        // Parse leading options
        let i = 0;
        let maxLen: number | null = null;
        if (args[i] === "MAXLEN") {
            i++;
            if (args[i] === "~" || args[i] === "=") i++;
            maxLen = Number(args[i]);
            i++;
        }

        // Expect "*"
        if (args[i] !== "*") {
            throw new Error(`MockRedis xadd: only "*" auto-id supported, got ${args[i]}`);
        }
        i++;

        const fields: string[] = [];
        for (; i < args.length; i++) {
            fields.push(String(args[i]));
        }

        const id = this.generateId(stream);
        stream.entries.push({ id, fields });

        if (maxLen !== null && stream.entries.length > maxLen) {
            stream.entries.splice(0, stream.entries.length - maxLen);
        }

        return id;
    }

    /**
     * XGROUP CREATE stream group id [MKSTREAM]
     * id "$" = start from latest, "0" / "0-0" = start from beginning.
     */
    xgroup(op: string, key: string, groupName: string, startId: string, mkstream?: string): string {
        if (op !== "CREATE") {
            throw new Error(`MockRedis xgroup: op "${op}" not supported`);
        }
        const hasStream = this.streams.has(key);
        if (!hasStream && mkstream !== "MKSTREAM") {
            throw new Error("ERR no such key");
        }
        const stream = this.getOrCreateStream(key);
        if (stream.groups.has(groupName)) {
            const err = new Error(
                `BUSYGROUP Consumer Group name already exists`
            );
            throw err;
        }
        const lastDeliveredId =
            startId === "$"
                ? stream.entries.length > 0
                    ? stream.entries[stream.entries.length - 1]!.id
                    : MIN_ID
                : startId === "0" || startId === "0-0"
                  ? MIN_ID
                  : startId;
        stream.groups.set(groupName, {
            name: groupName,
            consumers: new Set(),
            pel: new Map(),
            lastDeliveredId,
        });
        return "OK";
    }

    /**
     * XREADGROUP GROUP g consumer [COUNT n] [BLOCK ms] STREAMS s ">"
     * Returns [[streamKey, [[id, fields], ...]]] or null on timeout.
     */
    async xreadgroup(...args: any[]): Promise<any> {
        let i = 0;
        if (args[i] !== "GROUP") throw new Error("expected GROUP");
        i++;
        const groupName = String(args[i++]);
        const consumer = String(args[i++]);
        let count = Infinity;
        let blockMs = 0;
        while (args[i] !== "STREAMS") {
            const opt = String(args[i++]).toUpperCase();
            if (opt === "COUNT") count = Number(args[i++]);
            else if (opt === "BLOCK") blockMs = Number(args[i++]);
            else throw new Error(`unknown XREADGROUP opt ${opt}`);
        }
        i++; // skip STREAMS
        const streams: string[] = [];
        const ids: string[] = [];
        const remaining = args.slice(i);
        const half = remaining.length / 2;
        for (let k = 0; k < half; k++) {
            streams.push(String(remaining[k]));
            ids.push(String(remaining[k + half]));
        }

        const deadline = Date.now() + blockMs;
        while (true) {
            const result = this.readGroupOnce(groupName, consumer, count, streams, ids);
            if (result) return result;
            if (Date.now() >= deadline) return null;
            await this.sleep(10);
        }
    }

    private readGroupOnce(
        groupName: string,
        consumer: string,
        count: number,
        streams: string[],
        ids: string[]
    ): any[] | null {
        const out: any[] = [];
        for (let s = 0; s < streams.length; s++) {
            const streamKey = streams[s]!;
            const id = ids[s]!;
            const stream = this.streams.get(streamKey);
            if (!stream) continue;
            const group = stream.groups.get(groupName);
            if (!group) continue;
            group.consumers.add(consumer);

            let newEntries: StreamEntry[];
            if (id === ">") {
                // New messages only
                newEntries = stream.entries.filter((e) =>
                    idGreater(e.id, group.lastDeliveredId)
                );
                if (newEntries.length > count) {
                    newEntries = newEntries.slice(0, count);
                }
                for (const entry of newEntries) {
                    group.lastDeliveredId = entry.id;
                    const existing = group.pel.get(entry.id);
                    if (existing) {
                        existing.deliveryCount++;
                        existing.deliveredAt = Date.now();
                        existing.consumer = consumer;
                    } else {
                        group.pel.set(entry.id, {
                            msgId: entry.id,
                            consumer,
                            deliveredAt: Date.now(),
                            deliveryCount: 1,
                        });
                    }
                }
            } else {
                // Re-read this consumer's PEL
                newEntries = stream.entries.filter((e) => {
                    const p = group.pel.get(e.id);
                    return p && p.consumer === consumer && idGreater(e.id, id);
                });
                if (newEntries.length > count) {
                    newEntries = newEntries.slice(0, count);
                }
            }

            if (newEntries.length > 0) {
                out.push([
                    streamKey,
                    newEntries.map((e) => [e.id, e.fields]),
                ]);
            }
        }
        return out.length > 0 ? out : null;
    }

    /**
     * XREAD [COUNT n] [BLOCK ms] STREAMS s id
     */
    async xread(...args: any[]): Promise<any> {
        let i = 0;
        let count = Infinity;
        let blockMs = 0;
        while (args[i] !== "STREAMS") {
            const opt = String(args[i++]).toUpperCase();
            if (opt === "COUNT") count = Number(args[i++]);
            else if (opt === "BLOCK") blockMs = Number(args[i++]);
            else throw new Error(`unknown XREAD opt ${opt}`);
        }
        i++;
        const remaining = args.slice(i);
        const half = remaining.length / 2;
        const streams: string[] = [];
        const ids: string[] = [];
        for (let k = 0; k < half; k++) {
            streams.push(String(remaining[k]));
            ids.push(String(remaining[k + half]));
        }

        // Resolve "$" to the current last id per stream once, up front.
        // Subsequent polls compare against that snapshot so new entries get
        // delivered exactly once.
        const resolvedIds = ids.map((id, k) => {
            if (id !== "$") return id;
            const stream = this.streams.get(streams[k]!);
            if (!stream || stream.entries.length === 0) return MIN_ID;
            return stream.entries[stream.entries.length - 1]!.id;
        });

        const deadline = Date.now() + blockMs;
        while (true) {
            const out: any[] = [];
            for (let s = 0; s < streams.length; s++) {
                const streamKey = streams[s]!;
                const afterId = resolvedIds[s]!;
                const stream = this.streams.get(streamKey);
                if (!stream) continue;
                const matching = stream.entries
                    .filter((e) => idGreater(e.id, afterId))
                    .slice(0, count);
                if (matching.length > 0) {
                    out.push([
                        streamKey,
                        matching.map((e) => [e.id, e.fields]),
                    ]);
                }
            }
            if (out.length > 0) return out;
            if (Date.now() >= deadline) return null;
            await this.sleep(10);
        }
    }

    xack(key: string, groupName: string, msgId: string): number {
        const stream = this.streams.get(key);
        if (!stream) return 0;
        const group = stream.groups.get(groupName);
        if (!group) return 0;
        return group.pel.delete(msgId) ? 1 : 0;
    }

    /**
     * Two forms:
     *   XPENDING key group                              -> summary
     *   XPENDING key group minId maxId count [consumer] -> detail
     */
    xpending(key: string, groupName: string, ...args: any[]): any {
        const stream = this.streams.get(key);
        if (!stream) return [0, null, null, null];
        const group = stream.groups.get(groupName);
        if (!group) return [0, null, null, null];

        if (args.length === 0) {
            // Summary
            const ids = Array.from(group.pel.keys()).sort((a, b) =>
                idLess(a, b) ? -1 : idGreater(a, b) ? 1 : 0
            );
            if (ids.length === 0) return [0, null, null, null];
            const byConsumer = new Map<string, number>();
            for (const p of group.pel.values()) {
                byConsumer.set(
                    p.consumer,
                    (byConsumer.get(p.consumer) ?? 0) + 1
                );
            }
            return [
                ids.length,
                ids[0],
                ids[ids.length - 1],
                Array.from(byConsumer.entries()).map(([c, n]) => [c, String(n)]),
            ];
        }

        const [minId, maxId, _count] = args;
        const out: any[] = [];
        for (const p of group.pel.values()) {
            if (idLess(p.msgId, minId) || idGreater(p.msgId, maxId)) continue;
            out.push([
                p.msgId,
                p.consumer,
                Date.now() - p.deliveredAt,
                p.deliveryCount,
            ]);
        }
        return out;
    }

    /**
     * XAUTOCLAIM stream group consumer idleMs cursor [COUNT n]
     * Returns [nextCursor, entries]
     */
    xautoclaim(
        key: string,
        groupName: string,
        consumer: string,
        idleMs: number,
        cursor: string,
        ..._rest: any[]
    ): any {
        const stream = this.streams.get(key);
        if (!stream) return ["0-0", []];
        const group = stream.groups.get(groupName);
        if (!group) return ["0-0", []];

        const now = Date.now();
        const claimed: any[] = [];
        for (const p of group.pel.values()) {
            if (now - p.deliveredAt < idleMs) continue;
            if (idLess(p.msgId, cursor) && cursor !== "0-0") continue;
            p.consumer = consumer;
            p.deliveryCount++;
            p.deliveredAt = now;
            const entry = stream.entries.find((e) => e.id === p.msgId);
            if (entry) claimed.push([entry.id, entry.fields]);
        }
        return ["0-0", claimed];
    }

    xlen(key: string): number {
        return this.streams.get(key)?.entries.length ?? 0;
    }

    xrange(key: string, start: string, end: string, ..._rest: any[]): any[] {
        const stream = this.streams.get(key);
        if (!stream) return [];
        const lo = start === "-" ? MIN_ID : start;
        const hi = end === "+" ? "9999999999999-9999" : end;
        return stream.entries
            .filter(
                (e) =>
                    !idLess(e.id, lo) && !idGreater(e.id, hi)
            )
            .map((e) => [e.id, e.fields]);
    }

    ping(): string {
        return "PONG";
    }

    /** Helper for tests: total PEL entries across a group. */
    getPelSize(streamKey: string, groupName: string): number {
        return (
            this.streams.get(streamKey)?.groups.get(groupName)?.pel.size ?? 0
        );
    }

    /** Helper for tests: raw stream entry count ignoring groups. */
    getStreamLength(key: string): number {
        return this.xlen(key);
    }
}
