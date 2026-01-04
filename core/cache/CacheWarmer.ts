import { CacheManager } from './CacheManager.js';
import { SchedulerManager } from '../SchedulerManager.js';

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

    console.log(`Starting entity cache warming for ${entityIds.length} ${entityType} entities`);

    // Process entities in batches to avoid overwhelming the database
    const batchSize = 10;
    for (let i = 0; i < entityIds.length; i += batchSize) {
      const batch = entityIds.slice(i, i + batchSize);

      try {
        // Load entities (this will populate the cache via write-through strategy)
        const entities = await this.loadEntitiesBatch(batch, entityType);
        warmed += entities.length;
      } catch (error) {
        console.warn(`Failed to warm batch of entities:`, error);
        failed += batch.length;
      }

      // Small delay between batches to prevent database overload
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const duration = Date.now() - startTime;
    console.log(`Entity cache warming completed: ${warmed} warmed, ${failed} failed in ${duration}ms`);

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
      console.log(`Cache warming job "${config.name}" is disabled`);
      return;
    }

    // Cancel existing job if it exists
    this.cancelWarming(config.name);

    const job = this.scheduler.scheduleJob(config.name, config.cronExpression, async () => {
      try {
        console.log(`Running scheduled cache warming: ${config.name}`);

        if (config.type === 'entity') {
          await this.warmEntityCache(config.config.entityIds, config.config.entityType);
        }
      } catch (error) {
        console.error(`Scheduled cache warming failed for "${config.name}":`, error);
      }
    });

    this.warmingJobs.set(config.name, job);
    console.log(`Scheduled cache warming job "${config.name}" with cron: ${config.cronExpression}`);
  }

  /**
   * Cancels a scheduled warming job
   */
  cancelWarming(name: string): boolean {
    const job = this.warmingJobs.get(name);
    if (job) {
      job.cancel();
      this.warmingJobs.delete(name);
      console.log(`Cancelled cache warming job: ${name}`);
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

    // Warm entities
    const entityResults = config.entities ?
      await this.warmEntityCache(config.entities[0].entityIds, config.entities[0].entityType) :
      { success: true, warmed: 0, failed: 0, duration: 0 };

    const totalDuration = Date.now() - startTime;

    return {
      entities: entityResults,
      totalDuration
    };
  }

  /**
   * Loads a batch of entities (placeholder - would need actual entity loading logic)
   */
  private async loadEntitiesBatch(entityIds: string[], entityType: string): Promise<any[]> {
    // This is a placeholder - in a real implementation, this would load entities
    // from the database using the appropriate entity manager or query system
    console.log(`Loading batch of ${entityIds.length} ${entityType} entities: ${entityIds.slice(0, 3).join(', ')}...`);

    // Simulate loading delay
    await new Promise(resolve => setTimeout(resolve, 10));

    // Return mock entities - in real implementation, this would be actual entity data
    return entityIds.map(id => ({ id, type: entityType, loaded: true }));
  }
}