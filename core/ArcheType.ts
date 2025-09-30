import type { BaseComponent, ComponentDataType } from "./Components";
import { Entity } from "./Entity";

function compNameToFieldName(compName: string): string {
    return compName.charAt(0).toLowerCase() + compName.slice(1).replace(/Component$/, '');
}

export type ArcheTypeResolver = {
    resolver?: string;
    component?: new (...args: any[]) => BaseComponent;
    field?: string;
    filter?: {[key: string]: any};
}

export type ArcheTypeCreateInfo = {
    name: string;
    components: Array<new (...args: any[]) => BaseComponent>;
    graphql?: {
        fields: Record<string, ArcheTypeResolver>;
    }
};

/**
 * ArcheType provides a layer of abstraction for creating entities with predefined sets of components.
 * This makes entity creation more elegant and reduces code repetition.
 * 
 * Example usage:
 * ```typescript
 * const UserArcheType = new ArcheType([NameComponent, EmailComponent, PasswordComponent]);
 *
 * 
 * // FROM Request or other source 
 * const userInput = { name: "John Doe", email: "john@example.com", password: "securepassword" };
 * const entity = UserArcheType.fill(userInput).createEntity();
 * await entity.save();
 * ```
 */
class ArcheType {
    protected components: Set<{ ctor: new (...args: any[]) => BaseComponent, data: any }> = new Set();
    protected componentMap: Record<string, typeof BaseComponent> = {}; 
    public graphql?: {
        fields: Record<string, ArcheTypeResolver>;
    };

    constructor(components: Array<new (...args: any[]) => BaseComponent>) {
        for (const ctor of components) {
            this.componentMap[compNameToFieldName(ctor.name)] = ctor;
        }
    }

    static Create(info: ArcheTypeCreateInfo): ArcheType {
        const archetype = new ArcheType(info.components);
        archetype.graphql = info.graphql;
        return archetype;
    }
   
    
    private addComponent<T extends BaseComponent>(ctor: new (...args: any[]) => T, data: ComponentDataType<T>) {
        this.componentMap[compNameToFieldName(ctor.name)] = ctor;
        this.components.add({ ctor, data });
    }


    // TODO: Can we make this type-safe?
    public fill(input: object, strict: boolean = false): this {
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    this.addComponent(compCtor, { value });
                } else {
                    if (strict) {
                        throw new Error(`Component for field '${key}' not found in archetype.`);
                    }
                }
            }
        }
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            const alreadyAdded = Array.from(this.components).some(c => c.ctor === ctor);
            if (!alreadyAdded) {
                this.addComponent(ctor, {} as any);
            }
        }
        
        return this;
    }

    async updateEntity<T>(entity: Entity, updates: Partial<T>) {
        for (const key of Object.keys(updates)) {
            if(key === 'id' || key === '_id') continue;
            const value = updates[key as keyof T];
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    await entity.set(compCtor, { value });
                } else {
                    throw new Error(`Component for field '${key}' not found in archetype.`);
                }
            }
        }
    }

    /**
     * Creates a new entity with all the predefined components from this archetype.
     * @returns A new Entity instance with all archetype components added
     */
    public createEntity(): Entity {
        const entity = Entity.Create();
        for (const { ctor, data } of this.components) {
            entity.add(ctor, data);
        }
        return entity;
    }

    /**
     * Creates a new entity and immediately saves it to the database.
     * @returns A promise that resolves to the saved Entity
     */
    public async createAndSaveEntity(): Promise<Entity> {
        const entity = this.createEntity();
        await entity.save();
        return entity;
    }

    /**
     * Unwraps an entity into a plain object containing the component data.
     * @param entity The entity to unwrap
     * @param exclude An optional array of field names to exclude from the result (e.g., sensitive data like passwords)
     * @returns A promise that resolves to an object with component data
     */
    public async Unwrap(entity: Entity, exclude: string[] = []): Promise<Record<string, any>> {
        const result: any = { id: entity.id };
        for (const [field, ctor] of Object.entries(this.componentMap)) {
            if (exclude.includes(field)) continue;
            const comp = await entity.get(ctor as any);
            if (comp) {
                result[field] = (comp as any).value;
            }
        }
        return result;
    }
}

export default ArcheType;