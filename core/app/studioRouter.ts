import studioEndpoint from "../../endpoints";

export async function routeStudio(
    app: any,
    url: URL,
    req: Request,
    method: string,
): Promise<Response | null> {
    if (!app.studioEnabled || !url.pathname.startsWith("/studio/api/")) return null;

    if (url.pathname === "/studio/api/tables") {
        return await studioEndpoint.getTables();
    }

    if (url.pathname === "/studio/api/stats") {
        return await studioEndpoint.handleStudioStatsRequest();
    }

    if (url.pathname === "/studio/api/components") {
        return await studioEndpoint.handleStudioComponentsRequest();
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
