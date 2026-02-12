import { getRedisClient } from './redis';
import { getLogger } from '../utils/logger';
import { getConfig } from '../config';

const logger = getLogger().child({ module: 'retry-queue' });

/**
 * Schedule a job for retry with exponential backoff.
 *
 * delay = baseDelay * 2^attempt + jitter
 *
 * The job is added to the delayed sorted set with a future timestamp as score.
 */
export async function scheduleRetry(
    queue: string,
    jobId: string,
    attempt: number
): Promise<number> {
    const config = getConfig();
    const redis = getRedisClient();

    // Exponential backoff with jitter
    const baseDelay = config.RETRY_BASE_DELAY_MS;
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * baseDelay);
    const totalDelay = exponentialDelay + jitter;

    const executeAt = Date.now() + totalDelay;
    const delayedKey = `queue:${queue}:delayed`;

    await redis.zadd(delayedKey, executeAt, jobId);

    logger.info(
        { queue, jobId, attempt, delayMs: totalDelay, executeAt: new Date(executeAt).toISOString() },
        'Job scheduled for retry'
    );

    return totalDelay;
}

/**
 * Get the count of jobs in the retry/delayed queue.
 */
export async function getDelayedCount(queue: string): Promise<number> {
    const redis = getRedisClient();
    return redis.zcard(`queue:${queue}:delayed`);
}
