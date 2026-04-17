/**
 * Remote Communication: Types
 *
 * Standalone types for cross-app events over Redis Streams.
 * RemoteContext is NOT derived from GraphQLContext — remote handlers run
 * outside request scope.
 */

export interface RemoteContext {
    sourceApp: string;
    messageId: string;
    timestamp: Date;
    attempt: number;
    correlationId?: string;
    deadline?: Date;
}

export type RemoteHandler<T = unknown> = (
    data: T,
    ctx: RemoteContext
) => Promise<void> | void;

export type RemoteKind = "event" | "rpc_request";

export interface RemoteHandlerInfo {
    event: string;
    methodName: string;
    handlerId: string;
    /** "event" for @RemoteEvent, "rpc_request" for @RemoteRpc */
    kind: RemoteKind;
}

export interface RemoteEnvelope {
    /** Discriminator — absent/`"event"` = fire-and-forget, `"rpc_request"` = RPC */
    kind?: RemoteKind;
    sourceApp: string;
    event: string;
    data: unknown;
    emittedAt: number;

    /** RPC-only */
    correlationId?: string;
    replyTo?: string;
    deadline?: number;
}

export type RpcHandler<TIn = unknown, TOut = unknown> = (
    data: TIn,
    ctx: RemoteContext
) => Promise<TOut> | TOut;

export interface RpcSuccessResponse {
    correlationId: string;
    sourceApp: string;
    success: true;
    result: unknown;
    respondedAt: number;
}

export interface RpcErrorResponse {
    correlationId: string;
    sourceApp: string;
    success: false;
    error: {
        code: string;
        message: string;
        extensions?: Record<string, unknown>;
    };
    respondedAt: number;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export interface CallOptions {
    /** Timeout in ms (default: 5000) */
    timeout?: number;
}

/**
 * emit() options. Passing `trx` routes the event through the transactional
 * outbox — the row is inserted within the caller's transaction and
 * published by the OutboxWorker after commit.
 */
export interface EmitOptions {
    /** Transaction handle from `db.begin()` / `db.transaction()`. */
    trx?: import("bun").SQL;
}

export interface RemoteErrorOptions {
    code: string;
    sourceApp?: string;
    extensions?: Record<string, unknown>;
}

export class RemoteError extends Error {
    public readonly code: string;
    public readonly sourceApp?: string;
    public readonly extensions?: Record<string, unknown>;

    constructor(message: string, options: RemoteErrorOptions) {
        super(message);
        this.name = "RemoteError";
        this.code = options.code;
        this.sourceApp = options.sourceApp;
        this.extensions = options.extensions;
    }
}

export interface RemoteManagerConfig {
    /** This app's identity — used as stream name and sourceApp field */
    appName: string;
    /** Consumer group (defaults to appName) */
    consumerGroup?: string;
    /** Unique consumer id within the group (defaults to pid + timestamp) */
    consumerId?: string;
    /** Stream key prefix (default: "remote:") */
    streamPrefix?: string;
    /** Enable verbose logging */
    enableLogging?: boolean;
    /** Max messages per XREADGROUP batch (default: 10) */
    batchSize?: number;
    /** XREADGROUP BLOCK timeout in ms (default: 2000) */
    blockMs?: number;
    /** XAUTOCLAIM idle threshold in ms on startup (default: 60000). 0 disables */
    autoClaimIdleMs?: number;
    /** Max response stream length cap per XADD MAXLEN ~ (default: 1000) */
    responseStreamMaxLen?: number;
    /** Default RPC call timeout in ms (default: 5000) */
    defaultCallTimeout?: number;
    /** Grace window for pending RPC calls during shutdown (default: 2000) */
    shutdownDrainMs?: number;
    /** Enable transactional outbox (default: false) */
    enableOutbox?: boolean;
    /** Outbox polling interval in ms (default: 1000) */
    outboxPollIntervalMs?: number;
    /** Max rows processed per outbox tick (default: 100) */
    outboxBatchSize?: number;
    /** Circuit breaker failure threshold before opening (default: 5) */
    circuitBreakerThreshold?: number;
    /** Circuit breaker reset timeout in ms (default: 30000) */
    circuitBreakerResetMs?: number;
    /** Max deliveries before routing a message to DLQ (default: 3, 0 disables) */
    dlqMaxDeliveries?: number;
    /**
     * Test-only: override how Redis clients are constructed. Return a
     * connected client compatible with the ioredis `Redis` interface.
     * `blocking` is `true` for connections that will issue BLOCK commands
     * (consumer + RPC listener), `false` for the publisher.
     */
    redisFactory?: (blocking: boolean) => any;
}
