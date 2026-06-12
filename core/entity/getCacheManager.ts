// Static import of CacheManager for hot-path use in componentAccess and
// cacheStrategies. CacheManager's imports are all type-only references back
// to core/Entity, so there is no runtime circular dependency — static import
// is safe and avoids the microtask + Promise allocation of a dynamic import
// on every set/remove/save/delete call.
import { CacheManager } from '../cache/CacheManager';

export function getCacheManager(): typeof CacheManager {
    return CacheManager;
}
