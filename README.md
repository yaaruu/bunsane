<div align="center">

<img src="https://raw.githubusercontent.com/yaaruu/bunsane/refs/heads/main/BunSane.jpg" alt="BunSane" width="520" />

# BunSane — Batteries-included TypeScript API framework for Bun

### Entity–Component storage on Postgres, a fluent query builder, and zero-boilerplate GraphQL with GraphQL Yoga.

BunSane is **experimental** (0.x). APIs can change. Not production-ready.

</div>

Guides: [docs/README.md](docs/README.md). Upgrading from 0.6.x: [docs/UPGRADING.md](docs/UPGRADING.md). Published reference: [bunsane-docs](https://yaaruu.github.io/bunsane-docs/).

## Install

Requires [Bun](https://bun.sh) 1.1 or newer (developed on 1.4).

npm `latest` is **0.6.1**. These docs describe `main`. v0.7.0 and v0.8.0 are GitHub tags, not the npm latest. 0.9 (index-driven list reads) is unreleased; `package.json` on `main` still says `0.8.0`.

```bash
# npm latest — 0.6.1. These docs do not describe it.
bun add bunsane

# tagged 0.8.0
bun add github:yaaruu/bunsane#v0.8.0

# unreleased 0.9 (this tree)
bun add github:yaaruu/bunsane
```

`reflect-metadata` is a dependency. Import it once, before your decorated classes.

## tsconfig

Decorators are required for `@Component` / `@ArcheType` / `@GraphQLOperation`. Do **not** extend this repo's `tsconfig.json` (`baseUrl: "."` is internal). A consumer config:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true
  }
}
```

The package ships TypeScript source (no emitted `.js` / `.d.ts`). `moduleResolution: "bundler"` is what resolves those `.ts` export targets.

## Environment

Minimum to boot. Full list: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

```bash
# either a URL …
DB_CONNECTION_URL=postgres://postgres:postgres@localhost:5432/app

# … or fields (password is used in the URL; host + user + database are required)
POSTGRES_HOST=localhost
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=app

APP_PORT=3000
```

`App.init()` validates that and listens on `APP_PORT` (default 3000) unless `NODE_ENV=test`. GraphQL is at `/graphql`. Liveness is `/health` (a real write probe).

## Hello world

```typescript
import "reflect-metadata";
import {
    App,
    ArcheType,
    ArcheTypeField,
    BaseArcheType,
    BaseComponent,
    BaseService,
    Component,
    CompData,
    Entity,
    GraphQLOperation,
    Query,
    ServiceRegistry,
    t,
    type InferInput,
} from "bunsane";

@Component
class Note extends BaseComponent {
    @CompData() text: string = "";
}

@ArcheType()
class Notebook extends BaseArcheType {
    @ArcheTypeField(Note) note!: Note;
}

const noteInput = { text: t.string().required() };

class NoteService extends BaseService {
    @GraphQLOperation({ type: "Query", input: noteInput, output: "[Notebook]" })
    notes(input: InferInput<typeof noteInput>): Promise<unknown> | unknown {
        const entity = Entity.Create();
        entity.add(Note, { text: input.text });
        return entity.save().then(() => new Query().with(Note).populate().take(10).exec());
    }
}

const app = new App("Hello", "0.1.0");
ServiceRegistry.registerService(new NoteService());
// init() migrates, builds the schema, and listens (unless NODE_ENV=test).
await app.init();
```

Importing `bunsane` does not open a database connection. The pool is created on first query. One-off scripts: [docs/STANDALONE_SCRIPTS.md](docs/STANDALONE_SCRIPTS.md). A string `output` is copied into the SDL as-is, so `"[Notebook]"` is the list type. `"Notebook"` would declare a single object; returning the array from `exec()` then fails in archetype field resolvers. The method is `Promise<unknown> | unknown` because a string output is not type-checked.

## What you get

- Entity–component rows in PostgreSQL. Base tables migrate on `App.init()`.
- Decorated components. A scalar `@CompData({ indexed: true })` field gets a **key index** (`bk_*`), not a GIN index (0.9, unreleased). Array fields still use GIN. `@CompositeIndex` (root export) covers equality on leading fields plus a sort or range on the next. The index reconciler creates and repairs `bk_` indexes at boot.
- Fluent `Query`: filters, `.take()` (there is no `.limit()`), `.populate()`, and **sorted cursors** (`sortedCursor`, `Query.encodeSortedCursor`) for keyset pages. `.cursor(id)` throws if any sort is set.
- **Index-driven lists** (0.9, unreleased). A single-key sort on an indexed field walks the index and stops at the page size.
- Services whose decorators generate the GraphQL schema. Use `t.*` for operation inputs. Zod and string-map inputs still work and log a deprecation warning. You do not call `registerFieldResolvers`.
- **Batched computed fields** (0.8+): `@ArcheTypeFunction({ batch: true })` receives the page of parents once.
- **Read models** (`@ReadModel`, `m3_*` tables; import from `bunsane/core/readmodel`) and **aggregates** (`Query.groupBy` plus `sumBy` / `maxBy` / `minBy`, `FilterOp.IS_NULL`) for reports. Do not `take(50000)` and reduce in JavaScript.
- Optional QSP list accelerator (`rm_*` tables, off by default). See [docs/QSP_OPERATIONS.md](docs/QSP_OPERATIONS.md).
- GraphQL Yoga and Pino logging.
- **Security defaults** (0.7+): introspection and GraphiQL only when `NODE_ENV=development` or an explicit `on`; `/metrics` and `/docs` return 404 without a token; non-multipart bodies default to 1 MB; GraphQL depth cannot be set below 15.

Pretty logs (`LOG_PRETTY=true`) require the optional `pino-pretty` package, which Bun installs by default. If it is omitted and `LOG_PRETTY=true` is set, the logger falls back to JSON and logs a warning — startup does not throw. Leave `LOG_PRETTY` unset for JSON logs.
