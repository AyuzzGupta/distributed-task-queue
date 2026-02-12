import { getRedisClient } from './redis';
import { getLogger } from '../utils/logger';

const logger = getLogger().child({ module: 'priority-queue' });

/**
 * Redis key naming conventions:
 *   queue:{name}:waiting    - Sorted set of job IDs waiting to be processed (score = priority weight + timestamp)
 *   queue:{name}:processing - Set of job IDs currently being processed
 *   queue:{name}:delayed    - Sorted set of delayed/scheduled jobs (score = execute-at timestamp)
 *   queue:{name}:dlq        - List of dead-letter job IDs
 */

// Priority weights — lower score = dequeued first
const PRIORITY_WEIGHTS: Record<string, number> = {
    HIGH: 0,
    MEDIUM: 1e13,
    LOW: 2e13,
};

/**
 * Calculate the score for a job in the sorted set.
 * Lower score = higher priority = dequeued first.
 * Within the same priority, earlier jobs are dequeued first (FIFO).
 */
function calculateScore(priority: string, timestamp?: number): number {
    const weight = PRIORITY_WEIGHTS[priority] ?? PRIORITY_WEIGHTS.MEDIUM;
    const ts = timestamp ?? Date.now();
    return weight + ts;
}

/**
 * Lua script to atomically pop the lowest-scored job from the waiting set
 * and add it to the processing set. Returns the job ID or nil.
 */
const DEQUEUE_LUA = `
  local waitingKey = KEYS[1]
  local processingKey = KEYS[2]

  -- Get the job with the lowest score (highest priority, earliest timestamp)
  local result = redis.call('ZPOPMIN', waitingKey, 1)
  if #result == 0 then
    return nil
  end

  local jobId = result[1]

  -- Add to processing set
  redis.call('SADD', processingKey, jobId)

  return jobId
`;

/**
 * Enqueue a job into the priority sorted set.
 */
export async function enqueueJob(
    queue: string,
    jobId: string,
    priority: string
): Promise<void> {
    const redis = getRedisClient();
    const key = `queue:${queue}:waiting`;
    const score = calculateScore(priority);

    await redis.zadd(key, score, jobId);
    logger.debug({ queue, jobId, priority, score }, 'Job enqueued');
}

/**
 * Atomically dequeue the highest-priority job from a queue.
 * Returns the job ID or null if the queue is empty.
 */
export async function dequeueJob(queue: string): Promise<string | null> {
    const redis = getRedisClient();
    const waitingKey = `queue:${queue}:waiting`;
    const processingKey = `queue:${queue}:processing`;

    const jobId = await redis.eval(DEQUEUE_LUA, 2, waitingKey, processingKey) as string | null;

    if (jobId) {
        logger.debug({ queue, jobId }, 'Job dequeued');
    }
    return jobId;
}

/**
 * Acknowledge job completion — remove from processing set.
 */
export async function ackJob(queue: string, jobId: string): Promise<void> {
    const redis = getRedisClient();
    const processingKey = `queue:${queue}:processing`;
    await redis.srem(processingKey, jobId);
    logger.debug({ queue, jobId }, 'Job acknowledged');
}

/**
 * Get the number of jobs waiting in a queue.
 */
export async function getQueueSize(queue: string): Promise<number> {
    const redis = getRedisClient();
    return redis.zcard(`queue:${queue}:waiting`);
}

/**
 * Get the number of jobs currently being processed.
 */
export async function getProcessingCount(queue: string): Promise<number> {
    const redis = getRedisClient();
    return redis.scard(`queue:${queue}:processing`);
}

/**
 * Remove a job from the waiting queue (e.g., on cancellation).
 */
export async function removeFromQueue(queue: string, jobId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.zrem(`queue:${queue}:waiting`, jobId);
    logger.debug({ queue, jobId }, 'Job removed from waiting queue');
}
