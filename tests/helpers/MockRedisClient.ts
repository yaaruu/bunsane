/**
 * ioredis-shaped client backed by a MockRedisStreamServer.
 *
 * Cast the returned instance to `Redis` (from "ioredis") when passing into
 * the remote subsystem via `redisFactory`. Only methods the remote layer
 * touches are implemented; others throw on use.
 */

import type { MockRedisStreamServer } from "./MockRedisStreamServer";

export class MockRedisClient {
    private server: MockRedisStreamServer;
    private connected = true;
    private listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(server: MockRedisStreamServer) {
        this.server = server;
    }

    on(event: string, listener: (...args: any[]) => void): this {
        const arr = this.listeners.get(event) ?? [];
        arr.push(listener);
        this.listeners.set(event, arr);
        return this;
    }

    async xadd(key: string, ...args: any[]): Promise<string | null> {
        this.ensureConnected();
        try {
            return this.server.xadd(key, ...args);
        } catch (err: any) {
            throw err;
        }
    }

    async xgroup(...args: any[]): Promise<string> {
        this.ensureConnected();
        const [op, key, group, id, mk] = args;
        return this.server.xgroup(op, key, group, id, mk);
    }

    async xreadgroup(...args: any[]): Promise<any> {
        this.ensureConnected();
        return this.server.xreadgroup(...args);
    }

    async xread(...args: any[]): Promise<any> {
        this.ensureConnected();
        return this.server.xread(...args);
    }

    async xack(key: string, group: string, msgId: string): Promise<number> {
        this.ensureConnected();
        return this.server.xack(key, group, msgId);
    }

    async xpending(...args: any[]): Promise<any> {
        this.ensureConnected();
        const [key, group, ...rest] = args;
        return this.server.xpending(key, group, ...rest);
    }

    async xautoclaim(...args: any[]): Promise<any> {
        this.ensureConnected();
        return this.server.xautoclaim(
            args[0],
            args[1],
            args[2],
            Number(args[3]),
            args[4],
            ...args.slice(5)
        );
    }

    async xlen(key: string): Promise<number> {
        this.ensureConnected();
        return this.server.xlen(key);
    }

    async xrange(...args: any[]): Promise<any> {
        this.ensureConnected();
        return this.server.xrange(
            args[0],
            args[1],
            args[2],
            ...args.slice(3)
        );
    }

    async ping(): Promise<string> {
        this.ensureConnected();
        return this.server.ping();
    }

    disconnect(): void {
        this.connected = false;
    }

    async quit(): Promise<string> {
        this.connected = false;
        return "OK";
    }

    private ensureConnected(): void {
        if (!this.connected) {
            throw new Error("Connection is closed");
        }
    }
}

export function createMockRedisFactory(server: MockRedisStreamServer) {
    return (_blocking: boolean) => new MockRedisClient(server);
}
