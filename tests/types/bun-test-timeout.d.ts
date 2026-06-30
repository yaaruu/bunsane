// bun:test lifecycle hooks accept an optional per-hook timeout (ms) at runtime,
// but the bundled bun-types declares them as single-argument. Augment the module
// with the timeout overload so heavy seed/teardown hooks can raise their timeout
// without tripping "Expected 1 arguments, but got 2". Matches Bun's runtime.
declare module "bun:test" {
    type HookFn =
        | (() => void | Promise<unknown>)
        | ((done: (err?: unknown) => void) => void);

    export function beforeAll(fn: HookFn, timeout?: number): void;
    export function afterAll(fn: HookFn, timeout?: number): void;
    export function beforeEach(fn: HookFn, timeout?: number): void;
    export function afterEach(fn: HookFn, timeout?: number): void;
}

export {};
