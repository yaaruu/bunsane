import { CacheManager } from './CacheManager.js';
import { SchedulerManager } from '../SchedulerManager.js';
import { Entity } from '../Entity.js';
import { logger } from '../Logger.js';

/**
 * CacheWarmer preloads frequently accessed data into the cache to improve
 * application startup performance and reduce initial request latency.
 *
 * Features:
 * - Preloading of frequently accessed entities
 * - Scheduled cache warming with cron support
 * - Configurable warming strategies
 * - Performance monitoring during warming
 */
export class CacheWarmer {
  private cacheManager: CacheManager;
  private scheduler: SchedulerManager;
  private warmingJobs: Map<string, { cancel: () => void }> = new Map();

  constructor(cacheManager: CacheManager, scheduler: SchedulerManager) {
    this.cacheManager = cacheManager;
    this.scheduler = scheduler;
  }

  /**
   * Warms the cache by preloading frequently accessed entities
   */
  async warmEntityCache(entityIds: string[], entityType: string): Promise<{
    success: boolean;
    warmed: number;
    failed: number;
    duration: number;
  }> {
    const startTime = Date.now();
    let warmed = 0;
    let failed = 0;

    logger.info({ msg: `Starting entity cache warming`, count: entityIds.length, entityType });

    // Process entities in batches to avoid overwhelming the database
    const batchSize = 10;
    for (let i = 0; i < entityIds.length; i += batchSize) {
      const batch = entityIds.slice(i, i + batchSize);

      try {
        // Load entities (this will populate the cache via write-through strategy)
        const entities = await this.loadEntitiesBatch(batch, entityType);
        warmed += entities.length;
      } catch (error) {
        logger.warn({ msg: 'Failed to warm batch of entities', error });
        failed += batch.length;
      }

      // Small delay between batches to prevent database overload
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const duration = Date.now() - startTime;
    logger.info({ msg: 'Entity cache warming completed', warmed, failed, duration });

    return { success: failed === 0, warmed, failed, duration };
  }

  /**
   * Schedules periodic cache warming
   */
  scheduleWarming(config: {
    name: string;
    cronExpression: string;
    type: 'entity';
    config: { entityIds: string[]; entityType: string };
    enabled?: boolean;
  }): void {
    if (!config.enabled) {
      logger.debug({ msg: 'Cache warming job disabled', name: config.name });
      return;
    }

    // Cancel existing job if it exists
    this.cancelWarming(config.name);

    const job = this.scheduler.scheduleJob(config.name, config.cronExpression, async () => {
      try {
        logger.info({ msg: 'Running scheduled cache warming', name: config.name });

        if (config.type === 'entity') {
          await this.warmEntityCache(config.config.entityIds, config.config.entityType);
        }
      } catch (error) {
        logger.error({ msg: 'Scheduled cache warming failed', name: config.name, error });
      }
    });

    this.warmingJobs.set(config.name, job);
    logger.info({ msg: 'Scheduled cache warming job', name: config.name, cron: config.cronExpression });
  }

  /**
   * Cancels a scheduled warming job
   */
  cancelWarming(name: string): boolean {
    const job = this.warmingJobs.get(name);
    if (job) {
      job.cancel();
      this.warmingJobs.delete(name);
      logger.info({ msg: 'Cancelled cache warming job', name });
      return true;
    }
    return false;
  }

  /**
   * Gets list of active warming jobs
   */
  getActiveJobs(): string[] {
    return Array.from(this.warmingJobs.keys());
  }

  /**
   * Performs a comprehensive cache warming operation
   */
  async warmAll(config: {
    entities?: Array<{ entityIds: string[]; entityType: string }>;
  }): Promise<{
    entities: { success: boolean; warmed: number; failed: number; duration: number };
    totalDuration: number;
  }> {
    const startTime = Date.now();

    // Warm all entity groups
    let entityResults = { success: true, warmed: 0, failed: 0, duration: 0 };
    if (config.entities) {
      for (const entry of config.entities) {
        const result = await this.warmEntityCache(entry.entityIds, entry.entityType);
        entityResults.warmed += result.warmed;
        entityResults.failed += result.failed;
        entityResults.duration += result.duration;
        if (!result.success) entityResults.success = false;
      }
    }

    const totalDuration = Date.now() - startTime;

    return {
      entities: entityResults,
      totalDuration
    };
  }

  /**
   * Loads a batch of entities from the database and populates the cache.
   * Uses Entity.FindById to load each entity with all its components,
   * then writes the entity and its components into cache via CacheManager.
   */
  private async loadEntitiesBatch(entityIds: string[], entityType: string): Promise<Entity[]> {
    const loaded: Entity[] = [];

    const results = await Promise.allSettled(
      entityIds.map(id => Entity.FindById(id))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const entity = result.value;
        loaded.push(entity);

        await this.cacheManager.setEntityWriteThrough(entity);
        const components = entity.componentList();
        if (components.length > 0) {
          await this.cacheManager.setComponentWriteThrough(entity.id, components);
        }
      }
    }

    logger.debug({ msg: 'Loaded entity batch', entityType, requested: entityIds.length, loaded: loaded.length });
    return loaded;
  }
}