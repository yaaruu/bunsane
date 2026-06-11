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

/**
 * Setup pub/sub for cross-instance cache invalidation.
 * Only activates when using MultiLevel provider with a Redis L2.
 * Returns true if pub/sub was successfully enabled.
 */
export async function setupPubSub(
    provider: CacheProvider,
    instanceId: string,
    handleRemoteInvalidation: (raw: string) => Promise<void>
): Promise<boolean> {
    if (!(provider instanceof MultiLevelCache)) return false;

    const l2 = provider.getL2Cache();
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
 * Ignores messages from self. Invalidates L1 only (L2 is shared Redis).
 */
export async function handleRemoteInvalidation(
    provider: CacheProvider,
    instanceId: string,
    raw: string
): Promise<void> {
    try {
        const msg: InvalidationMessage = JSON.parse(raw);

        // Ignore our own messages
        if (msg.instanceId === instanceId) return;

        if (!(provider instanceof MultiLevelCache)) return;
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

    const l2 = provider.getL2Cache();
    if (!(l2 instanceof RedisCache)) return;

    try {
        const msg: InvalidationMessage = { instanceId, type, keys, pattern };
        await l2.publishInvalidation(INVALIDATION_CHANNEL, JSON.stringify(msg));
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error publishing invalidation', error });
    }
}
