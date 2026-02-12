import { getRedisClient } from './redis';
import { getLogger } from '../utils/logger';
import { getConfig } from '../config';
import { jobsDeadTotal } from '../metrics';

const logger = getLogger().child({ module: 'dlq' });

/**
 * Move a job to the Dead Letter Queue.
 * This is called when a job has exhausted all retries or is identified as a poison pill.
 */
export async function moveToDeadLetterQueue(
    queue: string,
    jobId: string,
    reason: string
): Promise<void> {
    const redis = getRedisClient();
    const dlqKey = `queue:${queue}:dlq`;
    const processingKey = `queue:${queue}:processing`;

    // Remove from processing set and add to DLQ atomically via pipeline
    const pipeline = redis.pipeline();
    pipeline.srem(processingKey, jobId);
    pipeline.lpush(dlqKey, jobId);
    await pipeline.exec();

    jobsDeadTotal.inc({ queue, type: 'unknown' });

    logger.warn({ queue, jobId, reason }, 'Job moved to DLQ');
}

/**
 * Get the number of jobs in the DLQ.
 */
export async function getDLQSize(queue: string): Promise<number> {
    const redis = getRedisClient();
    return redis.llen(`queue:${queue}:dlq`);
}

/**
 * List job IDs in the DLQ (paginated).
 */
export async function listDLQJobs(
    queue: string,
    start: number = 0,
    stop: number = 49
): Promise<string[]> {
    const redis = getRedisClient();
    return redis.lrange(`queue:${queue}:dlq`, start, stop);
}

/**
 * Remove a job from the DLQ (e.g., after manual retry).
 */
export async function removeFromDLQ(queue: string, jobId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.lrem(`queue:${queue}:dlq`, 1, jobId);
    logger.info({ queue, jobId }, 'Job removed from DLQ');
}

// ─── Poison Pill Detection ────────────────────────────────────

/**
 * Track a rapid failure for poison pill detection.
 * If a job fails POISON_PILL_THRESHOLD times within POISON_PILL_WINDOW_MS,
 * it's classified as a poison pill and should be sent to the DLQ immediately.
 */
export async function trackFailure(jobId: string): Promise<boolean> {
    const config = getConfig();
    const redis = getRedisClient();
    const key = `poison:${jobId}`;
    const now = Date.now();

    // Record this failure timestamp
    const pipeline = redis.pipeline();
    pipeline.zadd(key, now, `${now}`);
    // Remove old entries outside the window
    pipeline.zremrangebyscore(key, 0, now - config.POISON_PILL_WINDOW_MS);
    // Count recent failures
    pipeline.zcard(key);
    // Set TTL so the key auto-cleans
    pipeline.expire(key, Math.ceil(config.POISON_PILL_WINDOW_MS / 1000) + 10);

    const results = await pipeline.exec();
    const failureCount = results?.[2]?.[1] as number;

    if (failureCount >= config.POISON_PILL_THRESHOLD) {
        logger.warn(
            { jobId, failureCount, threshold: config.POISON_PILL_THRESHOLD },
            'Poison pill detected'
        );
        // Clean up tracking key
        await redis.del(key);
        return true;
    }

    return false;
}
