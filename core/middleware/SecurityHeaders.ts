import type { Middleware } from '../Middleware';
import { setResponseHeaders } from './headers';

export type SecurityHeadersOptions = {
    /** Enable HSTS. Default: on only when BUNSANE_HSTS=on or BUNSANE_TLS=on. */
    hsts?: boolean;
    /** HSTS max-age in seconds. Default: 31536000 (1 year) */
    hstsMaxAge?: number;
    /** X-Frame-Options value. Default: 'DENY' */
    frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
    /** X-Content-Type-Options. Default: true (sets 'nosniff') */
    noSniff?: boolean;
    /** Referrer-Policy value. Default: 'strict-origin-when-cross-origin' */
    referrerPolicy?: string | false;
    /** X-XSS-Protection. Default: false (deprecated header, modern browsers don't need it) */
    xssProtection?: boolean;
    /** Permissions-Policy. Default: deny powerful features. false omits the header. */
    permissionsPolicy?: string | false;
};

/** CSP for framework-served Swagger HTML (pinned unpkg + same-origin init script). */
export const DOCS_CSP =
    "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://unpkg.com; font-src 'self' https://unpkg.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

/** CSP for the self-hosted Studio shell. */
export const STUDIO_CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

export function documentGuardHeaders(csp: string): [string, string][] {
    return [
        ['Content-Security-Policy', csp],
        ['Cross-Origin-Opener-Policy', 'same-origin'],
        ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
    ];
}

/** Pass `false` for a no-op middleware (App uses setSecurityHeaders(false) to skip registration). */
export function securityHeaders(options: SecurityHeadersOptions | false = {}): Middleware {
    if (options === false) {
        return async (_req, next) => next();
    }
    const tlsDeclared = process.env.BUNSANE_HSTS === 'on' || process.env.BUNSANE_TLS === 'on';
    const {
        hsts = tlsDeclared,
        hstsMaxAge = 31536000,
        frameOptions = 'DENY',
        noSniff = true,
        referrerPolicy = 'strict-origin-when-cross-origin',
        xssProtection = false,
        permissionsPolicy = 'camera=(), microphone=(), geolocation=()',
    } = options;

    // Pre-compute headers once at registration time
    const headersToSet: [string, string][] = [];

    if (hsts) {
        headersToSet.push(['Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains`]);
    }
    if (frameOptions) {
        headersToSet.push(['X-Frame-Options', frameOptions]);
    }
    if (noSniff) {
        headersToSet.push(['X-Content-Type-Options', 'nosniff']);
    }
    if (referrerPolicy) {
        headersToSet.push(['Referrer-Policy', referrerPolicy]);
    }
    if (xssProtection) {
        headersToSet.push(['X-XSS-Protection', '1; mode=block']);
    }
    if (permissionsPolicy) {
        headersToSet.push(['Permissions-Policy', permissionsPolicy]);
    }

    return async (req, next) => {
        const response = await next();
        return setResponseHeaders(response, headersToSet);
    };
}
