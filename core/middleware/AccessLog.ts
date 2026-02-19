import type { Middleware } from '../Middleware';
import { logger as MainLogger } from '../Logger';
import { getRequestId } from './RequestId';

const logger = MainLogger.child({ scope: 'HTTP' });

export type AccessLogOptions = {
    /** Paths to skip logging for (e.g., '/health'). Default: [] */
    skip?: string[];
};

export function accessLog(options: AccessLogOptions = {}): Middleware {
    const skipSet = new Set(options.skip || []);

    return async (req, next) => {
        const url = new URL(req.url);
        if (skipSet.has(url.pathname)) {
            return next();
        }

        const start = performance.now();
        let response: Response;

        try {
            response = await next();
        } catch (error) {
            const duration = Math.round(performance.now() - start);
            logger.error({
                requestId: getRequestId(),
                method: req.method,
                path: url.pathname,
                status: 500,
                duration,
                msg: `${req.method} ${url.pathname} 500 ${duration}ms`,
            });
            throw error;
        }

        const duration = Math.round(performance.now() - start);
        const logData = {
            requestId: getRequestId(),
            method: req.method,
            path: url.pathname,
            status: response.status,
            duration,
            msg: `${req.method} ${url.pathname} ${response.status} ${duration}ms`,
        };

        if (response.status >= 500) {
            logger.error(logData);
        } else if (response.status >= 400) {
            logger.warn(logData);
        } else {
            logger.info(logData);
        }

        return response;
    };
}
