import type { Plugin } from 'graphql-yoga';
import { createRequestLoaders } from './RequestLoaders';
import type { RequestLoaders } from './RequestLoaders';
import db from '../database';
import { CacheManager } from './cache/CacheManager';
import { getRequestId } from './middleware/RequestId';
import { runWithRequestScope } from './requestScope';

export interface RequestStats {
  operationName: string;
  dataLoaderCalls: { entity: number; component: number; relation: number };
  dbQueryCount: number;
  startTime: number;
}

declare module 'graphql-yoga' {
  interface Context {
    // Loaders mounted at top-level context for ArcheType resolver access
    loaders: RequestLoaders;
    requestId: string;
    cacheManager: CacheManager;
    requestStats: RequestStats;
    signal?: AbortSignal;
  }
}

/**
 * GraphQL Yoga plugin that creates per-request DataLoaders for batching.
 *
 * IMPORTANT: Loaders are mounted at context.loaders (NOT context.locals.loaders)
 * to match what ArcheType.ts resolvers expect. This enables DataLoader batching
 * for BelongsTo/HasMany relations, preventing N+1 queries.
 *
 * Also threads the request `AbortSignal` into Query/DataLoader DB calls so
 * the framework's wall-clock timeout (handled in core/app/requestRouter.ts)
 * cancels in-flight Postgres queries via Bun's `Query.cancel()`. Without
 * this, an aborted request leaks its backend connection into
 * `idle in transaction` under pgbouncer transaction-mode pooling.
 *
 * Captures per-request stats (operationName, DataLoader call counts,
 * dbQueryCount) and attaches them to the underlying Request via
 * `__bunsaneStats` so the HTTP router's catch handler + AccessLog
 * middleware can read them after the GraphQL pipeline rejects.
 */
export function createRequestContextPlugin(): Plugin {
  return {
    onExecute: ({ args, executeFn, setExecuteFn }) => {
      const cacheManager = CacheManager.getInstance();
      const ctx: any = (args as any).contextValue;
      const request: Request | undefined = ctx?.request;
      const signal: AbortSignal | undefined = request?.signal;

      // GraphQL operation name. Falls back to first named operation in the
      // document, or 'anonymous' if the client supplied an inline query
      // with no name.
      const operationName: string =
        (typeof args.operationName === 'string' && args.operationName)
        || (args.document?.definitions?.find?.(
              (d: any) => d?.kind === 'OperationDefinition' && d?.name?.value,
           ) as any)?.name?.value
        || 'anonymous';

      const stats: RequestStats = {
        operationName,
        dataLoaderCalls: { entity: 0, component: 0, relation: 0 },
        dbQueryCount: 0,
        startTime: performance.now(),
      };

      // Mount loaders at context.loaders to match ArcheType.ts resolver access pattern.
      ctx.loaders = createRequestLoaders(db, cacheManager, signal, stats);
      // Prefer the HTTP-layer request id (from requestId() middleware's
      // AsyncLocalStorage) so access log + GraphQL logs share the same id.
      ctx.requestId = getRequestId() ?? crypto.randomUUID();
      ctx.cacheManager = cacheManager;
      ctx.requestStats = stats;
      ctx.signal = signal;

      // Attach to the raw Request so the HTTP router catch block + access
      // log middleware can read stats after Yoga rejects.
      if (request) {
        (request as any).__bunsaneStats = stats;
      }

      // Run the whole execution inside an AsyncLocalStorage scope so bare
      // `entity.get(Component)` calls (e.g. inside @ArcheTypeFunction
      // bodies, Unwrap(), service helpers) pick up the request's batching
      // DataLoaders + AbortSignal without explicit context threading.
      const scope = { loaders: ctx.loaders as RequestLoaders, signal, perRequest: stats };
      setExecuteFn(((execArgs: any) =>
        runWithRequestScope(scope, () => (executeFn as any)(execArgs))) as any);
    },
  };
}
