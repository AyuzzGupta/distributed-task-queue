import { getPrismaClient } from '../db/client';
import { dequeueJob, ackJob, scheduleRetry, moveToDeadLetterQueue, trackFailure } from '../queue';
import { getHandler, hasHandler } from './handlers';
import { getConfig } from '../config';
import { createChildLogger } from '../utils/logger';
import {
    jobsCompletedTotal,
    jobsFailedTotal,
    jobsRetriedTotal,
    jobProcessingDuration,
} from '../metrics';

const logger = createChildLogger({ module: 'worker' });

/**
 * Semaphore for controlling concurrency.
 */
class Semaphore {
    private _count: number;
    private _waiters: Array<() => void> = [];

    constructor(count: number) {
        this._count = count;
    }

    get available(): number {
        return this._count;
    }

    get active(): number {
        return this._maxCount - this._count;
    }

    private _maxCount = 0;

    async acquire(): Promise<void> {
        if (this._maxCount === 0) this._maxCount = this._count;
        if (this._count > 0) {
            this._count--;
            return;
        }
        return new Promise<void>((resolve) => {
            this._waiters.push(resolve);
        });
    }

    release(): void {
        const waiter = this._waiters.shift();
        if (waiter) {
            waiter();
        } else {
            this._count++;
        }
    }

    getActiveCount(): number {
        return this._maxCount - this._count;
    }
}

export class Worker {
    private readonly workerId: string;
    private readonly queues: string[];
    private readonly concurrency: number;
    private readonly semaphore: Semaphore;
    private running = false;
    private draining = false;
    private pollIntervalMs = 100; // How often to poll when queues are empty
    private inFlightJobs = 0;

    constructor(workerId: string, queues: string[], concurrency: number) {
        this.workerId = workerId;
        this.queues = queues;
        this.concurrency = concurrency;
        this.semaphore = new Semaphore(concurrency);
    }

    /**
     * Get the number of actively processing jobs.
     */
    getActiveCount(): number {
        return this.inFlightJobs;
    }

    /**
     * Start the worker loop.
     */
    async start(): Promise<void> {
        this.running = true;
        logger.info(
            { workerId: this.workerId, queues: this.queues, concurrency: this.concurrency },
            'Worker started'
        );

        // Spin up poll loops — one per concurrency slot
        const polls: Promise<void>[] = [];
        for (let i = 0; i < this.concurrency; i++) {
            polls.push(this.pollLoop(i));
        }

        await Promise.all(polls);
        logger.info({ workerId: this.workerId }, 'Worker stopped');
    }

    /**
     * Individual poll loop for one concurrency slot.
     */
    private async pollLoop(slotId: number): Promise<void> {
        while (this.running && !this.draining) {
            let processedAny = false;

            // Round-robin through queues
            for (const queue of this.queues) {
                if (!this.running || this.draining) break;

                const jobId = await dequeueJob(queue);
                if (jobId) {
                    processedAny = true;
                    this.inFlightJobs++;
                    try {
                        await this.processJob(queue, jobId);
                    } finally {
                        this.inFlightJobs--;
                    }
                }
            }

            // If no jobs found across all queues, back off
            if (!processedAny) {
                await this.sleep(this.pollIntervalMs);
            }
        }
    }

    /**
     * Process a single job.
     */
    private async processJob(queue: string, jobId: string): Promise<void> {
        const prisma = getPrismaClient();
        const config = getConfig();
        const jobLogger = logger.child({ jobId, queue, workerId: this.workerId });

        const startTime = Date.now();

        try {
            // Lock the job in the database
            const job = await prisma.job.update({
                where: {
                    id: jobId,
                    status: { in: ['PENDING', 'FAILED'] }, // Only process if still eligible
                },
                data: {
                    status: 'PROCESSING',
                    lockedBy: this.workerId,
                    lockedAt: new Date(),
                    attempts: { increment: 1 },
                },
            });

            if (!job) {
                // Job was already picked up or cancelled
                await ackJob(queue, jobId);
                jobLogger.warn('Job no longer eligible for processing, skipping');
                return;
            }

            jobLogger.info(
                { type: job.type, attempt: job.attempts, maxRetries: job.maxRetries },
                'Processing job'
            );

            // Record history
            await prisma.jobHistory.create({
                data: {
                    jobId: job.id,
                    status: 'PROCESSING',
                    message: `Processing attempt ${job.attempts}`,
                    workerId: this.workerId,
                },
            });

            // Find and execute the handler
            const handler = getHandler(job.type);
            if (!handler) {
                throw new Error(`No handler registered for job type: ${job.type}`);
            }

            const result = await handler(job.payload as Record<string, unknown>);

            // Job completed successfully
            const duration = (Date.now() - startTime) / 1000;

            await prisma.job.update({
                where: { id: jobId },
                data: {
                    status: 'COMPLETED',
                    result: result as any,
                    error: null,
                    lockedBy: null,
                    lockedAt: null,
                    completedAt: new Date(),
                },
            });

            await prisma.jobHistory.create({
                data: {
                    jobId: job.id,
                    status: 'COMPLETED',
                    message: `Completed in ${duration.toFixed(2)}s`,
                    workerId: this.workerId,
                },
            });

            await ackJob(queue, jobId);

            jobsCompletedTotal.inc({ queue, type: job.type });
            jobProcessingDuration.observe({ queue, type: job.type, status: 'completed' }, duration);

            jobLogger.info({ duration, type: job.type }, 'Job completed successfully');
        } catch (err: any) {
            const duration = (Date.now() - startTime) / 1000;
            jobLogger.error({ err: err.message, duration }, 'Job processing failed');

            jobProcessingDuration.observe({ queue, type: 'unknown', status: 'failed' }, duration);

            await this.handleFailure(queue, jobId, err);
        }
    }

    /**
     * Handle a job failure: retry with backoff or move to DLQ.
     */
    private async handleFailure(queue: string, jobId: string, error: Error): Promise<void> {
        const prisma = getPrismaClient();
        const jobLogger = logger.child({ jobId, queue, workerId: this.workerId });

        try {
            const job = await prisma.job.findUnique({ where: { id: jobId } });
            if (!job) {
                await ackJob(queue, jobId);
                return;
            }

            // Check for poison pill
            const isPoisonPill = await trackFailure(jobId);

            if (isPoisonPill || job.attempts >= job.maxRetries) {
                // Move to DLQ
                const reason = isPoisonPill
                    ? 'Poison pill detected (rapid repeated failures)'
                    : `Max retries exhausted (${job.attempts}/${job.maxRetries})`;

                await prisma.job.update({
                    where: { id: jobId },
                    data: {
                        status: 'DEAD',
                        error: error.message,
                        lockedBy: null,
                        lockedAt: null,
                    },
                });

                await prisma.jobHistory.create({
                    data: {
                        jobId,
                        status: 'DEAD',
                        message: reason,
                        workerId: this.workerId,
                    },
                });

                await moveToDeadLetterQueue(queue, jobId, reason);
                jobLogger.warn({ reason }, 'Job moved to DLQ');
            } else {
                // Schedule retry with exponential backoff
                const delayMs = await scheduleRetry(queue, jobId, job.attempts);

                await prisma.job.update({
                    where: { id: jobId },
                    data: {
                        status: 'FAILED',
                        error: error.message,
                        lockedBy: null,
                        lockedAt: null,
                    },
                });

                await prisma.jobHistory.create({
                    data: {
                        jobId,
                        status: 'FAILED',
                        message: `Failed, retrying in ${delayMs}ms (attempt ${job.attempts}/${job.maxRetries})`,
                        workerId: this.workerId,
                    },
                });

                // Remove from processing set (retry queue handles re-enqueue via scheduler)
                await ackJob(queue, jobId);

                jobsRetriedTotal.inc({ queue, type: job.type });
                jobsFailedTotal.inc({ queue, type: job.type });

                jobLogger.info(
                    { attempt: job.attempts, maxRetries: job.maxRetries, retryDelayMs: delayMs },
                    'Job scheduled for retry'
                );
            }
        } catch (handleErr: any) {
            jobLogger.error({ err: handleErr.message }, 'Error in failure handler');
            // Last resort: ack the job to prevent infinite processing loop
            await ackJob(queue, jobId);
        }
    }

    /**
     * Signal the worker to stop. Waits for in-flight jobs to complete.
     */
    async stop(): Promise<void> {
        logger.info({ workerId: this.workerId }, 'Worker stopping (draining in-flight jobs)...');
        this.draining = true;

        // Wait for in-flight jobs to finish (with a timeout)
        const maxWait = 30000; // 30 seconds
        const start = Date.now();
        while (this.inFlightJobs > 0 && Date.now() - start < maxWait) {
            logger.info(
                { workerId: this.workerId, inFlightJobs: this.inFlightJobs },
                'Waiting for in-flight jobs to complete'
            );
            await this.sleep(1000);
        }

        if (this.inFlightJobs > 0) {
            logger.warn(
                { workerId: this.workerId, inFlightJobs: this.inFlightJobs },
                'Force stopping with in-flight jobs'
            );
        }

        this.running = false;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
