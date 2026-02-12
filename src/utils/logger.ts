import pino from 'pino';
import { getConfig } from '../config';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
    if (!_logger) {
        const config = getConfig();
        _logger = pino({
            level: config.LOG_LEVEL,
            formatters: {
                level(label) {
                    return { level: label };
                },
            },
            timestamp: pino.stdTimeFunctions.isoTime,
            ...(config.NODE_ENV === 'development'
                ? {
                    transport: {
                        target: 'pino/file',
                        options: { destination: 1 }, // stdout
                    },
                }
                : {}),
        });
    }
    return _logger;
}

/**
 * Create a child logger with additional context bindings.
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
    return getLogger().child(bindings);
}
