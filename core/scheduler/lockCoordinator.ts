import type { DistributedLockConfig } from "./DistributedLock";
import type { SchedulerManager } from "../SchedulerManager";

export function getDistributedLockInfo(manager: SchedulerManager): {
    enabled: boolean;
    heldLocks: number;
    config: DistributedLockConfig;
} {
    return {
        enabled: manager.config.distributedLocking !== false,
        heldLocks: manager.distributedLock.getHeldLockCount(),
        config: manager.distributedLock.getConfig(),
    };
}

export function isDistributedLockingEnabled(manager: SchedulerManager): boolean {
    return manager.config.distributedLocking !== false;
}

export function syncLockConfig(manager: SchedulerManager): void {
    manager.distributedLock.updateConfig({
        enabled: manager.config.distributedLocking ?? true,
        enableLogging: manager.config.enableLogging,
        lockTimeout: manager.config.lockTimeout ?? 0,
        retryInterval: manager.config.lockRetryInterval ?? 100,
    });
}
