import { getConfig, getWorkerQueues } from '../config';
import { getLogger } from '../utils/logger';
import { getPrismaClient, disconnectPrisma } from '../db/client';
import { getRedisClient, disconnectRedis } from '../queue/redis';
import { startScheduler, stopScheduler } from '../queue/scheduler';
import { Worker } from './worker';
import { registerSampleHandlers } from './handlers';
import { startHeartbeat, stopHeartbeat } from './heartbeat';

const logger = getLogger().child({ module: 'worker-main' });

async function main(): Promise<void> {
    const config = getConfig();
    const workerId = config.WORKER_ID;
    const queues = getWorkerQueues();

    logger.info(
        { workerId, queues, concurrency: config.WORKER_CONCURRENCY },
        'Initializing worker'
    );

    // Initialize connections
    getPrismaClient();
    getRedisClient();

    // Register job handlers
    registerSampleHandlers();

    // Create the worker
    const worker = new Worker(workerId, queues, config.WORKER_CONCURRENCY);

    // Start heartbeat
    startHeartbeat(workerId, queues, () => worker.getActiveCount());

    // Start the scheduler (promotes delayed jobs, reclaims timed-out jobs)
    startScheduler(queues);

    // ─── Graceful Shutdown ──────────────────────────────────────

    let shuttingDown = false;

    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info({ signal, workerId }, 'Received shutdown signal');

        try {
            // Stop accepting new jobs
            await worker.stop();

            // Stop heartbeat
            await stopHeartbeat(workerId);

            // Stop scheduler
            stopScheduler();

            // Disconnect databases
            await disconnectPrisma();
            await disconnectRedis();

            logger.info({ workerId }, 'Worker shut down gracefully');
            process.exit(0);
        } catch (err) {
            logger.error({ err, workerId }, 'Error during worker shutdown');
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
        logger.fatal({ err, workerId }, 'Uncaught exception');
        shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
        logger.fatal({ err: reason, workerId }, 'Unhandled rejection');
        shutdown('unhandledRejection');
    });

    // Start the worker loop (blocks until stopped)
    logger.info({ workerId }, '🚀 Worker starting');
    await worker.start();
}

main().catch((err) => {
    logger.fatal({ err }, 'Worker failed to start');
    process.exit(1);
});
