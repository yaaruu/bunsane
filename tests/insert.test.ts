import {describe, test, expect, beforeAll, beforeEach} from "bun:test"
import App from "core/App"
import { BaseComponent, CompData, Component } from "core/Components";
import { Entity } from "core/Entity";
import db from "database";

let app;
beforeAll(async () => {
    app = new App();
    await app.waitForAppReady();
});

beforeEach(async () => {
   await db`TRUNCATE TABLE entities CASCADE;`;
})

@Component
class TestComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

@Component
class AnotherComponent extends BaseComponent {
    @CompData()
    numberValue: number = 0;
}

@Component
class YetAnotherComponent extends BaseComponent {
    @CompData()
    boolValue: boolean = false;
}

@Component
class MassiveComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

describe('Insert Entity Tests', () => {
    test('Creating 10000 entities', async () => {
        const entities = [];
        for(let i = 0; i < 10000; i++) {
            const entity = Entity.Create()
                .add(TestComponent, {value: `Test ${i}`})
                .add(AnotherComponent, {numberValue: i})
                .add(YetAnotherComponent, {boolValue: i % 2 === 0})
                .add(MassiveComponent, {value: "x".repeat(1000)});
            entities.push(entity);
        }
        const start = performance.now();
        await Promise.all(entities.map(entity => entity.save()));
        const end = performance.now();
        console.log(`Time taken to create 10000 entities: ${end - start}ms`);
        const countResult :any = await db<{count: number}>`SELECT COUNT(*)::int FROM entities;`;
        expect(countResult[0].count).toBe(10000);
    });
});