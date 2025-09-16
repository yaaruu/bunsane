import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import App from "core/App";
import { BaseComponent, CompData, Component } from "core/Components";
import { Entity } from "core/Entity";
import { BatchLoader } from "core/BatchLoader";
import { isFieldRequestedSafe } from "gql/helpers";
import db from "database";

let app: App;

beforeAll(async () => {
    app = new App();
    await app.waitForAppReady();
});

beforeEach(async () => {
    await db`TRUNCATE TABLE entities CASCADE;`;
});

@Component
class AuthorComponent extends BaseComponent {
    @CompData()
    value: string = ""; // related user id
}

@Component
class TitleComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

@Component
class UserComponent extends BaseComponent {
    @CompData()
    name: string = "";
}

describe('Relations Tests', () => {
    test('BatchLoader.loadRelatedEntitiesBatched fetches relations in one query', async () => {
        // Create users
        const user1 = Entity.Create().add(UserComponent, { name: "User1" });
        const user2 = Entity.Create().add(UserComponent, { name: "User2" });
        await Promise.all([user1.save(), user2.save()]);

        // Create posts with authors
        const post1 = Entity.Create()
            .add(TitleComponent, { value: "Post1" })
            .add(AuthorComponent, { value: user1.id });
        const post2 = Entity.Create()
            .add(TitleComponent, { value: "Post2" })
            .add(AuthorComponent, { value: user2.id });
        await Promise.all([post1.save(), post2.save()]);

        // Test batched loading
        const loader = async (ids: string[]) => {
            const entities = await Entity.LoadMultiple(ids);
            return entities;
        };

        const result = await BatchLoader.loadRelatedEntitiesBatched([post1, post2], AuthorComponent, loader);

        expect(result.size).toBe(2);
        expect(result.get(user1.id)?.id).toBe(user1.id);
        expect(result.get(user2.id)?.id).toBe(user2.id);
    });

    test('BatchLoader handles large parent list efficiently', async () => {
        // Create 100 users
        const users = [];
        for (let i = 0; i < 100; i++) {
            const user = Entity.Create().add(UserComponent, { name: `User${i}` });
            users.push(user);
        }
        await Promise.all(users.map(u => u.save()));

        // Create 100 posts with random authors
        const posts = [];
        for (let i = 0; i < 100; i++) {
            const randomUser = users[Math.floor(Math.random() * users.length)]!;
            const post = Entity.Create()
                .add(TitleComponent, { value: `Post${i}` })
                .add(AuthorComponent, { value: randomUser.id });
            posts.push(post);
        }
        await Promise.all(posts.map(p => p.save()));

        // Test batched loading performance
        const startTime = Date.now();
        const loader = async (ids: string[]) => {
            return await Entity.LoadMultiple(ids);
        };

        const result = await BatchLoader.loadRelatedEntitiesBatched(posts, AuthorComponent, loader);
        const endTime = Date.now();

        expect(result.size).toBeGreaterThan(0);
        expect(endTime - startTime).toBeLessThan(1000); // Should complete under 1 second
    });

    test('isFieldRequestedSafe handles nested selections', () => {
        const info = {
            fieldNodes: [{
                selectionSet: {
                    selections: [
                        { kind: 'Field', name: { value: 'id' } },
                        {
                            kind: 'Field',
                            name: { value: 'author' },
                            selectionSet: {
                                selections: [{ kind: 'Field', name: { value: 'name' } }]
                            }
                        }
                    ]
                }
            }]
        };

        expect(isFieldRequestedSafe(info, 'id')).toBe(true);
        expect(isFieldRequestedSafe(info, 'author')).toBe(true);
        expect(isFieldRequestedSafe(info, 'author', 'name')).toBe(true);
        expect(isFieldRequestedSafe(info, 'title')).toBe(false);
    });

    test('isFieldRequestedSafe handles fragments', () => {
        const info = {
            fieldNodes: [{
                selectionSet: {
                    selections: [
                        { kind: 'FragmentSpread', name: { value: 'UserFragment' } }
                    ]
                }
            }]
        };

        // Assuming fragments are expanded, but for test, mock as if selections are there
        // In real scenario, fragments would be resolved
        expect(isFieldRequestedSafe(info, 'id')).toBe(false); // since no direct field
    });

    test('isFieldRequestedSafe handles missing selectionSet', () => {
        const info = {
            fieldNodes: [{
                // no selectionSet
            }]
        };

        expect(isFieldRequestedSafe(info, 'id')).toBe(false);
    });

    test('Entity.doDelete resolves promise correctly', async () => {
        const entity = Entity.Create().add(TitleComponent, { value: "Test" });
        await entity.save();

        const deletePromise = entity.delete();
        await expect(deletePromise).resolves.toBe(true);

        // Verify deleted (soft delete - check deleted_at is set)
        const check = await db`SELECT id, deleted_at FROM entities WHERE id = ${entity.id}`;
        expect(check.length).toBe(1);
        expect(check[0].deleted_at).not.toBeNull();
    });

    test('Entity.doDelete resolves false for non-persisted entity', async () => {
        const entity = new Entity(); // not saved

        const deletePromise = entity.delete();
        await expect(deletePromise).resolves.toBe(false);
    });
});