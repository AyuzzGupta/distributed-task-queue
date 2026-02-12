import { getRedisClient } from './redis';
import { enqueueJob } from './priority-queue';
import { getPrismaClient } from '../db/client';
import { getLogger } from '../utils/logger';

const logger = getLogger().child({ module: 'scheduler' });

/**
 * Lua script to atomically move all due jobs from the delayed sorted set
 * to the main waiting sorted set.
 *
 * Returns the list of moved job IDs.
 */
const PROMOTE_DELAYED_LUA = `
  local delayedKey = KEYS[1]
  local now = tonumber(ARGV[1])

  -- Get all jobs with score <= now (their scheduled time has passed)
  local jobs = redis.call('ZRANGEBYSCORE', delayedKey, '-inf', now)

  if #jobs == 0 then
    return {}
  end

  -- Remove them from the delayed set
  redis.call('ZREMRANGEBYSCORE', delayedKey, '-inf', now)

  return jobs
`;

/**
 * Check the delayed sorted set for jobs that are now due, and move them
 * to the main priority queue.
 */
export async function promoteDelayedJobs(queues: string[]): Promise<number> {
    const redis = getRedisClient();
    const prisma = getPrismaClient();
    const now = Date.now();
    let totalPromoted = 0;

    for (const queue of queues) {
        const delayedKey = `queue:${queue}:delayed`;

        const jobIds = (await redis.eval(PROMOTE_DELAYED_LUA, 1, delayedKey, now)) as string[];

        if (jobIds && jobIds.length > 0) {
            // Look up each job's priority from the database to re-enqueue correctly
            const jobs = await prisma.job.findMany({
                where: {
                    id: { in: jobIds },
                    status: { in: ['PENDING', 'SCHEDULED', 'FAILED'] },
                },
                select: { id: true, priority: true, queue: true },
            });

            for (const job of jobs) {
                await enqueueJob(job.queue, job.id, job.priority);

                // Update status to PENDING if it was SCHEDULED
                await prisma.job.update({
                    where: { id: job.id },
                    data: { status: 'PENDING', scheduledAt: null },
                });
            }

            totalPromoted += jobs.length;

            if (jobs.length > 0) {
                logger.info(
                    { queue, promoted: jobs.length, jobIds: jobs.map((j) => j.id) },
                    'Promoted delayed jobs to main queue'
                );
            }
        }
    }

    return totalPromoted;
}

/**
 * Check the processing set for jobs that have exceeded their visibility timeout.
 * Reclaim them by moving back to the waiting queue.
 */
export async function reclaimTimedOutJobs(queues: string[]): Promise<number> {
    const redis = getRedisClient();
    const prisma = getPrismaClient();
    const now = Date.now();
    let totalReclaimed = 0;

    for (const queue of queues) {
        const processingKey = `queue:${queue}:processing`;

        // Get all job IDs in the processing set
        const processingJobIds = await redis.smembers(processingKey);

        if (processingJobIds.length === 0) continue;

        // Check each job's lock time against its visibility timeout
        const jobs = await prisma.job.findMany({
            where: {
                id: { in: processingJobIds },
                status: 'PROCESSING',
                lockedAt: { not: null },
            },
            select: { id: true, priority: true, queue: true, lockedAt: true, visibilityTimeout: true },
        });

        for (const job of jobs) {
            if (!job.lockedAt) continue;

            const lockAge = now - job.lockedAt.getTime();
            if (lockAge > job.visibilityTimeout) {
                // Visibility timeout exceeded — reclaim the job
                const pipeline = redis.pipeline();
                pipeline.srem(processingKey, job.id);
                await pipeline.exec();

                await enqueueJob(job.queue, job.id, job.priority);

                await prisma.job.update({
                    where: { id: job.id },
                    data: {
                        status: 'PENDING',
                        lockedBy: null,
                        lockedAt: null,
                    },
                });

                logger.warn(
                    { queue, jobId: job.id, lockAgeMs: lockAge, timeoutMs: job.visibilityTimeout },
                    'Reclaimed timed-out job'
                );

                totalReclaimed++;
            }
        }
    }

    return totalReclaimed;
}

let _schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Start the scheduler loop that periodically:
 * 1. Promotes delayed/scheduled jobs that are now due.
 * 2. Reclaims jobs that have exceeded their visibility timeout.
 */
export function startScheduler(queues: string[], intervalMs: number = 1000): void {
    logger.info({ queues, intervalMs }, 'Starting queue scheduler');

    const tick = async () => {
        try {
            await promoteDelayedJobs(queues);
            await reclaimTimedOutJobs(queues);
        } catch (err) {
            logger.error({ err }, 'Scheduler tick error');
        }
    };

    // Run immediately on start
    tick();
    _schedulerInterval = setInterval(tick, intervalMs);
}

/**
 * Stop the scheduler loop.
 */
export function stopScheduler(): void {
    if (_schedulerInterval) {
        clearInterval(_schedulerInterval);
        _schedulerInterval = null;
        logger.info('Queue scheduler stopped');
    }
}
