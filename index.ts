import App from "./core/App";
import ServiceRegistry from "./service/ServiceRegistry";
import BaseService from "./service/Service";
import { Component, CompData, BaseComponent } from "./core/Components";
import { Entity } from "./core/Entity";
import ArcheType from "./core/ArcheType";
import Query from "./core/Query";
import {logger} from "./core/Logger";
import { handleGraphQLError, responseError } from "./core/ErrorHandler";
import { type Plugin } from "graphql-yoga";
import { BatchLoader } from "core/BatchLoader";
import { createRequestContextPlugin } from "./core/RequestContext";
import type { RequestLoaders } from "./core/RequestLoaders";
import BasePlugin from "./plugins";
// Hook system exports
import EntityHookManager from "./core/EntityHookManager";
import {
    EntityHook,
    ComponentHook,
    LifecycleHook,
    ComponentTargetHook,
    registerDecoratedHooks
} from "./core/decorators/EntityHooks";
import type {
    EntityHookCallback,
    ComponentHookCallback,
    LifecycleHookCallback,
    HookOptions,
    ComponentTargetConfig
} from "./core/EntityHookManager";
import type {
    EntityLifecycleEvent,
    EntityCreatedEvent,
    EntityUpdatedEvent,
    EntityDeletedEvent,
    ComponentLifecycleEvent,
    ComponentAddedEvent,
    ComponentUpdatedEvent,
    ComponentRemovedEvent
} from "./core/events/EntityLifecycleEvents";
import { ScheduledTask } from "core/decorators/ScheduledTask";
import { ScheduleInterval } from "types/scheduler.types";
// Swagger exports
import { ApiDocs, ApiTags } from "./swagger";

export { 
    App, 
    ArcheType,
    ServiceRegistry,
    BaseService,
    BaseComponent,
    Component,
    CompData,
    Entity,
    BatchLoader,

    Query,

    // Scheduler exports
    ScheduleInterval,
    ScheduledTask,

    // Swagger exports
    ApiDocs,
    ApiTags,

    logger,

    BasePlugin,
    type Plugin,

    responseError,
    handleGraphQLError,

    createRequestContextPlugin,
    type RequestLoaders,

    // Hook system exports
    EntityHookManager,
    EntityHook,
    ComponentHook,
    LifecycleHook,
    ComponentTargetHook,
    registerDecoratedHooks,
    type EntityHookCallback,
    type ComponentHookCallback,
    type LifecycleHookCallback,
    type HookOptions,
    type ComponentTargetConfig,
    type EntityLifecycleEvent,
    type EntityCreatedEvent,
    type EntityUpdatedEvent,
    type EntityDeletedEvent,
    type ComponentLifecycleEvent,
    type ComponentAddedEvent,
    type ComponentUpdatedEvent,
    type ComponentRemovedEvent
};
