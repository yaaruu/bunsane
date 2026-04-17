/**
 * Remote Communication: @RemoteEvent + @RemoteRpc decorators
 *
 * Mirrors @ScheduledTask pattern:
 * - Metadata stored on `constructor.__remoteHandlers`
 * - Deduplication by handler id
 * - Service-scoped registration at SYSTEM_READY
 */

import { logger } from "../Logger";
import type { RemoteHandlerInfo } from "./types";
import { getRemoteManager } from "./RemoteManager";

const loggerInstance = logger.child({ scope: "RemoteDecorators" });

export interface RemoteEventOptions {
    event: string;
    id?: string;
}

export interface RemoteRpcOptions {
    event: string;
    id?: string;
}

function pushHandler(
    target: any,
    propertyKey: string,
    options: RemoteEventOptions,
    kind: "event" | "rpc_request"
): void {
    const handlerId = options.id || `${target.constructor.name}.${propertyKey}`;

    if (!target.constructor.__remoteHandlers) {
        target.constructor.__remoteHandlers = [];
    }

    const info: RemoteHandlerInfo = {
        event: options.event,
        methodName: propertyKey,
        handlerId,
        kind,
    };

    const handlers: RemoteHandlerInfo[] = target.constructor.__remoteHandlers;
    const existing = handlers.findIndex((h) => h.handlerId === handlerId);
    if (existing === -1) {
        handlers.push(info);
    } else {
        loggerInstance.warn(
            `Remote handler ${handlerId} already registered on ${target.constructor.name}. Skipping duplicate.`
        );
    }
}

export function RemoteEvent(options: RemoteEventOptions) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        pushHandler(target, propertyKey, options, "event");
        return descriptor;
    };
}

export function RemoteRpc(options: RemoteRpcOptions) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        pushHandler(target, propertyKey, options, "rpc_request");
        return descriptor;
    };
}

export function registerRemoteHandlers(service: any): void {
    const ctor = service.constructor;
    const handlers: RemoteHandlerInfo[] | undefined = ctor.__remoteHandlers;
    if (!handlers || handlers.length === 0) return;

    const manager = getRemoteManager();
    if (!manager) {
        loggerInstance.warn(
            `Remote manager not initialized — skipping remote handler registration for ${ctor.name}`
        );
        return;
    }

    const seen = new Set<string>();
    for (const h of handlers) {
        if (seen.has(h.handlerId)) {
            loggerInstance.warn(
                `Duplicate remote handler id ${h.handlerId}, using first occurrence only`
            );
            continue;
        }
        seen.add(h.handlerId);

        const method = (service as any)[h.methodName];
        if (typeof method !== "function") {
            loggerInstance.warn(
                `Remote handler method ${h.methodName} not found on ${ctor.name}`
            );
            continue;
        }

        if (h.kind === "rpc_request") {
            manager.onRpc(h.event, method.bind(service), h.handlerId);
            loggerInstance.info(
                `Registered RPC handler ${h.handlerId} for event "${h.event}"`
            );
        } else {
            manager.on(h.event, method.bind(service), h.handlerId);
            loggerInstance.info(
                `Registered event handler ${h.handlerId} for event "${h.event}"`
            );
        }
    }
}
