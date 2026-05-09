import * as path from "path";
import { logger as MainLogger } from "../Logger";
import { getSerializedMetadataStorage } from "../metadata";
import { addCorsHeaders, getCorsHeaders } from "./cors";
import {
    handleHealth,
    handleReady,
    handleRemoteHealth,
} from "./healthEndpoints";
import { routeStudio } from "./studioRouter";

const logger = MainLogger.child({ scope: "App" });

function combineSignals(signals: AbortSignal[]): AbortSignal {
    const anyFn = (AbortSignal as any).any;
    if (typeof anyFn === 'function') {
        return anyFn.call(AbortSignal, signals);
    }
    const controller = new AbortController();
    for (const s of signals) {
        if (s.aborted) {
            controller.abort((s as any).reason);
            return controller.signal;
        }
        s.addEventListener('abort', () => controller.abort((s as any).reason), { once: true });
    }
    return controller.signal;
}

export async function handleRequest(app: any, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const startTime = Date.now();

    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: getCorsHeaders(app.config.cors, req),
        });
    }

    // Request timeout — combine framework wall-clock with client abort signal
    // and rebind onto the request so downstream handlers (Yoga, REST) see
    // cancellation propagation (C05).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort(new Error(`Request timeout after 30000ms: ${method} ${url.pathname}`));
        logger.warn(`Request timeout: ${method} ${url.pathname}`);
    }, 30000);
    const combinedSignal = combineSignals([req.signal, controller.signal]);
    req = new Request(req, { signal: combinedSignal });

    const cors = app.config.cors;
    const wrap = (response: Response) => addCorsHeaders(response, cors, req);

    try {
        if (url.pathname === "/health") {
            const response = await handleHealth(app);
            clearTimeout(timeoutId);
            return wrap(response);
        }

        if (url.pathname === "/metrics") {
            const metrics = await app.collectMetrics();
            clearTimeout(timeoutId);
            return wrap(new Response(JSON.stringify(metrics), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }));
        }

        if (url.pathname === "/health/remote") {
            const response = await handleRemoteHealth(app);
            clearTimeout(timeoutId);
            return wrap(response);
        }

        if (url.pathname === "/health/ready") {
            const response = await handleReady(app);
            clearTimeout(timeoutId);
            return wrap(response);
        }

        if (url.pathname === "/openapi.json") {
            clearTimeout(timeoutId);
            return wrap(new Response(app.openAPISpecGenerator!.toJSON(), {
                headers: { "Content-Type": "application/json" },
            }));
        }

        if (url.pathname === "/docs") {
            clearTimeout(timeoutId);
            const swaggerUIHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>${app.name} Documentation</title>
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui.css" />
    <style>
        html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
        *, *:before, *:after { box-sizing: inherit; }
        body { margin: 0; background: #fafafa; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.10.3/swagger-ui-bundle.js"></script>
    <script>
        window.onload = function() {
            const ui = SwaggerUIBundle({
                url: '/openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIBundle.presets.standalone
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: "BaseLayout"
            });
        };
    </script>
</body>
</html>`;
            return wrap(new Response(swaggerUIHTML, {
                headers: { "Content-Type": "text/html" },
            }));
        }

        const studioApiResponse = await routeStudio(app, url, req, method);
        if (studioApiResponse) {
            clearTimeout(timeoutId);
            return wrap(studioApiResponse);
        }

        if (
            app.studioEnabled &&
            (url.pathname === "/studio" || url.pathname.startsWith("/studio/"))
        ) {
            clearTimeout(timeoutId);

            if (url.pathname.startsWith("/studio/api/")) {
                return wrap(new Response(
                    JSON.stringify({ error: "Studio API endpoint not found" }),
                    { status: 404, headers: { "Content-Type": "application/json" } },
                ));
            }

            if (!url.pathname.startsWith("/studio/assets/")) {
                const studioIndexPath = path.join(
                    import.meta.dirname,
                    "..",
                    "..",
                    "studio",
                    "dist",
                    "index.html",
                );
                try {
                    const studioFile = Bun.file(studioIndexPath);
                    if (await studioFile.exists()) {
                        let html = await studioFile.text();
                        const metadata = getSerializedMetadataStorage();
                        const metadataScript = `<script>window.bunsaneMetadata = ${JSON.stringify(metadata)};</script>`;
                        html = html.replace("</head>", `${metadataScript}</head>`);
                        return wrap(new Response(html, {
                            headers: { "Content-Type": "text/html" },
                        }));
                    } else {
                        return wrap(new Response(
                            "Studio not built. Run `bun run build:studio` to build the studio.",
                            { status: 404, headers: { "Content-Type": "text/plain" } },
                        ));
                    }
                } catch (error) {
                    console.log("Error loading studio index.html:", error);
                    return wrap(new Response("Studio not available", {
                        status: 404,
                        headers: { "Content-Type": "text/plain" },
                    }));
                }
            }
        }

        for (const [route, folder] of app.staticAssets) {
            if (url.pathname.startsWith(route)) {
                const relativePath = url.pathname.slice(route.length);
                const filePath = path.join(folder, relativePath);
                try {
                    const file = Bun.file(filePath);
                    if (await file.exists()) {
                        clearTimeout(timeoutId);
                        return wrap(new Response(file));
                    }
                } catch (error) {
                    logger.error(`Error serving static file ${filePath}:`, error as any);
                }
            }
        }

        const endpointKey = `${method}:${url.pathname}`;
        let endpoint = app.restEndpointMap.get(endpointKey);

        if (!endpoint) {
            for (const ep of app.restEndpoints) {
                if (ep.method !== method) continue;
                const pattern = ep.path.replace(/:[^/]+/g, '[^/]+');
                const regex = new RegExp(`^${pattern}$`);
                if (regex.test(url.pathname)) {
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

                clearTimeout(timeoutId);
                if (result instanceof Response) {
                    return wrap(result);
                } else {
                    return wrap(new Response(JSON.stringify(result), {
                        headers: { "Content-Type": "application/json" },
                    }));
                }
            } catch (error) {
                const duration = Date.now() - startTime;
                logger.error(
                    `Error in REST endpoint ${method} ${endpoint.path} after ${duration}ms`,
                    error as any,
                );
                clearTimeout(timeoutId);
                return wrap(new Response(
                    JSON.stringify({
                        error: "Internal server error",
                        code: "INTERNAL_ERROR",
                        ...(process.env.NODE_ENV === 'development' && {
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
            clearTimeout(timeoutId);
            return response;
        }

        clearTimeout(timeoutId);
        return wrap(new Response("Not Found", { status: 404 }));
    } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(
            `Request failed after ${duration}ms: ${method} ${url.pathname}`,
            error as any,
        );
        clearTimeout(timeoutId);

        if ((error as Error).name === "AbortError") {
            return wrap(new Response(
                JSON.stringify({ error: "Request timeout", code: "TIMEOUT_ERROR" }),
                { status: 408, headers: { "Content-Type": "application/json" } },
            ));
        }

        return wrap(new Response(
            JSON.stringify({
                error: "Internal server error",
                code: "INTERNAL_ERROR",
                ...(process.env.NODE_ENV === 'development' && {
                    message: (error as Error)?.message,
                }),
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
        ));
    }
}
