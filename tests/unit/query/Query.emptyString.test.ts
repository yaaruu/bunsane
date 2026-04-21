/**
 * Empty-string filter support. JSONB text extraction (c.data->>'field')
 * returns text, so `= ''` / `!= ''` / LIKE against empty string are
 * legitimate. UUID-cast path is gated on a regex that empty cannot match.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Entity } from '../../../core/Entity';
import { BaseComponent } from '../../../core/components/BaseComponent';
import { Component, CompData } from '../../../core/components/Decorators';
import { Query, FilterOp } from '../../../query/Query';
import { ensureComponentsRegistered } from '../../utils';

@Component
class EmptyableNote extends BaseComponent {
    @CompData()
    value: string = '';
}

describe('Query empty-string filter', () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(EmptyableNote);
    });

    test('Query.filter accepts empty-string value without throwing', () => {
        expect(() => Query.filter('value', FilterOp.EQ, '')).not.toThrow();
        const f = Query.filter('value', FilterOp.EQ, '');
        expect(f.value).toBe('');
    });

    test('Query.filter accepts whitespace-only value without throwing', () => {
        expect(() => Query.filter('value', FilterOp.EQ, '   ')).not.toThrow();
    });

    test('.with(C, filter EQ "") executes and returns matching rows', async () => {
        const withEmpty = Entity.Create();
        withEmpty.add(EmptyableNote, { value: '' });
        await withEmpty.save();

        const withData = Entity.Create();
        withData.add(EmptyableNote, { value: 'not empty' });
        await withData.save();

        const rows = await new Query()
            .with(EmptyableNote, Query.filters(Query.filter('value', FilterOp.EQ, '')))
            .exec();

        const ids = rows.map(e => e.id);
        expect(ids).toContain(withEmpty.id);
        expect(ids).not.toContain(withData.id);
    });

    test('.with(C, filter != "") excludes rows with empty value', async () => {
        const withEmpty = Entity.Create();
        withEmpty.add(EmptyableNote, { value: '' });
        await withEmpty.save();

        const withData = Entity.Create();
        withData.add(EmptyableNote, { value: 'populated' });
        await withData.save();

        const rows = await new Query()
            .with(EmptyableNote, Query.filters(Query.filter('value', FilterOp.NEQ, '')))
            .exec();

        const ids = rows.map(e => e.id);
        expect(ids).toContain(withData.id);
        expect(ids).not.toContain(withEmpty.id);
    });
});
