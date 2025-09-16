import type { RequestLoaders, ComponentData } from './RequestLoaders';
import { Entity } from './Entity';

export async function getEntityById(ctx: { locals: { loaders: RequestLoaders } }, id: string): Promise<Entity | null> {
  return ctx.locals.loaders.entityById.load(id);
}

export async function getComponent(ctx: { locals: { loaders: RequestLoaders } }, entityId: string, typeId: number): Promise<ComponentData | null> {
  return ctx.locals.loaders.componentsByEntityType.load({ entityId, typeId });
}

export async function preloadComponents(ctx: { locals: { loaders: RequestLoaders } }, entityIds: string[], typeId: number): Promise<void> {
  const keys = entityIds.map(entityId => ({ entityId, typeId }));
  await ctx.locals.loaders.componentsByEntityType.loadMany(keys);
}