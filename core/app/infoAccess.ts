import type { InfoAccess } from "./limits";
import { bearerToken, jsonResponse, tokensMatch } from "./tokenAuth";

/**
 * SEC-10: info endpoints are deny-by-default.
 * - public opt-in → allow
 * - no token configured → 404 (do not advertise the surface)
 * - token mismatch / missing → 401
 * Returns null when the request may proceed.
 */
export function authorizeInfo(
    access: InfoAccess,
    req: Request,
    headerName: string,
): Response | null {
    if (access.public) return null;
    if (!access.token) {
        return jsonResponse(404, { error: "Not found" });
    }
    const provided =
        bearerToken(req.headers.get("authorization")) ??
        req.headers.get(headerName);
    if (!provided || !tokensMatch(provided, access.token)) {
        return jsonResponse(401, { error: "Unauthorized" });
    }
    return null;
}
