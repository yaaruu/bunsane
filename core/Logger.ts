import pino from "pino";

const usePretty = process.env.LOG_PRETTY === 'true';
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
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
