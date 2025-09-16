import type { Plugin } from 'graphql-yoga';
import { createRequestLoaders } from './RequestLoaders';
import type { RequestLoaders } from './RequestLoaders';
import db from '../database';

declare module 'graphql-yoga' {
  interface Context {
    locals: {
      loaders: RequestLoaders;
      requestId: string;
    };
  }
}

export function createRequestContextPlugin(): Plugin {
  return {
    onExecute: ({ args }) => {
      (args as any).contextValue.locals = {
        loaders: createRequestLoaders(db),
        requestId: crypto.randomUUID(),
      };
    },
  };
}