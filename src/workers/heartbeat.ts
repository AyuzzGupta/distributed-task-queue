import { getPrismaClient } from '../db/client';
import { getConfig } from '../config';
import { createChildLogger } from '../utils/logger';
import { activeWorkers, workerActiveJobs } from '../metrics';

const logger = createChildLogger({ module: 'heartbeat' });

let _heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Start the heartbeat updater that periodically upserts this worker's
 * status into the WorkerHeartbeat table.
 */
export function startHeartbeat(
    workerId: string,
    queues: string[],
    getActiveCount: () => number,
    intervalMs: number = 10000
): void {
    const config = getConfig();
    const prisma = getPrismaClient();
    const hostname = require('os').hostname();

    const beat = async () => {
        try {
            const activeJobs = getActiveCount();

            await prisma.workerHeartbeat.upsert({
                where: { workerId },
                update: {
                    lastHeartbeat: new Date(),
                    activeJobs,
                    concurrency: config.WORKER_CONCURRENCY,
                },
                create: {
                    workerId,
                    hostname,
                    queues,
                    concurrency: config.WORKER_CONCURRENCY,
                    activeJobs,
                    lastHeartbeat: new Date(),
                    startedAt: new Date(),
                },
            });

            workerActiveJobs.set({ worker_id: workerId }, activeJobs);

            logger.debug({ workerId, activeJobs }, 'Heartbeat sent');
        } catch (err) {
            logger.error({ err, workerId }, 'Failed to send heartbeat');
        }
    };

    // Register this worker as active
    activeWorkers.inc();

    // Immediately send first heartbeat
    beat();
    _heartbeatInterval = setInterval(beat, intervalMs);

    logger.info({ workerId, intervalMs, queues }, 'Heartbeat started');
}

/**
 * Stop the heartbeat updater and deregister the worker.
 */
export async function stopHeartbeat(workerId: string): Promise<void> {
    if (_heartbeatInterval) {
        clearInterval(_heartbeatInterval);
        _heartbeatInterval = null;
    }

    activeWorkers.dec();

    // Remove heartbeat record
    try {
        const prisma = getPrismaClient();
        await prisma.workerHeartbeat.delete({ where: { workerId } }).catch(() => {
            // Ignore if already removed
        });
    } catch {
        // Best-effort cleanup
    }

    logger.info({ workerId }, 'Heartbeat stopped');
}
