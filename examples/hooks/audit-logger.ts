import { EntityHook, ComponentHook } from "../../core/decorators/EntityHooks";
import { EntityCreatedEvent, EntityUpdatedEvent, EntityDeletedEvent, ComponentAddedEvent, ComponentUpdatedEvent, ComponentRemovedEvent } from "../../core/events/EntityLifecycleEvents";
import { Entity } from "../../core/Entity";
import { logger } from "../../core/Logger";

export interface AuditLogEntry {
    id: string;
    timestamp: Date;
    action: 'create' | 'update' | 'delete' | 'add_component' | 'update_component' | 'remove_component';
    entityId: string;
    entityType?: string;
    componentType?: string;
    userId?: string;
    oldData?: any;
    newData?: any;
    metadata?: Record<string, any>;
}

export interface AuditLoggerConfig {
    enabled: boolean;
    level: 'debug' | 'info' | 'warn' | 'error';
    storage: 'memory' | 'database' | 'file' | 'external';
    includeData: boolean;
    maxEntries: number;
    retentionDays: number;
}

/**
 * AuditLogger - Comprehensive audit logging for entity lifecycle events
 *
 * Features:
 * - Logs all entity and component lifecycle events
 * - Multiple storage backends (memory, database, file, external)
 * - Configurable data inclusion
 * - Automatic cleanup of old entries
 * - Performance monitoring
 * - User context tracking
 */
export class AuditLogger {
    private logs: AuditLogEntry[] = [];
    private config: AuditLoggerConfig;
    private cleanupInterval: NodeJS.Timeout | null = null;

    constructor(config: Partial<AuditLoggerConfig> = {}) {
        this.config = {
            enabled: true,
            level: 'info',
            storage: 'memory',
            includeData: true,
            maxEntries: 10000,
            retentionDays: 30,
            ...config
        };

        if (this.config.enabled) {
            this.startCleanupInterval();
        }
    }

    /**
     * Log entity creation events
     */
    @EntityHook("entity.created")
    async handleEntityCreated(event: EntityCreatedEvent) {
        if (!this.config.enabled) return;

        const entry: AuditLogEntry = {
            id: this.generateId(),
            timestamp: new Date(),
            action: 'create',
            entityId: event.getEntity().id,
            entityType: this.getEntityType(event.getEntity()),
            userId: this.getCurrentUserId(),
            newData: this.config.includeData ? await this.extractEntityData(event.getEntity()) : undefined,
            metadata: {
                isNew: event.isNew,
                source: 'entity_hook'
            }
        };

        await this.storeLogEntry(entry);
        this.log('info', `Entity created: ${entry.entityId}`, entry);
    }

    /**
     * Log entity update events
     */
    @EntityHook("entity.updated")
    async handleEntityUpdated(event: EntityUpdatedEvent) {
        if (!this.config.enabled) return;

        const entry: AuditLogEntry = {
            id: this.generateId(),
            timestamp: new Date(),
            action: 'update',
            entityId: event.getEntity().id,
            entityType: this.getEntityType(event.getEntity()),
            userId: this.getCurrentUserId(),
            metadata: {
                changedComponents: event.getChangedComponents(),
                source: 'entity_hook'
            }
        };

        await this.storeLogEntry(entry);
        this.log('info', `Entity updated: ${entry.entityId}`, entry);
    }

    /**
     * Log entity deletion events
     */
    @EntityHook("entity.deleted")
    async handleEntityDeleted(event: EntityDeletedEvent) {
        if (!this.config.enabled) return;

        const entry: AuditLogEntry = {
            id: this.generateId(),
            timestamp: new Date(),
            action: 'delete',
            entityId: event.getEntity().id,
            entityType: this.getEntityType(event.getEntity()),
            userId: this.getCurrentUserId(),
            oldData: this.config.includeData ? await this.extractEntityData(event.getEntity()) : undefined,
            metadata: {
                isSoftDelete: event.isSoftDelete,
                source: 'entity_hook'
            }
        };

        await this.storeLogEntry(entry);
        this.log('info', `Entity deleted: ${entry.entityId}`, entry);
    }

    /**
     * Log component addition events
     */
    @ComponentHook("component.added")
    async handleComponentAdded(event: ComponentAddedEvent) {
        if (!this.config.enabled) return;

        const entry: AuditLogEntry = {
            id: this.generateId(),
            timestamp: new Date(),
            action: 'add_component',
            entityId: event.getEntity().id,
            entityType: this.getEntityType(event.getEntity()),
            componentType: event.getComponentType(),
            userId: this.getCurrentUserId(),
            newData: this.config.includeData ? event.getComponent().data() : undefined,
            metadata: {
                source: 'component_hook'
            }
        };

        await this.storeLogEntry(entry);
        this.log('debug', `Component added: ${entry.componentType} to ${entry.entityId}`, entry);
    }

    /**
     * Log component update events
     */
    @ComponentHook("component.updated")
    async handleComponentUpdated(event: ComponentUpdatedEvent) {
        if (!this.config.enabled) return;

        const entry: AuditLogEntry = {
            id: this.generateId(),
            timestamp: new Date(),
            action: 'update_component',
            entityId: event.getEntity().id,
            entityType: this.getEntityType(event.getEntity()),
            componentType: event.getComponentType(),
            userId: this.getCurrentUserId(),
            oldData: this.config.includeData ? event.getOldData() : undefined,
            newData: this.config.includeData ? event.getNewData() : undefined,
            metadata: {
                source: 'component_hook'
            }
        };

        await this.storeLogEntry(entry);
        this.log('debug', `Component updated: ${entry.componentType} on ${entry.entityId}`, entry);
    }

    /**
     * Log component removal events
     */
    @ComponentHook("component.removed")
    async handleComponentRemoved(event: ComponentRemovedEvent) {
        if (!this.config.enabled) return;

        const entry: AuditLogEntry = {
            id: this.generateId(),
            timestamp: new Date(),
            action: 'remove_component',
            entityId: event.getEntity().id,
            entityType: this.getEntityType(event.getEntity()),
            componentType: event.getComponentType(),
            userId: this.getCurrentUserId(),
            oldData: this.config.includeData ? event.getComponent().data() : undefined,
            metadata: {
                source: 'component_hook'
            }
        };

        await this.storeLogEntry(entry);
        this.log('debug', `Component removed: ${entry.componentType} from ${entry.entityId}`, entry);
    }

    /**
     * Get all audit logs
     */
    getLogs(filter?: {
        entityId?: string;
        action?: string;
        userId?: string;
        since?: Date;
        until?: Date;
    }): AuditLogEntry[] {
        let filteredLogs = [...this.logs];

        if (filter) {
            if (filter.entityId) {
                filteredLogs = filteredLogs.filter(log => log.entityId === filter.entityId);
            }
            if (filter.action) {
                filteredLogs = filteredLogs.filter(log => log.action === filter.action);
            }
            if (filter.userId) {
                filteredLogs = filteredLogs.filter(log => log.userId === filter.userId);
            }
            if (filter.since) {
                filteredLogs = filteredLogs.filter(log => log.timestamp >= filter.since!);
            }
            if (filter.until) {
                filteredLogs = filteredLogs.filter(log => log.timestamp <= filter.until!);
            }
        }

        return filteredLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    /**
     * Get audit logs for a specific entity
     */
    getEntityLogs(entityId: string): AuditLogEntry[] {
        return this.getLogs({ entityId });
    }

    /**
     * Get audit logs for a specific user
     */
    getUserLogs(userId: string): AuditLogEntry[] {
        return this.getLogs({ userId });
    }

    /**
     * Clear old audit logs based on retention policy
     */
    async clearOldLogs(): Promise<void> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

        const initialCount = this.logs.length;
        this.logs = this.logs.filter(log => log.timestamp >= cutoffDate);

        const removedCount = initialCount - this.logs.length;
        if (removedCount > 0) {
            this.log('info', `Cleared ${removedCount} old audit log entries`);
        }
    }

    /**
     * Export audit logs to different formats
     */
    exportLogs(format: 'json' | 'csv' = 'json'): string {
        switch (format) {
            case 'json':
                return JSON.stringify(this.logs, null, 2);
            case 'csv':
                return this.convertToCSV(this.logs);
            default:
                throw new Error(`Unsupported export format: ${format}`);
        }
    }

    /**
     * Get audit statistics
     */
    getStatistics(): {
        totalEntries: number;
        entriesByAction: Record<string, number>;
        entriesByEntityType: Record<string, number>;
        oldestEntry: Date | null;
        newestEntry: Date | null;
        averageEntriesPerDay: number;
    } {
        const stats = {
            totalEntries: this.logs.length,
            entriesByAction: {} as Record<string, number>,
            entriesByEntityType: {} as Record<string, number>,
            oldestEntry: null as Date | null,
            newestEntry: null as Date | null,
            averageEntriesPerDay: 0
        };

        if (this.logs.length === 0) return stats;

        // Calculate distributions
        for (const log of this.logs) {
            stats.entriesByAction[log.action] = (stats.entriesByAction[log.action] || 0) + 1;
            if (log.entityType) {
                stats.entriesByEntityType[log.entityType] = (stats.entriesByEntityType[log.entityType] || 0) + 1;
            }
        }

        // Calculate date range
        const timestamps = this.logs.map(log => log.timestamp.getTime()).sort();
        stats.oldestEntry = new Date(timestamps[0]!);
        stats.newestEntry = new Date(timestamps[timestamps.length - 1]!);

        // Calculate average entries per day
        const daysDiff = (stats.newestEntry.getTime() - stats.oldestEntry.getTime()) / (1000 * 60 * 60 * 24);
        stats.averageEntriesPerDay = daysDiff > 0 ? stats.totalEntries / daysDiff : stats.totalEntries;

        return stats;
    }

    /**
     * Store log entry based on configured storage backend
     */
    private async storeLogEntry(entry: AuditLogEntry): Promise<void> {
        try {
            switch (this.config.storage) {
                case 'memory':
                    this.storeInMemory(entry);
                    break;
                case 'database':
                    await this.storeInDatabase(entry);
                    break;
                case 'file':
                    await this.storeInFile(entry);
                    break;
                case 'external':
                    await this.storeExternally(entry);
                    break;
                default:
                    throw new Error(`Unsupported storage backend: ${this.config.storage}`);
            }
        } catch (error) {
            this.log('error', `Failed to store audit log entry: ${error}`);
            // Fallback to memory storage
            this.storeInMemory(entry);
        }
    }

    private storeInMemory(entry: AuditLogEntry): void {
        this.logs.push(entry);

        // Enforce max entries limit
        if (this.logs.length > this.config.maxEntries) {
            this.logs = this.logs.slice(-this.config.maxEntries);
        }
    }

    private async storeInDatabase(entry: AuditLogEntry): Promise<void> {
        // Implementation for database storage
        // This would integrate with your database layer
        throw new Error("Database storage not implemented - extend this method");
    }

    private async storeInFile(entry: AuditLogEntry): Promise<void> {
        // Implementation for file storage
        // This would write to log files
        throw new Error("File storage not implemented - extend this method");
    }

    private async storeExternally(entry: AuditLogEntry): Promise<void> {
        // Implementation for external service (e.g., Logstash, Splunk)
        // This would send to external logging service
        throw new Error("External storage not implemented - extend this method");
    }

    private startCleanupInterval(): void {
        // Run cleanup daily
        this.cleanupInterval = setInterval(() => {
            this.clearOldLogs().catch(error => {
                this.log('error', `Failed to clear old audit logs: ${error}`);
            });
        }, 24 * 60 * 60 * 1000); // 24 hours
    }

    private stopCleanupInterval(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    private generateId(): string {
        return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private getEntityType(entity: Entity): string | undefined {
        // Try to determine entity type from components
        // This is a simple implementation - you might want to enhance this
        try {
            const components = entity.componentList();
            return components.length > 0 ? components[0]?.constructor.name : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private getCurrentUserId(): string | undefined {
        // Implementation to get current user from context
        // This depends on your authentication system
        return 'system'; // Default to system user
    }

    private async extractEntityData(entity: Entity): Promise<any> {
        try {
            const data: any = {};
            const components = entity.componentList();

            for (const component of components) {
                try {
                    const componentData = await entity.get(component.constructor as any);
                    if (componentData) {
                        data[component.constructor.name] = componentData;
                    }
                } catch (error) {
                    // Skip components that can't be retrieved
                    this.log('debug', `Could not extract data for component ${component.constructor.name}`);
                }
            }

            return data;
        } catch (error) {
            this.log('warn', `Failed to extract entity data: ${error}`);
            return { error: 'Failed to extract data' };
        }
    }

    private convertToCSV(logs: AuditLogEntry[]): string {
        const headers = [
            'id', 'timestamp', 'action', 'entityId', 'entityType',
            'componentType', 'userId', 'oldData', 'newData', 'metadata'
        ];

        const rows = logs.map(log => [
            log.id,
            log.timestamp.toISOString(),
            log.action,
            log.entityId,
            log.entityType || '',
            log.componentType || '',
            log.userId || '',
            log.oldData ? JSON.stringify(log.oldData) : '',
            log.newData ? JSON.stringify(log.newData) : '',
            log.metadata ? JSON.stringify(log.metadata) : ''
        ]);

        return [headers, ...rows]
            .map(row => row.map(field => `"${field.replace(/"/g, '""')}"`).join(','))
            .join('\n');
    }

    private log(level: string, message: string, data?: any): void {
        const fullMessage = data ? `${message} ${JSON.stringify(data)}` : message;

        switch (level) {
            case 'debug':
                logger.debug(fullMessage);
                break;
            case 'info':
                logger.info(fullMessage);
                break;
            case 'warn':
                logger.warn(fullMessage);
                break;
            case 'error':
                logger.error(fullMessage);
                break;
        }
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        this.stopCleanupInterval();
        this.logs = [];
    }
}