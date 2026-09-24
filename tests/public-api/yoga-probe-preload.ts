/**
 * Counts graphql-yoga `createYoga` calls for the public-barrel import probe.
 * Loaded only via `bun --preload` in tests/public-api/barrel.test.ts.
 */
import { createRequire } from "node:module";
import { mock } from "bun:test";

const require = createRequire(import.meta.url);
const actual = require("graphql-yoga") as {
    createYoga: (...args: unknown[]) => unknown;
};

const g = globalThis as { __bunsaneYogaConstructs?: number; __bunsaneYogaProbe?: string };
g.__bunsaneYogaConstructs = 0;
g.__bunsaneYogaProbe = "installed";

mock.module("graphql-yoga", () => ({
    ...actual,
    createYoga(...args: unknown[]) {
        g.__bunsaneYogaConstructs = (g.__bunsaneYogaConstructs ?? 0) + 1;
        return actual.createYoga(...args);
    },
}));
