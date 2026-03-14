import type { Plugin } from 'graphql-yoga';
import { createRequestLoaders } from './RequestLoaders';
import type { RequestLoaders } from './RequestLoaders';
import db from '../database';
import { CacheManager } from './cache/CacheManager';

declare module 'graphql-yoga' {
  interface Context {
    // Loaders mounted at top-level context for ArcheType resolver access
    loaders: RequestLoaders;
    requestId: string;
    cacheManager: CacheManager;
  }
}

/**
 * GraphQL Yoga plugin that creates per-request DataLoaders for batching.
 *
 * IMPORTANT: Loaders are mounted at context.loaders (NOT context.locals.loaders)
 * to match what ArcheType.ts resolvers expect. This enables DataLoader batching
 * for BelongsTo/HasMany relations, preventing N+1 queries.
 */
export function createRequestContextPlugin(): Plugin {
  return {
    onExecute: ({ args }) => {
      const cacheManager = CacheManager.getInstance();
      // Mount loaders at context.loaders to match ArcheType.ts resolver access pattern
      (args as any).contextValue.loaders = createRequestLoaders(db, cacheManager);
      (args as any).contextValue.requestId = crypto.randomUUID();
      (args as any).contextValue.cacheManager = cacheManager;
    },
  };
}