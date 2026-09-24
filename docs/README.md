# BunSane docs

The package is experimental. Application code imports the authoring set from the package root (`import { App, Entity, Query, t } from "bunsane"`). Start with the [README hello world](../README.md#hello-world).

## App authors

- [Install, tsconfig, env, hello world](../README.md)
- [List queries](QUERY_LIST_GUIDE.md) — pagination, N+1, tags, when QSP applies
- [Standalone scripts](STANDALONE_SCRIPTS.md) — migrations, backfills, drain-before-exit
- [Locks](LOCKING.md) — `withLock` and what breaks under transaction pooling
- [Configuration](CONFIGURATION.md) — environment variables you set in an app

## Operators

- [Configuration](CONFIGURATION.md) — DB, cache, GraphQL, health, S3, logging, QSP
- [Pooling](POOLING.md) — PgBouncer, prepared statements, timeouts
- [QSP operations](QSP_OPERATIONS.md) — coverage rules, empty tags, reconcile
- [Read-path performance](READ_PATH_PERFORMANCE.md) — engine analysis and EXPLAIN protocol

## Internal

Design notes, RFCs, and tickets. Not published in the npm package (`package.json` `files` lists the guides above, not this folder).

- [Security audit tickets](internal/TICKETS_SECURITY_AUDIT_2026-08.md)
- [Read-path performance tickets](internal/TICKETS_READ_PATH_PERF_2026-08.md)
- [Lock / pooling / DataLoader tickets](internal/TICKETS_LOCK_POOLING_DATALOADER_2026-06-22.md)
- [App refactor RFC](internal/RFC_APP_REFACTOR.md)
- [Refactor targets](internal/RFC_REFACTOR_TARGETS.md)
- [Runtime authoring RFC](internal/RFC_RUNTIME_AUTHORING.md)
- [Query surface planner RFC](internal/RFC_QUERY_SURFACE_PLANNER.md)
- [QSP row hydration RFC](internal/RFC_QSP_ROW_HYDRATION.md)
- [Materialized read models RFC](internal/RFC_MATERIALIZED_READ_MODELS.md)
- [ECS sort denormalization RFC](internal/RFC_ECS_PG_SORT_DENORMALIZATION.md)
- [Query sort / pagination plan](internal/QUERY_SORT_PAGINATION_PLAN.md)
- [entity_components removal plan](internal/ENTITY_COMPONENTS_REMOVAL_PLAN.md)
- [Scalability plan](internal/SCALABILITY_PLAN.md)
