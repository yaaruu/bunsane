export type { CacheProvider, CacheStats } from './CacheProvider';
export { MemoryCache } from './MemoryCache';
export type { MemoryCacheConfig } from './MemoryCache';
export { NoOpCache } from './NoOpCache';
export { CacheManager } from './CacheManager';
export { CacheFactory } from './CacheFactory';
export {
    transaction,
    markDirty as txMarkDirty,
    registerOnCommit as txOnCommit,
    trackComponentDirty,
    beginTxTracking,
    flushTxTracking,
} from './txInvalidation';
export type { TxContext } from './txInvalidation';