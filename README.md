<div align="center">

<img src="./BunSane.jpg" alt="BunSane" width="520" />

# BunSane — Batteries‑included TypeScript API framework for Bun

### Entity–Component storage on Postgres, a fluent query builder, and zero‑boilerplate GraphQL with GraphQL Yoga.
#### Skip Boilerplating and FOCUS writing Business Flow code 😉

### BunSane currently in `EXPERIMENTAL` state Not Production Ready
</div>

## Features

- Entity–Component model backed by PostgreSQL (auto-migrates base tables on first run)
- Declarative Components with decorators and indexed fields
- Fluent, performant Query builder (with/without population, filters, exclusions)
- Pluggable Services with decorators that generate a GraphQL schema automatically
- GraphQL Yoga server bootstrap out of the box
- Pino logging, pretty mode in development
- Zod-friendly GraphQL error helper

## Install

Requires Bun and PostgreSQL.

```cmd
bun install bunsane
```

Ensure your tsconfig enables decorators in your app:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Full documentation visit: [Documentation](https://example.com)

## Core concepts

### ECS ( Entity Component Services )
TODO


## LICENSE 
MIT

---

## Made with⚡
- Bun
- GraphQL
- GraphQL Yoga
- PostgreSQL

