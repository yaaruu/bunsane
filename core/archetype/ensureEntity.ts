import { Entity } from "../Entity";

/**
 * Turn a GraphQL parent (Entity or plain object with id) into an Entity.
 * Used by field resolvers when no request DataLoader is mounted.
 */
export async function ensureEntity(parent: any, context: any): Promise<Entity> {
    if (parent instanceof Entity) {
        return parent;
    }
    if (parent && parent.id) {
        if (context?.loaders?.entityById) {
            const loaded = await context.loaders.entityById.load(parent.id);
            if (loaded) return loaded;
        }
        const entity = new Entity(parent.id);
        entity.setPersisted(true);
        return entity;
    }
    throw new Error("Invalid parent object: missing id property");
}
