import * as path from "path";
import { logger as MainLogger } from "../Logger";
import { getMetadataScript } from "../metadata";
import { isVerboseErrors } from "../envMode";
import { addCorsHeaders, getCorsHeaders } from "./cors";
import type { CorsConfig } from "../App";
import {
    handleHealth,
    handleReady,
    handleRemoteHealth,
} from "./healthEndpoints";
import { routeStudio } from "./studioRouter";
import { getDbStats } from "../../database/instrumentedDb";
import { isPoolAcquisitionError } from "../../database/poolErrors";
import { isAdmissionTimeout } from "../../database/gateway";
import type { RequestStats } from "../RequestContext";
import { rejectOversizedBody, type BodyLimits } from "./bodyLimit";
import { bindRequestTimeout } from "./requestTimeout";
import { authorizeInfo } from "./infoAccess";
import type { InfoAccess } from "./limits";
import { DOCS_CSP, STUDIO_CSP, documentGuardHeaders } from "../middleware/SecurityHeaders";
import { setResponseHeaders } from "../middleware/headers";
import { docsHtml, SWAGGER_INIT_JS } from "../../swagger/docsPage";

const logger = MainLogger.child({ scope: "App" });

export type RestEndpoint = {
    method: string;
    path: string;
    handler: Function;
    regex?: RegExp;
    service?: unknown;
};

/**
 * The slice of App the router reads. Private fields are visible at runtime;
 * App casts itself to this interface so the router is not `app: any`.
 */
export interface RequestHost {
    config: { cors?: CorsConfig };
    name: string;
    openAPISpecGenerator: { toJSON(): string } | null;
    studioEnabled: boolean;
    studioAssetsPath: string | null;
    studioIndexHtml: string | null;
    staticAssets: Map<string, string>;
    restEndpointMap: Map<string, RestEndpoint>;
    restEndpoints: RestEndpoint[];
    yoga: ((req: Request) => Promise<Response>) | null | undefined;
    isReady: boolean;
    isShuttingDown: boolean;
    requestTimeoutMs: number;
    jsonBodyLimit: number;
    multipartBodyLimit: number;
    metricsAccess: InfoAccess;
    docsAccess: InfoAccess;
    collectMetrics(): Promise<unknown>;
    remote: { health(): Promise<{ healthy: boolean }> } | null;
}

function poolExhaustedResponse(): Response {
    return new Response(
        JSON.stringify({
            error: "Service temporarily unavailable",
            code: "POOL_EXHAUSTED",
        }),
        {
            status: 503,
            headers: {
                "Content-Type": "application/json",
                "Retry-After": "1",
            },
        },
    );
}

function bodyLimitsOf(app: RequestHost): BodyLimits {
    return { json: app.jsonBodyLimit, multipart: app.multipartBodyLimit };
}

async function loadStudioIndex(app: RequestHost): Promise<string | null> {
    if (app.studioIndexHtml) return app.studioIndexHtml;
    if (!app.studioAssetsPath) return null;
    const indexPath = path.join(app.studioAssetsPath, "index.html");
    const file = Bun.file(indexPath);
    if (!(await file.exists())) return null;
    const html = (await file.text()).replace("</head>", `${getMetadataScript()}</head>`);
    app.studioIndexHtml = html;
    return html;
}

function isStudioShell(pathname: string): boolean {
    if (pathname === "/studio" || pathname === "/studio/") return true;
    if (pathname.startsWith("/studio/api/") || pathname.startsWith("/studio/assets/")) return false;
    const rest = pathname.slice("/studio/".length);
    return rest.length > 0 && !rest.includes(".");
}

function withDocumentHeaders(response: Response, csp: string): Response {
    return setResponseHeaders(response, documentGuardHeaders(csp));
}

export async function handleRequest(app: RequestHost, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const startTime = Date.now();

    if (method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: getCorsHeaders(app.config.cors, req),
        });
    }

    const cors = app.config.cors;
    const wrap = (response: Response) => addCorsHeaders(response, cors, req);

    const tooBig = rejectOversizedBody(req, bodyLimitsOf(app));
    if (tooBig) return wrap(tooBig);

    const bound = bindRequestTimeout(req, app.requestTimeoutMs, url.pathname);
    req = bound.req;

    try {
        if (url.pathname === "/health") {
            return wrap(await handleHealth(app));
        }

        if (url.pathname === "/health/ready") {
            return wrap(await handleReady(app));
        }

        if (url.pathname === "/metrics") {
            const denied = authorizeInfo(app.metricsAccess, req, "x-metrics-token");
            if (denied) return wrap(denied);
            const metrics = await app.collectMetrics();
            return wrap(new Response(JSON.stringify(metrics), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }));
        }

        if (url.pathname === "/health/remote") {
            const denied = authorizeInfo(app.metricsAccess, req, "x-metrics-token");
            if (denied) return wrap(denied);
            return wrap(await handleRemoteHealth(app));
        }

        if (url.pathname === "/docs/swagger-init.js") {
            const denied = authorizeInfo(app.docsAccess, req, "x-docs-token");
            if (denied) return wrap(denied);
            return wrap(new Response(SWAGGER_INIT_JS, {
                headers: {
                    "Content-Type": "text/javascript; charset=utf-8",
                    "Cache-Control": "public, max-age=3600",
                },
            }));
        }

        if (url.pathname === "/openapi.json") {
            const denied = authorizeInfo(app.docsAccess, req, "x-docs-token");
            if (denied) return wrap(denied);
            return wrap(new Response(app.openAPISpecGenerator!.toJSON(), {
                headers: { "Content-Type": "application/json" },
            }));
        }

        if (url.pathname === "/docs") {
            const denied = authorizeInfo(app.docsAccess, req, "x-docs-token");
            if (denied) return wrap(denied);
            return wrap(withDocumentHeaders(new Response(docsHtml(app.name), {
                headers: { "Content-Type": "text/html" },
            }), DOCS_CSP));
        }

        if (
            !app.studioEnabled &&
            (url.pathname === "/studio" || url.pathname.startsWith("/studio/"))
        ) {
            return wrap(new Response(
                JSON.stringify({ error: "Not found" }),
                { status: 404, headers: { "Content-Type": "application/json" } },
            ));
        }

        const studioApiResponse = await routeStudio(app, url, req, method);
        if (studioApiResponse) {
            return wrap(studioApiResponse);
        }

        if (
            app.studioEnabled &&
            (url.pathname === "/studio" || url.pathname.startsWith("/studio/"))
        ) {
            if (url.pathname.startsWith("/studio/api/")) {
                return wrap(new Response(
                    JSON.stringify({ error: "Studio API endpoint not found" }),
                    { status: 404, headers: { "Content-Type": "application/json" } },
                ));
            }

            if (isStudioShell(url.pathname)) {
                const html = await loadStudioIndex(app);
                if (html) {
                    return wrap(withDocumentHeaders(new Response(html, {
                        headers: { "Content-Type": "text/html" },
                    }), STUDIO_CSP));
                }
                return wrap(new Response(
                    "Studio not built. Run `bun run build:studio` to build the studio.",
                    { status: 404, headers: { "Content-Type": "text/plain" } },
                ));
            }
        }

        for (const [route, folder] of app.staticAssets) {
            if (!url.pathname.startsWith(route)) continue;
            const rawRelative = url.pathname.slice(route.length);
            let decodedRelative: string;
            try {
                decodedRelative = decodeURIComponent(rawRelative);
            } catch {
                return wrap(new Response("Bad request", {
                    status: 400,
                    headers: { "Content-Type": "text/plain" },
                }));
            }
            const relForResolve = decodedRelative.replace(/^[/\\]+/, "");
            const resolvedBase = path.resolve(folder);
            const resolvedFile = path.resolve(resolvedBase, relForResolve);
            if (
                resolvedFile !== resolvedBase &&
                !resolvedFile.startsWith(resolvedBase + path.sep)
            ) {
                return wrap(new Response("Forbidden", {
                    status: 403,
                    headers: { "Content-Type": "text/plain" },
                }));
            }
            try {
                const file = Bun.file(resolvedFile);
                if (await file.exists()) {
                    return wrap(new Response(file));
                }
            } catch (error) {
                logger.error({ err: error, path: resolvedFile }, `Error serving static file ${resolvedFile}`);
            }
        }

        const endpointKey = `${method}:${url.pathname}`;
        let endpoint = app.restEndpointMap.get(endpointKey);

        if (!endpoint) {
            for (const ep of app.restEndpoints) {
                if (!ep.regex || ep.method !== method) continue;
                if (ep.regex.test(url.pathname)) {
                    endpoint = ep;
                    break;
                }
            }
        }

        if (endpoint) {
            try {
                const result = await endpoint.handler(req);
                const duration = Date.now() - startTime;
                logger.trace(`REST ${method} ${url.pathname} completed in ${duration}ms`);

                if (result instanceof Response) {
                    return wrap(result);
                }
                return wrap(new Response(JSON.stringify(result), {
                    headers: { "Content-Type": "application/json" },
                }));
            } catch (error) {
                const duration = Date.now() - startTime;
                logger.error(
                    { err: error, method, path: endpoint.path, duration },
                    `Error in REST endpoint ${method} ${endpoint.path} after ${duration}ms`,
                );
                if (isPoolAcquisitionError(error) || isAdmissionTimeout(error)) {
                    return wrap(poolExhaustedResponse());
                }
                return wrap(new Response(
                    JSON.stringify({
                        error: "Internal server error",
                        code: "INTERNAL_ERROR",
                        ...(isVerboseErrors() && {
                            message: (error as Error)?.message,
                        }),
                    }),
                    { status: 500, headers: { "Content-Type": "application/json" } },
                ));
            }
        }

        if (app.yoga) {
            const response = await app.yoga(req);
            const duration = Date.now() - startTime;
            logger.trace(`GraphQL request completed in ${duration}ms`);
            return wrap(response);
        }

        return wrap(new Response("Not Found", { status: 404 }));
    } catch (error) {
        const duration = Date.now() - startTime;
        const tracked = req as Request & { __bunsaneStats?: RequestStats };
        const stats = tracked.__bunsaneStats;
        logger.error(
            {
                scope: "App",
                method,
                path: url.pathname,
                duration,
                operationName: stats?.operationName,
                dataLoaderCalls: stats?.dataLoaderCalls,
                dbQueryCount: stats?.dbQueryCount,
                dbStats: getDbStats(),
                err: error,
            },
            `Request failed after ${duration}ms: ${method} ${url.pathname}`,
        );

        if ((error as Error).name === "AbortError") {
            return wrap(new Response(
                JSON.stringify({ error: "Request timeout", code: "TIMEOUT_ERROR" }),
                { status: 408, headers: { "Content-Type": "application/json" } },
            ));
        }

        if (isPoolAcquisitionError(error)) {
            return wrap(poolExhaustedResponse());
        }

        return wrap(new Response(
            JSON.stringify({
                error: "Internal server error",
                code: "INTERNAL_ERROR",
                ...(isVerboseErrors() && {
                    message: (error as Error)?.message,
                }),
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
        ));
    } finally {
        bound.cancel();
    }
}
