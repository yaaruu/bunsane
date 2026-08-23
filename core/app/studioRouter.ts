import studioEndpoint from "../../endpoints";
import { createHash, timingSafeEqual } from "crypto";

function sha256(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

function bearerToken(headerValue: string | null): string | null {
    if (!headerValue) return null;
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    return match ? match[1]! : null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export async function routeStudio(
    app: any,
    url: URL,
    req: Request,
    method: string,
): Promise<Response | null> {
    if (!app.studioEnabled || !url.pathname.startsWith("/studio/api/")) return null;

    // SEC-01: the studio API is an unauthenticated-by-design admin surface
    // (raw table dumps and deletes), so it is deny-by-default. No token
    // configured → pretend the route does not exist at all. A configured
    // token must be presented as `Authorization: Bearer <token>` or
    // `x-studio-token`; comparison is constant-time over SHA-256 digests.
    const expected = app.studioAuthToken as string | null | undefined;
    if (!expected) {
        return jsonResponse(404, { error: "Studio API endpoint not found" });
    }

    const provided =
        bearerToken(req.headers.get("authorization")) ??
        req.headers.get("x-studio-token");
    if (
        !provided ||
        !timingSafeEqual(sha256(provided), sha256(expected))
    ) {
        return jsonResponse(401, { error: "Unauthorized" });
    }

    if (url.pathname === "/studio/api/tables") {
        return await studioEndpoint.getTables();
    }

    if (url.pathname === "/studio/api/stats") {
        return await studioEndpoint.handleStudioStatsRequest();
    }

    if (url.pathname === "/studio/api/components") {
        return await studioEndpoint.handleStudioComponentsRequest();
    }

    if (url.pathname === "/studio/api/entities") {
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        const search = url.searchParams.get("search");
        const includeDeleted = url.searchParams.get("include_deleted");

        return await studioEndpoint.handleEntityListRequest({
            limit: limit ? parseInt(limit, 10) : undefined,
            offset: offset ? parseInt(offset, 10) : undefined,
            search: search ?? undefined,
            include_deleted: includeDeleted === "true",
        });
    }

    if (url.pathname === "/studio/api/query" && method === "POST") {
        const body = await req.json();
        return await studioEndpoint.handleStudioQueryRequest(body);
    }

    const studioApiPath = url.pathname.replace("/studio/api/", "");
    const pathSegments = studioApiPath.split("/");

    if (pathSegments[0] === "entity" && pathSegments[1]) {
        const entityId = pathSegments[1];
        return await studioEndpoint.handleEntityInspectorRequest(entityId);
    }

    if (pathSegments[0] === "table" && pathSegments[1]) {
        const tableName = pathSegments[1];

        if (method === "DELETE") {
            const body = await req.json();
            return await studioEndpoint.handleStudioTableDeleteRequest(tableName, body);
        }

        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        const search = url.searchParams.get("search");

        return await studioEndpoint.handleStudioTableRequest(tableName, {
            limit: limit ? parseInt(limit, 10) : undefined,
            offset: offset ? parseInt(offset, 10) : undefined,
            search: search ?? undefined,
        });
    }

    if (pathSegments[0] === "arche-type" && pathSegments[1]) {
        const archeTypeName = pathSegments[1];

        if (method === "DELETE") {
            const body = await req.json();
            return await studioEndpoint.handleStudioArcheTypeDeleteRequest(archeTypeName, body);
        }

        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        const search = url.searchParams.get("search");
        const includeDeleted = url.searchParams.get("include_deleted");

        return await studioEndpoint.handleStudioArcheTypeRecordsRequest(archeTypeName, {
            limit: limit ? parseInt(limit, 10) : undefined,
            offset: offset ? parseInt(offset, 10) : undefined,
            search: search ?? undefined,
            include_deleted: includeDeleted === "true",
        });
    }

    return new Response(
        JSON.stringify({ error: "Studio API endpoint not found" }),
        {
            status: 404,
            headers: { "Content-Type": "application/json" },
        },
    );
}
