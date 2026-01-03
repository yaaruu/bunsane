import type { Entity } from "../Entity";
import type { BaseComponent } from "@/core/components";

/**
 * Base class for all entity lifecycle events
 * Provides common properties and methods for lifecycle events
 */
export abstract class EntityLifecycleEvent {
    public readonly timestamp: Date;
    public readonly entity: Entity;
    public readonly eventType: string;

    constructor(entity: Entity, eventType: string) {
        this.timestamp = new Date();
        this.entity = entity;
        this.eventType = eventType;
    }

    /**
     * Get the event type identifier
     */
    public getEventType(): string {
        return this.eventType;
    }

    /**
     * Get the entity associated with this event
     */
    public getEntity(): Entity {
        return this.entity;
    }

    /**
     * Get the timestamp when the event occurred
     */
    public getTimestamp(): Date {
        return this.timestamp;
    }
}

/**
 * Event fired when an entity is created (first time saved)
 */
export class EntityCreatedEvent extends EntityLifecycleEvent {
    public readonly isNew: boolean = true;

    constructor(entity: Entity) {
        super(entity, "entity.created");
    }
}

/**
 * Event fired when an entity is updated (subsequent saves)
 */
export class EntityUpdatedEvent extends EntityLifecycleEvent {
    public readonly isNew: boolean = false;
    public readonly changedComponents: string[] = [];

    constructor(entity: Entity, changedComponents: string[] = []) {
        super(entity, "entity.updated");
        this.changedComponents = changedComponents;
    }

    /**
     * Get the list of component types that were changed
     */
    public getChangedComponents(): string[] {
        return this.changedComponents;
    }
}

/**
 * Event fired when an entity is deleted
 */
export class EntityDeletedEvent extends EntityLifecycleEvent {
    public readonly isSoftDelete: boolean = true;

    constructor(entity: Entity, isSoftDelete: boolean = true) {
        super(entity, "entity.deleted");
        this.isSoftDelete = isSoftDelete;
    }
}

/**
 * Base class for component lifecycle events
 */
export abstract class ComponentLifecycleEvent extends EntityLifecycleEvent {
    public readonly component: BaseComponent;
    public readonly componentType: string;

    constructor(entity: Entity, component: BaseComponent, eventType: string) {
        super(entity, eventType);
        this.component = component;
        this.componentType = component.getTypeID();
    }

    /**
     * Get the component associated with this event
     */
    public getComponent(): BaseComponent {
        return this.component;
    }

    /**
     * Get the component type identifier
     */
    public getComponentType(): string {
        return this.componentType;
    }
}

/**
 * Event fired when a component is added to an entity
 */
export class ComponentAddedEvent extends ComponentLifecycleEvent {
    constructor(entity: Entity, component: BaseComponent) {
        super(entity, component, "component.added");
    }
}

/**
 * Event fired when a component is updated on an entity
 */
export class ComponentUpdatedEvent extends ComponentLifecycleEvent {
    public readonly oldData?: any;
    public readonly newData?: any;

    constructor(entity: Entity, component: BaseComponent, oldData?: any, newData?: any) {
        super(entity, component, "component.updated");
        this.oldData = oldData;
        this.newData = newData;
    }

    /**
     * Get the old component data before the update
     */
    public getOldData(): any {
        return this.oldData;
    }

    /**
     * Get the new component data after the update
     */
    public getNewData(): any {
        return this.newData;
    }
}

/**
 * Event fired when a component is removed from an entity
 */
export class ComponentRemovedEvent extends ComponentLifecycleEvent {
    constructor(entity: Entity, component: BaseComponent) {
        super(entity, component, "component.removed");
    }
}

/**
 * Union type for all entity lifecycle events
 */
export type EntityEvent =
    | EntityCreatedEvent
    | EntityUpdatedEvent
    | EntityDeletedEvent;

/**
 * Union type for all component lifecycle events
 */
export type ComponentEvent =
    | ComponentAddedEvent
    | ComponentUpdatedEvent
    | ComponentRemovedEvent;

/**
 * Union type for all lifecycle events
 */
export type LifecycleEvent = EntityEvent | ComponentEvent;