import { Entity } from "./Entity";
import { BaseComponent } from "./Components";

export async function eagerLoadComponents(entities: Entity[], componentCtors: Array<new () => BaseComponent>): Promise<void> {
  if (entities.length === 0 || componentCtors.length === 0) return;

  const componentIds = componentCtors.map(ctor => {
    const comp = new ctor();
    return comp.getTypeID();
  });

  await Entity.LoadComponents(entities, componentIds);
}