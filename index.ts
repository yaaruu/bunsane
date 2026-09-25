/**
 * BunSane authoring surface.
 *
 * Importing this module does not open a database connection and does not
 * construct a GraphQL Yoga instance. The pool is created on first use of the
 * `bunsane/database` client. Yoga is created when `App.init()` builds the server.
 *
 * Deep paths (`bunsane/database`, `bunsane/core/components`, …) remain
 * importable. Prefer this barrel for application code.
 */

export { default as App } from "./core/App";
export type { AppConfig, CorsConfig } from "./core/App";

export { Entity } from "./core/Entity";

export { BaseComponent } from "./core/components/BaseComponent";
export { Component, CompData } from "./core/components/Decorators";
export { CompositeIndex } from "./core/decorators/CompositeIndex";

export { default as BaseArcheType } from "./core/ArcheType";
export {
    ArcheType,
    ArcheTypeField,
    ArcheTypeFunction,
    ArcheTypeUnionField,
    HasMany,
    BelongsTo,
    HasOne,
    BelongsToMany,
} from "./core/ArcheType";

export { Query, or, FilterOp } from "./query/Query";

export { default as BaseService } from "./service/Service";
export { default as ServiceRegistry } from "./service/ServiceRegistry";

export { GraphQLOperation, GraphQLSubscription } from "./gql/Generator";
export { t, type InferInput } from "./gql/schema";

export { logger } from "./core/Logger";

export {
    withLock,
    LockUnavailableError,
} from "./core/scheduler/withLock";
export type { WithLockOptions, LockOutcome } from "./core/scheduler/withLock";

export {
    ScheduledTask,
    registerScheduledTasks,
    ScheduleInterval,
} from "./scheduler";

export { accessLog, type AccessLogOptions } from "./core/middleware/AccessLog";
export { requestId, getRequestId } from "./core/middleware/RequestId";
export { securityHeaders, type SecurityHeadersOptions } from "./core/middleware/SecurityHeaders";
export { rateLimit, type RateLimitOptions } from "./core/middleware/RateLimit";

export {
    handleUpload,
    parseFormData,
    uploadResponse,
    uploadErrorResponse,
} from "./upload/RestUpload";
export type {
    ParsedUpload,
    RestUploadOptions,
    RestUploadResult,
} from "./upload/RestUpload";
export { UploadManager } from "./upload/UploadManager";
export { UploadHelper } from "./utils/UploadHelper";

export { CacheManager } from "./core/cache/CacheManager";
