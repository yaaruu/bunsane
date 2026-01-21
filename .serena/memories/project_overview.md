# BunSane Project Overview

## Purpose
BunSane is a batteries-included TypeScript API framework for Bun with:
- Entity–Component storage on PostgreSQL (auto-migrates base tables on first run)
- Fluent, performant Query builder
- Zero-boilerplate GraphQL with GraphQL Yoga
- Declarative Components with decorators and indexed fields

**Status**: EXPERIMENTAL - Not Production Ready

## Tech Stack
- **Runtime**: Bun
- **Language**: TypeScript 5.9+ (strict mode, experimental decorators)
- **Database**: PostgreSQL
- **GraphQL**: GraphQL Yoga + GQLoom (@gqloom/core, @gqloom/zod)
- **Validation**: Zod 4.x
- **Logging**: Pino (with pino-pretty for development)
- **Cache**: Memory and Redis support (ioredis)
- **Data Loading**: dataloader for batching

## Key Concepts
1. **Entity**: Base unit of data storage, identified by UUID
2. **Component**: Data attached to entities (decorators: @Component, @CompData)
3. **ArcheType**: Defines a template of components an entity should have
4. **Query**: Fluent query builder for retrieving entities with components
5. **Service**: Business logic layer with auto-generated GraphQL schema

## Environment Variables
Database configuration via environment variables:
- `POSTGRES_HOST`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `POSTGRES_MAX_CONNECTIONS`
- `LOG_LEVEL`, `LOG_PRETTY`

## Repository
https://github.com/yaaruu/bunsane
