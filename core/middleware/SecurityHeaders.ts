import type { Middleware } from '../Middleware';

export type SecurityHeadersOptions = {
    /** Enable HSTS header. Default: true in production */
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
};

export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
    const isProduction = process.env.NODE_ENV === 'production';
    const {
        hsts = isProduction,
        hstsMaxAge = 31536000,
        frameOptions = 'DENY',
        noSniff = true,
        referrerPolicy = 'strict-origin-when-cross-origin',
        xssProtection = false,
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

    return async (req, next) => {
        const response = await next();

        const newHeaders = new Headers(response.headers);
        for (const [key, value] of headersToSet) {
            newHeaders.set(key, value);
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    };
}
