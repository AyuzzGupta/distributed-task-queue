import { getLogger } from '../utils/logger';

const logger = getLogger().child({ module: 'handlers' });

/**
 * Job handler function type.
 * Receives the job payload and returns a result (or throws on failure).
 */
export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Registry of job handlers keyed by job type.
 */
const handlers = new Map<string, JobHandler>();

/**
 * Register a job handler for a given type.
 */
export function registerHandler(type: string, handler: JobHandler): void {
    if (handlers.has(type)) {
        logger.warn({ type }, 'Overwriting existing handler');
    }
    handlers.set(type, handler);
    logger.info({ type }, 'Handler registered');
}

/**
 * Get the handler for a given job type.
 */
export function getHandler(type: string): JobHandler | undefined {
    return handlers.get(type);
}

/**
 * Check if a handler exists for a given job type.
 */
export function hasHandler(type: string): boolean {
    return handlers.has(type);
}

/**
 * Get all registered handler types.
 */
export function getRegisteredTypes(): string[] {
    return Array.from(handlers.keys());
}

// ─── Sample Handlers ──────────────────────────────────────────

/**
 * Register built-in sample handlers for demonstration / testing.
 */
export function registerSampleHandlers(): void {
    // Simple echo handler — returns the payload as-is
    registerHandler('echo', async (payload) => {
        logger.info({ payload }, 'Echo handler executing');
        return { echo: payload, processedAt: new Date().toISOString() };
    });

    // Email-sending handler (simulated)
    registerHandler('send-email', async (payload) => {
        const { to, subject } = payload as { to?: string; subject?: string };
        logger.info({ to, subject }, 'Sending email (simulated)');
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
        return { sent: true, to, subject, sentAt: new Date().toISOString() };
    });

    // Image processing handler (simulated)
    registerHandler('process-image', async (payload) => {
        const { imageUrl } = payload as { imageUrl?: string };
        logger.info({ imageUrl }, 'Processing image (simulated)');
        await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));
        return { processed: true, imageUrl, dimensions: { width: 1920, height: 1080 } };
    });

    // Webhook delivery handler (simulated)
    registerHandler('deliver-webhook', async (payload) => {
        const { url, event } = payload as { url?: string; event?: string };
        logger.info({ url, event }, 'Delivering webhook (simulated)');
        await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 500));
        return { delivered: true, url, event, statusCode: 200 };
    });

    // Intentional failure handler for testing retries/DLQ
    registerHandler('always-fail', async (_payload) => {
        throw new Error('This handler always fails (for testing)');
    });
}
