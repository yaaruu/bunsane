import {describe, test, expect, beforeAll} from "bun:test"
import App from "core/App"
import { BaseComponent, CompData, Component } from "core/Components";
import { Entity } from "core/Entity";

let app;
beforeAll(async () => {
    app = new App();
    await app.waitForAppReady();
});

@Component
class TestComponent extends BaseComponent {
    @CompData()
    value: string = "";
}

describe("Query test", async () => {
    test("Create and Update Entity", async () => {
        const entity = Entity.Create()
        .add(TestComponent, {value: "Test"})
        await entity.save(); 
        
        const fetchedEntity = await Entity.FindById(entity.id);
        expect(fetchedEntity).not.toBeNull();
        expect(fetchedEntity?.componentList().length).toBe(1);

        await fetchedEntity?.set(TestComponent, {value: "UpdatedTest"});
        console.log("Updating Entity");
        await fetchedEntity?.save();

        const updatedEntity = await Entity.FindById(entity.id);
        expect(updatedEntity).not.toBeNull();
        expect(updatedEntity?.componentList().length).toBe(1);
        const comp = await updatedEntity?.get(TestComponent)
        expect(comp?.value).toBe("UpdatedTest");

    });
})