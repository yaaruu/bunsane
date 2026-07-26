/**
 * Unit tests for `database/cancellable.ts` — the shared `runWithSignal`
 * helper extracted from Entity.ts so every framework call-site uses the
 * same abort-on-cancel pattern.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { runWithSignal, abortMode } from '../../../database/cancellable';

function makeFakeQuery<T>(opts: { delayMs?: number; value?: T; rejectWith?: Error }) {
    let cancelFn: () => void = () => {};
    const promise: any = new Promise<T>((resolve, reject) => {
        const handle = setTimeout(() => {
            if (opts.rejectWith) reject(opts.rejectWith);
            else resolve(opts.value as T);
        }, opts.delayMs ?? 1);
        cancelFn = () => {
            clearTimeout(handle);
            promise.cancelled = true;
            reject(Object.assign(new Error('Query cancelled'), { name: 'AbortError' }));
        };
    });
    // Swallow unhandled rejection when the helper throws on pre-abort before
    // awaiting `q`. Real Bun SQL Query objects don't surface this as an
    // unhandled rejection because the runtime captures the cancel reason.
    promise.catch(() => {});
    promise.cancel = cancelFn;
    promise.cancelled = false;
    return promise;
}

describe('runWithSignal', () => {
    test('resolves normally without signal', async () => {
        const q = makeFakeQuery({ value: [1, 2, 3] });
        const r = await runWithSignal<number[]>(q);
        expect(r).toEqual([1, 2, 3]);
    });

    test('resolves normally when signal never fires', async () => {
        const controller = new AbortController();
        const q = makeFakeQuery({ value: 'done' });
        const r = await runWithSignal<string>(q, controller.signal);
        expect(r).toBe('done');
    });

    test('rejects immediately when signal is pre-aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('pre-aborted'));
        const q = makeFakeQuery({ delayMs: 5000 });
        await expect(runWithSignal(q, controller.signal)).rejects.toBeDefined();
        // Cancelling the underlying query is best-effort; verify cancel ran.
        expect(q.cancelled).toBe(true);
    });

    test('cancels query mid-flight when signal aborts', async () => {
        const controller = new AbortController();
        const q = makeFakeQuery({ delayMs: 5000 });
        queueMicrotask(() => controller.abort(new Error('mid-flight')));

        await expect(runWithSignal(q, controller.signal)).rejects.toBeDefined();
        expect(q.cancelled).toBe(true);
    });

    test('removes abort listener on success', async () => {
        const controller = new AbortController();
        let listenerCount = 0;
        const origAdd = controller.signal.addEventListener.bind(controller.signal);
        const origRemove = controller.signal.removeEventListener.bind(controller.signal);
        controller.signal.addEventListener = ((...args: any[]) => {
            listenerCount++;
            return (origAdd as any)(...args);
        }) as any;
        controller.signal.removeEventListener = ((...args: any[]) => {
            listenerCount--;
            return (origRemove as any)(...args);
        }) as any;

        const q = makeFakeQuery({ value: 1 });
        await runWithSignal(q, controller.signal);
        expect(listenerCount).toBe(0);
    });
});

/**
 * BUNSANE_ABORT_MODE is a temporary diagnostic switch (ticket B8b): behind a
 * pooler `cancel()` does not free the slot anyway, and it is not yet ruled out
 * as the reason some pooled connections never returned. `off` must therefore
 * bound the caller WITHOUT touching the query.
 */
describe('runWithSignal abort mode', () => {
    const original = process.env.BUNSANE_ABORT_MODE;
    afterEach(() => {
        if (original === undefined) delete process.env.BUNSANE_ABORT_MODE;
        else process.env.BUNSANE_ABORT_MODE = original;
    });

    test('defaults to cancel', () => {
        delete process.env.BUNSANE_ABORT_MODE;
        expect(abortMode()).toBe('cancel');
        process.env.BUNSANE_ABORT_MODE = 'something-else';
        expect(abortMode()).toBe('cancel');
    });

    test('mode=off still rejects the caller but leaves the query alone', async () => {
        process.env.BUNSANE_ABORT_MODE = 'off';
        const controller = new AbortController();
        const q = makeFakeQuery({ delayMs: 5000 });
        queueMicrotask(() => controller.abort(new Error('mid-flight')));

        await expect(runWithSignal(q, controller.signal)).rejects.toBeDefined();
        expect(q.cancelled).toBe(false);
    });

    test('mode=off is honoured on the pre-aborted path too', async () => {
        process.env.BUNSANE_ABORT_MODE = 'off';
        const controller = new AbortController();
        controller.abort(new Error('pre-aborted'));
        const q = makeFakeQuery({ delayMs: 5000 });

        await expect(runWithSignal(q, controller.signal)).rejects.toBeDefined();
        expect(q.cancelled).toBe(false);
    });

    test('is read at call time, so flipping it needs no reimport', async () => {
        process.env.BUNSANE_ABORT_MODE = 'off';
        expect(abortMode()).toBe('off');
        process.env.BUNSANE_ABORT_MODE = 'cancel';
        expect(abortMode()).toBe('cancel');

        const controller = new AbortController();
        const q = makeFakeQuery({ delayMs: 5000 });
        queueMicrotask(() => controller.abort(new Error('mid-flight')));
        await expect(runWithSignal(q, controller.signal)).rejects.toBeDefined();
        expect(q.cancelled).toBe(true);
    });
});
