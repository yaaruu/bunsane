import type { BaseComponent, ComponentDataType } from "./Components";
import { Entity } from "./Entity";

function compNameToFieldName(compName: string): string {
    return compName.charAt(0).toLowerCase() + compName.slice(1).replace(/Component$/, '');
}

/**
 * ArcheType provides a layer of abstraction for creating entities with predefined sets of components.
 * This makes entity creation more elegant and reduces code repetition.
 * 
 * Example usage:
 * ```typescript
 * class UserArcheType extends ArcheType {
 *   constructor(name: string, email: string) {
 *     super();
 *     this.addComponent(NameComponent, { value: name });
 *     this.addComponent(EmailComponent, { value: email });
 *   }
 * }
 * 
 * const entity = new UserArcheType("John", "john@example.com").createEntity();
 * ```
 */


class ArcheType {
    protected components: Set<{ ctor: new (...args: any[]) => BaseComponent, data: any }> = new Set();
    protected componentMap: Record<string, typeof BaseComponent> = {}; 

    constructor(components: Array<new (...args: any[]) => BaseComponent>) {
        for (const ctor of components) {
            this.componentMap[compNameToFieldName(ctor.name)] = ctor;
        }
    }
   
    
    private addComponent<T extends BaseComponent>(ctor: new (...args: any[]) => T, data: ComponentDataType<T>) {
        this.componentMap[compNameToFieldName(ctor.name)] = ctor;
        this.components.add({ ctor, data });
    }


    // TODO: Can we make this type-safe?
    public fill(input: object): this {
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                const compCtor = this.componentMap[key];
                if (compCtor) {
                    this.addComponent(compCtor, { value });
                } else {
                    throw new Error(`Component for field '${key}' not found in archetype.`);
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
}

export default ArcheType;