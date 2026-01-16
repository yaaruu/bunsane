import type { Plugin } from 'graphql-yoga';
import { createRequestLoaders } from './RequestLoaders';
import type { RequestLoaders } from './RequestLoaders';
import db from '../database';
import { CacheManager } from './cache/CacheManager';

declare module 'graphql-yoga' {
  interface Context {
    locals: {
      loaders: RequestLoaders;
      requestId: string;
      cacheManager: CacheManager;
    };
  }
}

export function createRequestContextPlugin(): Plugin {
  return {
    onExecute: ({ args }) => {
      const cacheManager = CacheManager.getInstance();
      (args as any).contextValue.locals = {
        loaders: createRequestLoaders(db, cacheManager),
        requestId: crypto.randomUUID(),
        cacheManager: cacheManager,
      };
    },
  };
}