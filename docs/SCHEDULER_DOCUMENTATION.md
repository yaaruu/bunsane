# BunSane System Scheduler Documentation

## Overview

The BunSane System Scheduler provides a powerful and flexible way to run tasks at specified intervals or on a cron schedule. It is deeply integrated with the Entity-Component-System (ECS) architecture, allowing tasks to efficiently query and process entities. The scheduler is designed for enterprise-grade applications, offering advanced features like timeout enforcement, automatic retries, task prioritization, and comprehensive metrics.

## Key Features

- **Declarative Scheduling**: Use the `@ScheduledTask` decorator to easily turn any service method into a scheduled task.
- **Flexible Scheduling**: Supports fixed intervals (minute, hour, day, week, month) and cron expressions.
- **ECS Integration**: Tasks can automatically query for entities with specific components.
- **Advanced Filtering**: Target entities using complex `Query` filters.
- **Task Timeouts**: Prevent long-running tasks from blocking the scheduler.
- **Automatic Retries**: Automatically retry failed tasks with configurable delays.
- **Task Prioritization**: Ensure critical tasks are executed first.
- **Resource Management**: Limit the number of entities processed per execution.
- **Comprehensive Metrics**: Monitor scheduler and task performance with detailed metrics.
- **Lifecycle Management**: Automatically starts and stops with the application.

## Quick Start: Using the `@ScheduledTask` Decorator

The easiest way to create a scheduled task is by using the `@ScheduledTask` decorator on a method within a `Service`.

### 1. Create a Service Method

Define a method in your service that accepts an array of `Entity` objects.

```typescript
// src/services/MaintenanceService.ts
import { BaseService, Entity, ScheduledTask, ScheduleInterval } from "bunsane";
import { UserComponent } from "../components/UserComponent";

export class MaintenanceService extends BaseService {

    @ScheduledTask({
        id: "cleanup-inactive-users",
        name: "Inactive User Cleanup",
        interval: ScheduleInterval.DAILY,
        componentTarget: UserComponent
    })
    async cleanupInactiveUsers(entities: Entity[]) {
        console.log(`Found ${entities.length} inactive users to process.`);
        for (const entity of entities) {
            // Add your cleanup logic here
            // e.g., await entity.delete();
        }
    }
}
```

### 2. Register the Service

Ensure your service is registered with the `ServiceRegistry` in your application's entry point.

```typescript
// index.ts
import { App, ServiceRegistry } from "bunsane";
import { MaintenanceService } from "./src/services/MaintenanceService";

export default class MyApp extends App {
    constructor() {
        super();
        const maintenanceService = new MaintenanceService();
        ServiceRegistry.registerService(maintenanceService);
    }
}
```

That's it! The `cleanupInactiveUsers` method will now run once daily, querying for all entities that have a `UserComponent`.

## Advanced Usage and Options

The `@ScheduledTask` decorator and the `SchedulerManager` support a wide range of options for fine-grained control.

### Advanced Scheduling Options

You can pass a `ScheduleTaskOptions` object to the decorator to customize its behavior.

```typescript
@ScheduledTask({
    id: "premium-user-report",
    name: "Premium User Report",
    interval: ScheduleInterval.CRON,
    cronExpression: "0 9 * * 1", // Every Monday at 9 AM
    componentTarget: UserComponent,
    options: {
        priority: 10, // High priority
        timeout: 60000, // 1 minute timeout
        maxRetries: 3,
        retryDelay: 10000, // 10 seconds
        maxEntitiesPerExecution: 500,
        componentFilters: [
            Query.filter("isPremium", Query.filterOp.EQ, true)
        ]
    }
})
async generatePremiumReport(entities: Entity[]) {
    // ... logic to generate report for premium users
}
```

### Available Options (`ScheduledTaskOptions`)

| Option                    | Type                               | Description                                                                                             |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `priority`                | `number`                           | Sets the task priority. Higher numbers execute first. Default is `0`.                                   |
| `timeout`                 | `number`                           | Execution timeout in milliseconds. If the task exceeds this, it will be terminated.                     |
| `maxRetries`              | `number`                           | The maximum number of times to retry a failed task. Default is `0`.                                     |
| `retryDelay`              | `number`                           | The delay in milliseconds between retry attempts.                                                       |
| `maxEntitiesPerExecution` | `number`                           | Limits the number of entities passed to the task in a single execution.                                 |
| `componentFilters`        | `QueryFilter[]`                    | An array of `Query.filter()` objects to apply when querying for entities.                               |
| `runOnStart`              | `boolean`                          | If `true`, the task will run once immediately when the scheduler starts.                                |
| `enableLogging`           | `boolean`                          | Enables detailed logging for this specific task.                                                        |

## Manual Task Management

For dynamic scenarios, you can interact with the `SchedulerManager` directly.

```typescript
import { SchedulerManager, ScheduleInterval } from "bunsane";
import { UserComponent } from "../components/UserComponent";

const scheduler = SchedulerManager.getInstance();
const myService = new MyService();

// Register a task manually
scheduler.registerTask({
    id: "manual-task-1",
    name: "My Manual Task",
    componentTarget: UserComponent,
    interval: ScheduleInterval.MINUTE,
    service: myService,
    methodName: "myTaskMethod",
    options: {
        priority: 5
    }
});

// Manually execute a task now
await scheduler.executeTaskNow("manual-task-1");

// Disable a task
scheduler.disableTask("manual-task-1");

// Enable it again
scheduler.enableTask("manual-task-1");
```

## Metrics and Monitoring

The scheduler collects detailed metrics for monitoring and debugging.

```typescript
import { SchedulerManager } from "bunsane";

const scheduler = SchedulerManager.getInstance();

// Get global scheduler metrics
const globalMetrics = scheduler.getMetrics();
console.log(globalMetrics);
/*
{
  totalTasks: 5,
  runningTasks: 1,
  completedExecutions: 102,
  failedExecutions: 3,
  averageExecutionTime: 15.4,
  timedOutTasks: 1,
  retriedTasks: 5,
  taskMetrics: { ... }
}
*/

// Get metrics for a specific task
const taskMetrics = scheduler.getTaskMetrics("my-task-id");
console.log(taskMetrics);
/*
{
  taskId: 'my-task-id',
  taskName: 'My Task',
  totalExecutions: 20,
  successfulExecutions: 18,
  failedExecutions: 2,
  averageExecutionTime: 25.1,
  totalEntitiesProcessed: 1800,
  retryCount: 3,
  timeoutCount: 1
}
*/
```

## Configuration

Global scheduler behavior can be configured by calling `updateConfig` on the `SchedulerManager` instance, typically during application startup.

```typescript
import { SchedulerManager } from "bunsane";

const scheduler = SchedulerManager.getInstance();

scheduler.updateConfig({
    enabled: true,
    maxConcurrentTasks: 10,      // Default: 5
    defaultTimeout: 60000,       // Default: 30000 (30s)
    enableLogging: true,
    runOnStart: false
});
```

## State Persistence and Application Restarts

### Current Behavior

**The BunSane Scheduler does NOT persist state across application restarts.** All scheduler state is stored in memory only and is lost when the application shuts down.

#### What Gets Lost on Restart:
- **Registered Tasks**: All tasks must be re-registered
- **Execution Metrics**: All metrics (execution counts, timing, failures) are reset to zero
- **Running State**: Scheduler starts in stopped state
- **Active Timers**: All scheduled intervals and timeouts are cleared
- **Task Configuration**: Custom task settings are lost

#### What Persists:
- **Task Definitions**: The `@ScheduledTask` decorators and task configurations in your code
- **Service Instances**: Your services are re-instantiated on startup

### Recommended Startup Pattern

To ensure tasks are properly registered on application restart, implement this pattern in your main application file:

```typescript
// index.ts
import { App, ServiceRegistry, SchedulerManager } from "bunsane";
import { MaintenanceService } from "./src/services/MaintenanceService";
import { registerScheduledTasks } from "bunsane";

export default class MyApp extends App {
    constructor() {
        super();

        // Register services
        const maintenanceService = new MaintenanceService();
        ServiceRegistry.registerService(maintenanceService);

        // IMPORTANT: Register scheduled tasks after service registration
        registerScheduledTasks(maintenanceService);

        // Optionally start the scheduler
        const scheduler = SchedulerManager.getInstance();
        scheduler.start();
    }
}
```

### State Persistence Solutions

If you need state persistence, consider these approaches:

#### 1. Database-Backed Metrics (Recommended)
```typescript
// Create a service to persist metrics
class MetricsPersistenceService extends BaseService {
    @ScheduledTask(ScheduleInterval.MINUTE, UserComponent, {
        id: "persist-metrics",
        name: "Persist Scheduler Metrics"
    })
    async persistSchedulerMetrics(entities: Entity[]) {
        const scheduler = SchedulerManager.getInstance();
        const metrics = scheduler.getMetrics();

        // Save metrics to database
        await this.saveMetricsToDatabase(metrics);
    }
}
```

#### 2. Configuration File for Task State
```typescript
// Load task enabled/disabled state from config
class TaskStateManager {
    static async loadTaskStates(): Promise<Record<string, boolean>> {
        // Load from JSON file or database
        return await this.loadFromStorage();
    }

    static async saveTaskStates(states: Record<string, boolean>): Promise<void> {
        // Save to JSON file or database
        await this.saveToStorage(states);
    }
}
```

#### 3. Custom Scheduler with Persistence
```typescript
class PersistentSchedulerManager extends SchedulerManager {
    private persistenceService: MetricsPersistenceService;

    constructor(persistenceService: MetricsPersistenceService) {
        super();
        this.persistenceService = persistenceService;
    }

    async start(): Promise<void> {
        // Load previous state
        await this.loadPersistedState();
        super.start();
    }

    async stop(): Promise<void> {
        // Save current state
        await this.persistCurrentState();
        super.stop();
    }
}
```

### Best Practices for Production

1. **Explicit Task Registration**: Always call `registerScheduledTasks()` in your application startup
2. **Graceful Shutdown**: Ensure scheduler is properly stopped during application shutdown
3. **Health Checks**: Implement health checks to verify scheduled tasks are running
4. **Monitoring**: Use metrics to monitor task execution and detect failures
5. **Configuration Management**: Store task configurations in external config files

### Example: Production-Ready Startup

```typescript
// production-startup.ts
import { App, ServiceRegistry, SchedulerManager } from "bunsane";
import { MaintenanceService, ReportService, CleanupService } from "./services";
import { registerScheduledTasks } from "bunsane";

export default class ProductionApp extends App {
    constructor() {
        super();

        // Register all services
        const services = [
            new MaintenanceService(),
            new ReportService(),
            new CleanupService()
        ];

        services.forEach(service => {
            ServiceRegistry.registerService(service);
            registerScheduledTasks(service);
        });

        // Configure scheduler for production
        const scheduler = SchedulerManager.getInstance();
        scheduler.updateConfig({
            maxConcurrentTasks: 20,
            defaultTimeout: 300000, // 5 minutes
            enableLogging: true,
            runOnStart: true
        });

        // Start scheduler
        scheduler.start();

        // Graceful shutdown handling
        process.on('SIGTERM', async () => {
            console.log('Shutting down scheduler...');
            scheduler.stop();
            await this.shutdown();
        });
    }
}
```