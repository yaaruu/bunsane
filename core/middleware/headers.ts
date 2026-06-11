/**
 * Attempt to mutate `response.headers` in-place.
 * Constructed Responses (Yoga, REST handlers) allow mutation; only proxied
 * fetch Responses guard their headers as immutable. Fall back to a single
 * clone so the chain never needs more than one new Response.
 */
export function setResponseHeaders(
    response: Response,
    headers: Iterable<[string, string]>,
): Response {
    try {
        for (const [key, value] of headers) {
            response.headers.set(key, value);
        }
        return response;
    } catch {
        // Immutable guard hit (e.g. proxied fetch Response) — clone once.
        const cloned = new Headers(response.headers);
        for (const [key, value] of headers) {
            cloned.set(key, value);
        }
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: cloned,
        });
    }
}
