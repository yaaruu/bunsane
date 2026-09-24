<div align="center">

<img src="https://raw.githubusercontent.com/yaaruu/bunsane/refs/heads/main/BunSane.jpg" alt="BunSane" width="520" />

# BunSane — Batteries-included TypeScript API framework for Bun

### Entity–Component storage on Postgres, a fluent query builder, and zero-boilerplate GraphQL with GraphQL Yoga.

BunSane is **experimental** (0.x). APIs can change. Not production-ready.

</div>

Guides: [docs/README.md](docs/README.md) (app authors, operators, internal notes). Published reference: [bunsane-docs](https://yaaruu.github.io/bunsane-docs/#/).

## Install

Requires [Bun](https://bun.sh) 1.1 or newer (developed on 1.4).

```bash
bun add bunsane
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
    @GraphQLOperation({ type: "Query", input: noteInput, output: "Notebook" })
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

Importing `bunsane` does not open a database connection. The pool is created on first query. One-off scripts: [docs/STANDALONE_SCRIPTS.md](docs/STANDALONE_SCRIPTS.md). The operation method is declared `Promise<unknown> | unknown` because `@GraphQLOperation` checks the method against that descriptor when `output` is a GraphQL type name (`"Notebook"` is the archetype class name).

## What you get

- Entity–component rows in PostgreSQL (base tables migrate on `init()`)
- Decorated components, with optional indexed fields
- Fluent `Query` (filters, `take`, `populate`)
- Services whose decorators generate the GraphQL schema
- GraphQL Yoga, Pino logging, Zod-backed input checks via `t`

Pretty logs (`LOG_PRETTY=true`) require the optional `pino-pretty` package, which Bun installs by default. If it is omitted and `LOG_PRETTY=true` is set, the logger falls back to JSON and logs a warning — startup does not throw. Leave `LOG_PRETTY` unset for JSON logs.
