import { describe, test, expect, beforeAll } from "bun:test";
import { graphql } from "graphql";
import { BaseComponent } from "../../../core/components/BaseComponent";
import { Component, CompData } from "../../../core/components/Decorators";
import {
    BaseArcheType,
    ArcheType,
    ArcheTypeField,
    HasMany,
    BelongsTo,
    HasOne,
    ArcheTypeFunction,
    weaveAllArchetypes,
} from "../../../core/ArcheType";
import { invalidateArchetypeWeaveCache } from "../../../core/archetype/weaver";
import { selectComponentsToLoad } from "../../../core/archetype/entityOps";
import { getMetadataStorage } from "../../../core/metadata";
import { GraphQLSchemaOrchestrator } from "../../../gql/orchestration/GraphQLSchemaOrchestrator";
import { GraphQLOperation } from "../../../gql/Generator";
import BaseService from "../../../service/Service";
import { ensureComponentsRegistered } from "../../utils";

@Component
class GqlArchInfo extends BaseComponent {
    @CompData() teamId: string = "";
    @CompData() updated_at: string = "";
}

@Component
class GqlArchTeamInfo extends BaseComponent {
    @CompData() name: string = "";
    @CompData() founded: Date = new Date(0);
}

@Component
class GqlArchHealthComponent extends BaseComponent {
    @CompData() current: number = 1;
}

@ArcheType({ name: "GqlArchTeam" })
class GqlArchTeam extends BaseArcheType {
    @ArcheTypeField(GqlArchTeamInfo)
    info!: GqlArchTeamInfo;

    @HasMany(() => GqlArchPlayer, { foreignKey: "info.teamId" })
    players!: GqlArchPlayer[];
}

@ArcheType({ name: "GqlArchPlayer" })
class GqlArchPlayer extends BaseArcheType {
    @ArcheTypeField(GqlArchInfo)
    info!: GqlArchInfo;

    @BelongsTo(() => GqlArchTeam, { foreignKey: "info.teamId" })
    team!: GqlArchTeam;
}

@ArcheType({ name: "GqlArchRoster" })
class GqlArchRoster extends BaseArcheType {
    @ArcheTypeField(GqlArchInfo)
    info!: GqlArchInfo;

    @HasMany(GqlArchPlayer)
    roster!: GqlArchPlayer[];
}

@ArcheType({ name: "GqlArchHealth" })
class GqlArchHealth extends BaseArcheType {
    @ArcheTypeField(GqlArchHealthComponent)
    health!: GqlArchHealthComponent;
}

@Component
class GqlArchProfileLink extends BaseComponent {
    @CompData() userId: string = "";
}

@ArcheType({ name: "GqlArchProfile" })
class GqlArchProfile extends BaseArcheType {
    @ArcheTypeField(GqlArchProfileLink)
    link!: GqlArchProfileLink;
}

@ArcheType({ name: "GqlArchUser" })
class GqlArchUser extends BaseArcheType {
    @ArcheTypeField(GqlArchInfo)
    info!: GqlArchInfo;

    @HasOne(GqlArchProfile, { foreignKey: "link.userId" })
    profile!: GqlArchProfile | null;
}

class GqlArchService extends BaseService {
    @GraphQLOperation({ type: "Query", output: new GqlArchPlayer() })
    gqlArchPlayer(): GqlArchPlayer {
        return { id: "player-1" } as unknown as GqlArchPlayer;
    }

    @GraphQLOperation({ type: "Query", output: new GqlArchUser() })
    gqlArchUser(): GqlArchUser {
        return { id: "user-missing" } as unknown as GqlArchUser;
    }
}

function unregisterArchetype(name: string): void {
    const storage = getMetadataStorage();
    const index = storage.archetypes.findIndex((entry) => entry.name === name);
    if (index >= 0) storage.archetypes.splice(index, 1);
    invalidateArchetypeWeaveCache();
}

function playerPayload(data: unknown): { id: string; team: { id: string } | null } {
    if (!data || typeof data !== "object" || !("gqlArchPlayer" in data)) {
        throw new Error("missing gqlArchPlayer");
    }
    const player = data.gqlArchPlayer;
    if (!player || typeof player !== "object" || !("id" in player) || !("team" in player)) {
        throw new Error("gqlArchPlayer payload is incomplete");
    }
    const team = player.team;
    if (team !== null && (typeof team !== "object" || !("id" in team) || typeof team.id !== "string")) {
        throw new Error("team payload is incomplete");
    }
    if (typeof player.id !== "string") throw new Error("player id is not a string");
    return { id: player.id, team: team as { id: string } | null };
}

describe("archetype GraphQL resolvers and schema", () => {
    beforeAll(async () => {
        await ensureComponentsRegistered(GqlArchInfo, GqlArchTeamInfo, GqlArchHealthComponent, GqlArchProfileLink);
    });

    test("relation field is non-null without registerFieldResolvers", async () => {
        const orchestrator = new GraphQLSchemaOrchestrator();
        const schema = orchestrator.generateSchema([new GqlArchService()]);
        expect(schema).not.toBeNull();

        const teamLoads: string[] = [];
        const result = await graphql({
            schema: schema!,
            source: "query { gqlArchPlayer { id team { id } } }",
            contextValue: {
                loaders: {
                    componentsByEntityType: {
                        load: async () => ({ data: { teamId: "team-9", updated_at: "yesterday" } }),
                    },
                    entityById: {
                        load: async (id: string) => {
                            teamLoads.push(id);
                            return { id };
                        },
                    },
                },
            },
        });

        expect(result.errors).toBeUndefined();
        const player = playerPayload(result.data);
        expect(player.team).not.toBeNull();
        expect(player.team?.id).toBe("team-9");
        expect(teamLoads).toEqual(["team-9"]);
    });

    test("short-circuit does not call loaders when parent already has the field", () => {
        const resolver = new GqlArchPlayer().generateFieldResolvers().find(
            (entry) => entry.typeName === "GqlArchPlayer" && entry.fieldName === "team",
        );
        expect(resolver).toBeDefined();

        let loads = 0;
        const value = resolver!.resolver(
            { id: "player-1", team: { id: "already" } },
            {},
            {
                loaders: {
                    componentsByEntityType: { load: async () => { loads++; return null; } },
                    entityById: { load: async () => { loads++; return null; } },
                },
            },
        );
        expect(value).toEqual({ id: "already" });
        expect(loads).toBe(0);
        expect(value instanceof Promise).toBe(false);
    });

    test("unregistered relation target throws at schema build", () => {
        @ArcheType({ name: "GqlArchMissingRel" })
        class GqlArchMissingRel extends BaseArcheType {
            @ArcheTypeField(GqlArchInfo)
            info!: GqlArchInfo;

            @HasMany("NotARegisteredArchetype")
            missing!: unknown;
        }
        try {
            expect(() => new GqlArchMissingRel().getZodObjectSchema()).toThrow(/NotARegisteredArchetype/);
        } finally {
            unregisterArchetype("GqlArchMissingRel");
        }
    });

    test("string field named updated_at stays String and class HasMany is a list type", () => {
        const sdl = weaveAllArchetypes();
        expect(sdl).toBeTruthy();
        expect(sdl).toContain("updated_at: String");
        expect(sdl).not.toMatch(/updated_at:\s*Date/);
        expect(sdl).toContain("players: [GqlArchPlayer!]");
        expect(sdl).toContain("roster: [GqlArchPlayer!]");
        expect(sdl).toContain("team: GqlArchTeam!");
        expect(sdl).toContain("founded: Date!");
    });

    test("hasOne resolves the child by its foreign key and returns null when absent", async () => {
        const sdl = weaveAllArchetypes();
        expect(sdl).toMatch(/profile:\s+GqlArchProfile(?!!)/);

        const resolver = new GqlArchUser().generateFieldResolvers().find(
            (entry) => entry.typeName === "GqlArchUser" && entry.fieldName === "profile",
        );
        expect(resolver).toBeDefined();

        const seen: Array<{ entityId: string; foreignKey?: string }> = [];
        const loaders = {
            relationsByEntityField: {
                load: async (key: { entityId: string; foreignKey?: string }) => {
                    seen.push(key);
                    if (key.entityId === "user-1") return [{ id: "profile-1" }];
                    return [];
                },
            },
            componentsByEntityType: {
                load: async () => {
                    throw new Error("hasOne must not scan the parent for the foreign key");
                },
            },
            entityById: {
                load: async () => {
                    throw new Error("hasOne must not entityById the parent-side foreign key");
                },
            },
        };

        const hit = await resolver!.resolver({ id: "user-1" }, {}, { loaders });
        expect(hit).toEqual({ id: "profile-1" });
        expect(seen[0]?.foreignKey).toBe("userId");

        const miss = await resolver!.resolver({ id: "user-missing" }, {}, { loaders });
        expect(miss).toBeNull();

        const orchestrator = new GraphQLSchemaOrchestrator();
        const schema = orchestrator.generateSchema([new GqlArchService()]);
        expect(schema).not.toBeNull();
        const result = await graphql({
            schema: schema!,
            source: "query { gqlArchUser { profile { id } } }",
            contextValue: { loaders },
        });
        expect(result.errors).toBeUndefined();
        if (!result.data || typeof result.data !== "object" || !("gqlArchUser" in result.data)) {
            throw new Error("missing gqlArchUser");
        }
        const user = result.data.gqlArchUser;
        if (!user || typeof user !== "object" || !("profile" in user)) {
            throw new Error("gqlArchUser has no profile field");
        }
        expect(user.profile).toBeNull();
    });

    test("includeComponents filters by archetype property key", () => {
        const archetype = new GqlArchHealth();
        const host = {
            componentMap: archetype.componentMap,
            unionMap: archetype.unionMap,
            fieldOptions: {},
            unionOptions: {},
            fieldTypes: {},
            components: new Set<never>(),
        };
        expect(selectComponentsToLoad(host, { includeComponents: ["health"] })).toContain(GqlArchHealthComponent);
        expect(selectComponentsToLoad(host, { includeComponents: ["gqlArchHealthComponent"] })).not.toContain(GqlArchHealthComponent);
    });

    test("@ArcheTypeFunction without returnType on a Promise method throws", () => {
        @ArcheType({ name: "GqlArchFn" })
        class GqlArchFn extends BaseArcheType {
            @ArcheTypeField(GqlArchInfo)
            info!: GqlArchInfo;

            @ArcheTypeFunction()
            async unlabeled(): Promise<{ n: number }> {
                return { n: 1 };
            }
        }
        try {
            expect(() => new GqlArchFn().getZodObjectSchema()).toThrow(/returnType/);
        } finally {
            unregisterArchetype("GqlArchFn");
        }
    });
});
