/**
 * Unit tests for `database/cancellable.ts` — the shared `runWithSignal`
 * helper extracted from Entity.ts so every framework call-site uses the
 * same abort-on-cancel pattern.
 */
import { describe, test, expect } from 'bun:test';
import { runWithSignal } from '../../../database/cancellable';

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
