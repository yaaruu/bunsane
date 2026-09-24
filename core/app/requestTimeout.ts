import type { RequestStats } from "../RequestContext";
import { logger as MainLogger } from "../Logger";

const logger = MainLogger.child({ scope: "App" });

export type BoundRequest = {
    req: Request;
    /** Idempotent. Clears the wall-clock timer if one was armed. */
    cancel: () => void;
    /** True when a timeout signal was attached (Request was cloned). */
    attached: boolean;
};

function combineSignals(signals: AbortSignal[]): AbortSignal {
    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any(signals);
    }
    const controller = new AbortController();
    for (const signal of signals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            return controller.signal;
        }
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

/**
 * Arm a wall-clock abort only when a timeout must be attached.
 * Skips the timer and the Request clone for /health, /health/ready, and
 * timeout 0. Subscriptions are not special-cased: Yoga returns the streaming
 * Response immediately and the caller cancels the timer then.
 */
export function bindRequestTimeout(
    req: Request,
    timeoutMs: number,
    pathname: string,
): BoundRequest {
    if (!(timeoutMs > 0) || pathname === "/health" || pathname === "/health/ready") {
        return { req, cancel() {}, attached: false };
    }

    const method = req.method;
    const controller = new AbortController();
    const combined = combineSignals([req.signal, controller.signal]);
    const cloned = new Request(req, { signal: combined });
    const timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timeout after ${timeoutMs}ms: ${method} ${pathname}`));
        // Attached later by the GraphQL request-context plugin onto the request Yoga sees.
        const tracked = cloned as Request & { __bunsaneStats?: RequestStats };
        const stats = tracked.__bunsaneStats;
        logger.warn({
            scope: "App",
            method,
            path: pathname,
            operationName: stats?.operationName,
            dataLoaderCalls: stats?.dataLoaderCalls,
            dbQueryCount: stats?.dbQueryCount,
            msg: "Request timeout",
        }, `Request timeout: ${method} ${pathname}`);
    }, timeoutMs);
    timeoutId.unref?.();

    return {
        req: cloned,
        cancel() { clearTimeout(timeoutId); },
        attached: true,
    };
}
