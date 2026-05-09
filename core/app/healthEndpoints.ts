import { deepHealthCheck, readinessCheck } from "../health";

export async function handleHealth(_app: any): Promise<Response> {
    const health = await deepHealthCheck();
    return new Response(JSON.stringify(health.result), {
        status: health.httpStatus,
        headers: { "Content-Type": "application/json" },
    });
}

export async function handleReady(app: any): Promise<Response> {
    const ready = await readinessCheck(app.isReady, app.isShuttingDown);
    return new Response(JSON.stringify(ready.result), {
        status: ready.httpStatus,
        headers: { "Content-Type": "application/json" },
    });
}

export async function handleRemoteHealth(app: any): Promise<Response> {
    if (!app.remote) {
        return new Response(
            JSON.stringify({ healthy: false, error: "Remote subsystem not enabled" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
        );
    }
    const health = await app.remote.health();
    return new Response(JSON.stringify(health), {
        status: health.healthy ? 200 : 503,
        headers: { "Content-Type": "application/json" },
    });
}
