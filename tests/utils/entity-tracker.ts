/**
 * Entity tracker for automatic cleanup in tests
 */
import { Entity } from '../../core/Entity';

/**
 * Tracks entities created during a test for cleanup
 */
export class EntityTracker {
    private entities: Entity[] = [];

    /**
     * Track an entity for cleanup after the test
     */
    track(entity: Entity): Entity {
        this.entities.push(entity);
        return entity;
    }

    /**
     * Create and track a new entity
     */
    create(id?: string): Entity {
        const entity = new Entity(id);
        return this.track(entity);
    }

    /**
     * Clean up all tracked entities (soft delete by default)
     */
    async cleanup(hardDelete: boolean = true): Promise<void> {
        for (const entity of this.entities) {
            try {
                if (entity._persisted) {
                    await entity.delete(hardDelete);
                }
            } catch {
                // Ignore cleanup errors - entity may already be deleted
            }
        }
        this.entities = [];
    }

    /**
     * Get count of tracked entities
     */
    get count(): number {
        return this.entities.length;
    }

    /**
     * Get all tracked entities
     */
    get all(): Entity[] {
        return [...this.entities];
    }
}
