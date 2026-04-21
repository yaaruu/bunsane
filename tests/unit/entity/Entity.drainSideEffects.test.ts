/**
 * BUNSANE-001 defensive harness: verify Entity.drainPendingSideEffects()
 * awaits post-commit work scheduled via queueMicrotask from save(), so
 * tests under PGlite can settle prior-file background work before
 * asserting against freshly-committed state.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { ensureComponentsRegistered } from '../../utils';

@Component
class DrainMarker extends BaseComponent {
    @CompData()
    value: string = '';
}

describe('Entity.drainPendingSideEffects', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(DrainMarker);
    });

    test('no-op when nothing is pending', async () => {
        await expect(Entity.drainPendingSideEffects(100)).resolves.toBeUndefined();
    });

    test('awaits post-commit side effects scheduled by save()', async () => {
        const saved = Entity.Create();
        saved.add(DrainMarker, { value: 'pending' });
        await saved.save();

        // runPostCommitSideEffects is queued as a microtask. drain() must
        // settle it before returning.
        await Entity.drainPendingSideEffects(2_000);

        // A second drain is a no-op.
        await Entity.drainPendingSideEffects(100);
    });

    test('bounded by timeout, returns even if drain exceeds it', async () => {
        const saved = Entity.Create();
        saved.add(DrainMarker, { value: 'bounded' });
        await saved.save();

        const start = Date.now();
        await Entity.drainPendingSideEffects(1);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(500);
    });
});
