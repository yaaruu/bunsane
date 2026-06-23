/**
 * InProcessLockBackend — single-process mutual exclusion via an in-memory Map.
 *
 * Correct for single-instance deployments and as a faithful test double:
 * unlike the old `enabled:false` no-op (which pretended every acquire
 * succeeded and so never exercised contention), this backend genuinely refuses
 * a second holder of the same key and honours lease expiry. Two backend
 * *instances* sharing one process do NOT share state — construct one per
 * process and share it (this is what the singleton wiring does).
 *
 * It provides no cross-process exclusion. Use {@link PostgresLeaseLockBackend}
 * or {@link RedisLockBackend} for multi-instance deployments.
 */

import { randomUUID } from "crypto";
import type { AcquireOptions, LockBackend, LockHandle } from "./LockBackend";

const DEFAULT_TTL_MS = 30_000;

interface Lease {
    token: string;
    expiresAt: number; // Date.now() scale
}

export class InProcessLockBackend implements LockBackend {
    readonly name = "in-process";
    private readonly leases = new Map<string, Lease>();

    private now(): number {
        // Date.now is fine in normal runtime code (forbidden only in workflow
        // scripts). Centralised so tests can stub if needed.
        return Date.now();
    }

    private isLive(lease: Lease | undefined): lease is Lease {
        return !!lease && lease.expiresAt > this.now();
    }

    async acquire(key: string, opts?: AcquireOptions): Promise<LockHandle | null> {
        const existing = this.leases.get(key);
        if (this.isLive(existing)) {
            return null; // someone else holds a live lease
        }
        // No live holder (free, or the prior lease lapsed → steal it).
        const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
        const token = randomUUID();
        const expiresAt = this.now() + ttlMs;
        this.leases.set(key, { token, expiresAt });
        return { key, token, expiresAt };
    }

    async renew(handle: LockHandle, ttlMs: number): Promise<boolean> {
        const lease = this.leases.get(handle.key);
        // Only the current owner may renew; a lapsed-and-stolen lease fails.
        if (!this.isLive(lease) || lease.token !== handle.token) {
            return false;
        }
        lease.expiresAt = this.now() + ttlMs;
        return true;
    }

    async release(handle: LockHandle): Promise<boolean> {
        const lease = this.leases.get(handle.key);
        if (!lease || lease.token !== handle.token) {
            // Already gone, or we lost ownership (lapsed + restolen). The latter
            // is the "stranded lease" signal.
            return false;
        }
        this.leases.delete(handle.key);
        return true;
    }

    async dispose(): Promise<void> {
        this.leases.clear();
    }

    /** Test helper: number of live leases currently held. */
    liveCount(): number {
        let n = 0;
        for (const lease of this.leases.values()) {
            if (this.isLive(lease)) n++;
        }
        return n;
    }
}
