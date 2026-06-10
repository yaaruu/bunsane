import { type CacheProvider } from './CacheProvider';
import { logger } from '../Logger';

/**
 * Health check operations: ping and getStats.
 */

export async function getStats(provider: CacheProvider) {
    try {
        return await provider.getStats();
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Error getting cache stats', error });
        return {
            hits: 0,
            misses: 0,
            hitRate: 0,
            size: 0,
            memoryUsage: 0
        };
    }
}

export async function ping(provider: CacheProvider): Promise<boolean> {
    try {
        return await provider.ping();
    } catch (error) {
        logger.error({ scope: 'cache', component: 'CacheManager', msg: 'Cache ping failed', error });
        return false;
    }
}
