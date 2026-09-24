import { createHmac, timingSafeEqual } from 'node:crypto';
import { type CacheProvider } from './CacheProvider';
import { MultiLevelCache } from './MultiLevelCache';
import { RedisCache } from './RedisCache';
import { logger } from '../Logger';

export interface InvalidationMessage {
    instanceId: string;
    type: 'key' | 'pattern';
    keys?: string[];
    pattern?: string;
}

const INVALIDATION_CHANNEL = 'bunsane:cache:invalidate';
const INVALIDATION_SKEW_MS = 30_000;

export function readInvalidationSecret(): string | undefined {
    const secret = process.env.BUNSANE_CACHE_INVALIDATION_SECRET;
    if (!secret || secret.trim() === '') return undefined;
    return secret;
}

/**
 * Pub/sub is optional. Without a shared secret a single-instance deploy
 * disables it (info log, no crash) rather than accepting unsigned wipes.
 * Auto-generating a per-process secret cannot be shared across instances,
 * so an unset secret does not invent one.
 */
export function invalidationPubSubDecision(hasRedisL2: boolean): 'disabled-no-redis' | 'disabled-no-secret' | 'enabled' {
    if (!hasRedisL2) return 'disabled-no-redis';
    if (!readInvalidationSecret()) return 'disabled-no-secret';
    return 'enabled';
}

type SignedBody = {
    instanceId: string;
    type: 'key' | 'pattern';
    keys: string[] | null;
    pattern: string | null;
    ts: number;
};

function canonicalBody(body: SignedBody): string {
    return JSON.stringify({
        instanceId: body.instanceId,
        type: body.type,
        keys: body.keys,
        pattern: body.pattern,
        ts: body.ts,
    });
}

function signBody(body: SignedBody, secret: string): string {
    return createHmac('sha256', secret).update(canonicalBody(body)).digest('hex');
}

function signaturesMatch(expectedHex: string, providedHex: string): boolean {
    const expected = Buffer.from(expectedHex, 'utf8');
    const provided = Buffer.from(providedHex, 'utf8');
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
}

export function encodeInvalidationMessage(msg: InvalidationMessage, secret: string, now = Date.now()): string {
    const body: SignedBody = {
        instanceId: msg.instanceId,
        type: msg.type,
        keys: msg.keys ?? null,
        pattern: msg.pattern ?? null,
        ts: now,
    };
    return JSON.stringify({ ...body, sig: signBody(body, secret) });
}

export type InvalidationVerifyResult =
    | { ok: true; msg: InvalidationMessage }
    | { ok: false; reason: 'unsigned' | 'tampered' | 'stale' | 'malformed' };

export function verifyInvalidationMessage(raw: string, secret: string, now = Date.now()): InvalidationVerifyResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed' };
    const record = parsed as Record<string, unknown>;
    if (typeof record.sig !== 'string' || typeof record.ts !== 'number' || typeof record.instanceId !== 'string') {
        return { ok: false, reason: 'unsigned' };
    }
    if (record.type !== 'key' && record.type !== 'pattern') return { ok: false, reason: 'malformed' };

    const keys = Array.isArray(record.keys) ? record.keys.filter((key): key is string => typeof key === 'string') : null;
    const pattern = typeof record.pattern === 'string' ? record.pattern : null;
    const body: SignedBody = {
        instanceId: record.instanceId,
        type: record.type,
        keys,
        pattern,
        ts: record.ts,
    };
    if (!signaturesMatch(signBody(body, secret), record.sig)) {
        return { ok: false, reason: 'tampered' };
    }
    if (Math.abs(now - record.ts) > INVALIDATION_SKEW_MS) {
        return { ok: false, reason: 'stale' };
    }
    return {
        ok: true,
        msg: {
            instanceId: body.instanceId,
            type: body.type,
            keys: keys ?? undefined,
            pattern: pattern ?? undefined,
        },
    };
}

/**
 * Setup pub/sub for cross-instance cache invalidation.
 * Only activates when using MultiLevel provider with a Redis L2 AND
 * `BUNSANE_CACHE_INVALIDATION_SECRET` is set. Returns true if pub/sub was enabled.
 */
export async function setupPubSub(
    provider: CacheProvider,
    instanceId: string,
    handleRemoteInvalidation: (raw: string) => Promise<void>
): Promise<boolean> {
    if (!(provider instanceof MultiLevelCache)) return false;

    const l2 = provider.getL2Cache();
    const decision = invalidationPubSubDecision(l2 instanceof RedisCache);
    if (decision === 'disabled-no-redis') return false;
    if (decision === 'disabled-no-secret') {
        logger.warn({
            scope: 'cache',
            component: 'CacheManager',
            msg: 'Cross-instance cache invalidation DISABLED: BUNSANE_CACHE_INVALIDATION_SECRET is unset. Multi-instance deployments will serve stale L1 entries until TTL; set the same secret on every instance. Unsigned invalidation is not accepted.',
            instanceId,
        });
        return false;
    }
    if (!(l2 instanceof RedisCache)) return false;

    try {
        await l2.subscribeInvalidation(
            INVALIDATION_CHANNEL,
            (_channel, message) => handleRemoteInvalidation(message)
        );
        logger.info({ scope: 'cache', component: 'CacheManager', msg: 'Cross-instance cache invalidation enabled', instanceId });
        return true;
    } catch (error) {
        logger.warn({ scope: 'cache', component: 'CacheManager', msg: 'Failed to setup pub/sub', error });
        return false;
    }
}

/**
 * Handle an invalidation message from another instance.
 * Drops unsigned, tampered, and stale messages. Ignores messages from self.
 * Invalidates L1 only (L2 is shared Redis).
 */
export async function handleRemoteInvalidation(
    provider: CacheProvider,
    instanceId: string,
    raw: string
): Promise<void> {
    const secret = readInvalidationSecret();
    if (!secret) {
        logger.warn({
            scope: 'cache',
            component: 'CacheManager',
            msg: 'Dropped cache invalidation message: BUNSANE_CACHE_INVALIDATION_SECRET is unset',
        });
        return;
    }

    const verified = verifyInvalidationMessage(raw, secret);
    if (!verified.ok) {
        logger.warn({
            scope: 'cache',
            component: 'CacheManager',
            msg: 'Dropped cache invalidation message',
            reason: verified.reason,
        });
        return;
    }

    const msg = verified.msg;
    if (msg.instanceId === instanceId) return;
    if (!(provider instanceof MultiLevelCache)) return;

    try {
        const l1 = provider.getL1Cache();
        if (msg.type === 'key' && msg.keys) {
            await l1.deleteMany(msg.keys);
        } else if (msg.type === 'pattern' && msg.pattern) {
            await l1.invalidatePattern(msg.pattern);
        }
        logger.debug({ scope: 'cache', component: 'CacheManager', msg: 'Applied remote invalidation', from: msg.instanceId, type: msg.type });
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error handling remote invalidation', error });
    }
}

/**
 * Publish an invalidation event to other instances via Redis pub/sub.
 * Unsigned messages are never published.
 */
export async function publishInvalidation(
    provider: CacheProvider,
    pubSubEnabled: boolean,
    instanceId: string,
    type: 'key' | 'pattern',
    keys?: string[],
    pattern?: string
): Promise<void> {
    if (!pubSubEnabled) return;
    if (!(provider instanceof MultiLevelCache)) return;

    const secret = readInvalidationSecret();
    if (!secret) return;

    const l2 = provider.getL2Cache();
    if (!(l2 instanceof RedisCache)) return;

    try {
        const raw = encodeInvalidationMessage({ instanceId, type, keys, pattern }, secret);
        await l2.publishInvalidation(INVALIDATION_CHANNEL, raw);
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error publishing invalidation', error });
    }
}
