import { describe, test, expect } from "bun:test";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import {
    BaseArcheType,
    ArcheType,
    ArcheTypeField,
    HasMany,
    HasOne,
    BelongsTo,
} from "../../../core/ArcheType";
import { getMetadataStorage } from "../../../core/metadata";
import { invalidateArchetypeWeaveCache } from "../../../core/archetype/weaver";

function unregisterArchetype(name: string): void {
    const storage = getMetadataStorage();
    const index = storage.archetypes.findIndex((entry) => entry.name === name);
    if (index >= 0) storage.archetypes.splice(index, 1);
    invalidateArchetypeWeaveCache();
}

describe("FK-less relation inference", () => {
    test("zero matching components throws at schema build", () => {
        @Component
        class FkZeroInfo extends BaseComponent {
            @CompData() name: string = "";
        }

        @ArcheType({ name: "FkZeroChild" })
        class FkZeroChild extends BaseArcheType {
            @ArcheTypeField(FkZeroInfo)
            info!: FkZeroInfo;
        }

        @ArcheType({ name: "FkZeroParent" })
        class FkZeroParent extends BaseArcheType {
            @ArcheTypeField(FkZeroInfo)
            info!: FkZeroInfo;

            @HasMany(() => FkZeroChild)
            kids!: FkZeroChild[];
        }

        try {
            expect(() => new FkZeroParent().getZodObjectSchema()).toThrow(/foreignKey: 'component\.prop'/);
            expect(() => new FkZeroParent().generateFieldResolvers()).toThrow(/zero components/);
        } finally {
            unregisterArchetype("FkZeroChild");
            unregisterArchetype("FkZeroParent");
        }
    });

    test("multiple matching components throws at schema build", () => {
        @Component
        class FkMultiA extends BaseComponent {
            @CompData() user_id: string = "";
        }

        @Component
        class FkMultiB extends BaseComponent {
            @CompData() parent_id: string = "";
        }

        @ArcheType({ name: "FkMultiChild" })
        class FkMultiChild extends BaseArcheType {
            @ArcheTypeField(FkMultiA)
            a!: FkMultiA;

            @ArcheTypeField(FkMultiB)
            b!: FkMultiB;
        }

        @ArcheType({ name: "FkMultiParent" })
        class FkMultiParent extends BaseArcheType {
            @ArcheTypeField(FkMultiA)
            a!: FkMultiA;

            @HasMany(() => FkMultiChild)
            kids!: FkMultiChild[];

            @BelongsTo(() => FkMultiChild)
            owner!: FkMultiChild;
        }

        try {
            expect(() => new FkMultiParent().generateFieldResolvers()).toThrow(/foreignKey: 'component\.prop'/);
            expect(() => new FkMultiParent().getZodObjectSchema()).toThrow(/multiple components/);
        } finally {
            unregisterArchetype("FkMultiChild");
            unregisterArchetype("FkMultiParent");
        }
    });

    test("unique FK-less relations route through the type-pinned loader", async () => {
        @Component
        class FkPinChildLink extends BaseComponent {
            @CompData() user_id: string = "";
        }

        @Component
        class FkPinParentPtr extends BaseComponent {
            @CompData() parent_id: string = "";
        }

        @ArcheType({ name: "FkPinChild" })
        class FkPinChild extends BaseArcheType {
            @ArcheTypeField(FkPinChildLink)
            link!: FkPinChildLink;
        }

        @ArcheType({ name: "FkPinParent" })
        class FkPinParent extends BaseArcheType {
            @ArcheTypeField(FkPinParentPtr)
            ptr!: FkPinParentPtr;

            @HasMany(() => FkPinChild)
            kids!: FkPinChild[];

            @HasOne(() => FkPinChild)
            kid!: FkPinChild | null;

            @BelongsTo(() => FkPinChild)
            owner!: FkPinChild;
        }

        try {
            const childTypeId = getMetadataStorage().getComponentId(FkPinChildLink.name);
            const parentTypeId = getMetadataStorage().getComponentId(FkPinParentPtr.name);
            const fkLoads: Array<{ entityId: string; componentTypeId: string; foreignKeyField: string }> = [];
            const componentLoads: Array<{ entityId: string; typeId: string }> = [];
            const entityLoads: string[] = [];
            const loaders = {
                relationsByComponentFk: {
                    load: async (key: { entityId: string; componentTypeId: string; foreignKeyField: string }) => {
                        fkLoads.push(key);
                        return [{ id: "child-1" }, { id: "child-2" }];
                    },
                },
                componentsByEntityType: {
                    load: async (key: { entityId: string; typeId: string }) => {
                        componentLoads.push(key);
                        return { data: { parent_id: "owner-9" } };
                    },
                },
                entityById: {
                    load: async (id: string) => {
                        entityLoads.push(id);
                        return { id };
                    },
                },
            };

            const resolvers = new FkPinParent().generateFieldResolvers();
            const kids = resolvers.find((entry) => entry.fieldName === "kids");
            const kid = resolvers.find((entry) => entry.fieldName === "kid");
            const owner = resolvers.find((entry) => entry.fieldName === "owner");
            expect(kids).toBeDefined();
            expect(kid).toBeDefined();
            expect(owner).toBeDefined();

            const many = await kids!.resolver({ id: "parent-1" }, {}, { loaders });
            const one = await kid!.resolver({ id: "parent-1" }, {}, { loaders });
            const belongs = await owner!.resolver({ id: "parent-1" }, {}, { loaders });

            expect(many).toEqual([{ id: "child-1" }, { id: "child-2" }]);
            expect(one).toEqual({ id: "child-1" });
            expect(belongs).toEqual({ id: "owner-9" });
            expect(fkLoads.every((key) => key.componentTypeId === childTypeId && key.foreignKeyField === "user_id")).toBe(true);
            expect(componentLoads).toEqual([{ entityId: "parent-1", typeId: parentTypeId }]);
            expect(entityLoads).toEqual(["owner-9"]);
        } finally {
            unregisterArchetype("FkPinChild");
            unregisterArchetype("FkPinParent");
        }
    });
});
