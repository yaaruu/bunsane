import pino from "pino";

// pino-pretty is an optional dependency: fall back to JSON output when it is
// not installed instead of crashing the transport worker at startup.
function prettyAvailable(): boolean {
    try {
        Bun.resolveSync('pino-pretty', import.meta.dir);
        return true;
    } catch {
        return false;
    }
}
const prettyRequested = process.env.LOG_PRETTY === 'true';
const usePretty = prettyRequested && prettyAvailable();
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    // Error objects have non-enumerable message/stack, so without a
    // serializer `logger.error({ error })` prints `error: {}`. The framework
    // logs under both `err` and `error`; serialize both.
    serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
    },
    redact: {
        paths: [
            'password', 'secret', 'token', 'authorization',
            'config.password', '*.password', '*.secret', '*.token',
            '*.accessKeyId', '*.secretAccessKey', '*.sessionToken',
            'accessKeyId', 'secretAccessKey', 'sessionToken',
            'headers.authorization', 'headers.cookie', 'headers["set-cookie"]',
            'req.headers.authorization', 'req.headers.cookie',
            '*.headers.authorization', '*.headers.cookie',
            'redisUrl', '*.redisUrl', 'connectionString', '*.connectionString',
        ],
        censor: '[REDACTED]',
    },
    ...(usePretty && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                messageFormat: '[{scope}{component}] => {msg}',
                ignore: 'pid,hostname,scope'
            }
        }
    })
});

// pino-pretty serializes each log line synchronously on the main thread — 5-10x
// slower than production JSON output. Warn once so operators don't accidentally
// ship a pretty-print config to production.
if (usePretty && process.env.NODE_ENV === 'production') {
    logger.warn(
        'LOG_PRETTY=true is set in a production environment. ' +
        'pino-pretty is 5-10x slower than JSON output and should not run in production.'
    );
}

if (prettyRequested && !usePretty) {
    logger.warn('LOG_PRETTY=true but pino-pretty is not installed; using JSON output. Install pino-pretty to enable pretty logs.');
}
