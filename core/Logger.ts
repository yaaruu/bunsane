import pino from "pino";

const usePretty = process.env.LOG_PRETTY === 'true';
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
        paths: [
            'password', 'secret', 'token', 'authorization',
            'config.password', '*.password', '*.secret', '*.token',
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
