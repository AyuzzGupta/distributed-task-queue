import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getPrismaClient } from '../../db/client';
import { enqueueJob, removeFromQueue, removeFromDLQ } from '../../queue';
import { getConfig } from '../../config';
import { getLogger } from '../../utils/logger';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';
import { jobsCreatedTotal, jobsRetriedTotal } from '../../metrics';
import { JobPriority, JobStatus, Prisma } from '@prisma/client';

const logger = getLogger().child({ module: 'routes:jobs' });

// ─── Request Schemas ──────────────────────────────────────────

const CreateJobSchema = z.object({
    queue: z.string().min(1).max(100).default('default'),
    type: z.string().min(1).max(200),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
    payload: z.record(z.unknown()).default({}),
    idempotencyKey: z.string().max(255).optional(),
    maxRetries: z.number().int().min(0).max(50).optional(),
    scheduledAt: z.string().datetime().optional(), // ISO 8601
    visibilityTimeout: z.number().int().min(5000).max(3600000).optional(), // 5s - 1h
});

const JobIdParamsSchema = z.object({
    id: z.string().uuid(),
});

const ListJobsQuerySchema = z.object({
    queue: z.string().optional(),
    status: z.enum(['PENDING', 'SCHEDULED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
});

export default async function jobRoutes(fastify: FastifyInstance): Promise<void> {
    const prisma = getPrismaClient();
    const config = getConfig();

    // ─── POST /jobs — Create a new job ────────────────────────────

    fastify.post('/jobs', {
        preHandler: [fastify.authorizeAdmin],
        handler: async (request, reply) => {
            const body = CreateJobSchema.parse(request.body);

            // Idempotency check
            if (body.idempotencyKey) {
                const existing = await prisma.job.findUnique({
                    where: { idempotencyKey: body.idempotencyKey },
                });
                if (existing) {
                    logger.info({ idempotencyKey: body.idempotencyKey, jobId: existing.id }, 'Idempotent job returned');
                    return reply.status(200).send({
                        job: existing,
                        idempotent: true,
                    });
                }
            }

            const isScheduled = body.scheduledAt && new Date(body.scheduledAt) > new Date();
            const status: JobStatus = isScheduled ? 'SCHEDULED' : 'PENDING';

            const job = await prisma.job.create({
                data: {
                    id: uuidv4(),
                    queue: body.queue,
                    type: body.type,
                    priority: body.priority as JobPriority,
                    status,
                    payload: body.payload as Prisma.InputJsonValue,
                    idempotencyKey: body.idempotencyKey || null,
                    maxRetries: body.maxRetries ?? config.DEFAULT_MAX_RETRIES,
                    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
                    visibilityTimeout: body.visibilityTimeout ?? config.VISIBILITY_TIMEOUT_MS,
                },
            });

            // Create initial history entry
            await prisma.jobHistory.create({
                data: {
                    jobId: job.id,
                    status: job.status,
                    message: 'Job created',
                },
            });

            // Enqueue to Redis
            if (isScheduled) {
                // Add to delayed sorted set — the scheduler will promote it when due
                const { getRedisClient } = await import('../../queue/redis');
                const redis = getRedisClient();
                const delayedKey = `queue:${job.queue}:delayed`;
                const executeAt = new Date(body.scheduledAt!).getTime();
                await redis.zadd(delayedKey, executeAt, job.id);
                logger.info({ jobId: job.id, scheduledAt: body.scheduledAt }, 'Job scheduled');
            } else {
                await enqueueJob(job.queue, job.id, job.priority);
            }

            jobsCreatedTotal.inc({ queue: job.queue, priority: job.priority });

            logger.info(
                { jobId: job.id, queue: job.queue, type: job.type, priority: job.priority, status: job.status },
                'Job created'
            );

            return reply.status(201).send({ job });
        },
    });

    // ─── GET /jobs/:id — Get job status ───────────────────────────

    fastify.get('/jobs/:id', {
        preHandler: [fastify.authenticate],
        handler: async (request, reply) => {
            const { id } = JobIdParamsSchema.parse(request.params);

            const job = await prisma.job.findUnique({
                where: { id },
                include: {
                    history: {
                        orderBy: { createdAt: 'desc' },
                        take: 20,
                    },
                },
            });

            if (!job) {
                throw new NotFoundError('Job', id);
            }

            return reply.send({ job });
        },
    });

    // ─── POST /jobs/:id/retry — Manually retry a failed/dead job ─

    fastify.post('/jobs/:id/retry', {
        preHandler: [fastify.authorizeAdmin],
        handler: async (request, reply) => {
            const { id } = JobIdParamsSchema.parse(request.params);

            const job = await prisma.job.findUnique({ where: { id } });
            if (!job) {
                throw new NotFoundError('Job', id);
            }

            if (!['FAILED', 'DEAD', 'CANCELLED'].includes(job.status)) {
                throw new ConflictError(`Cannot retry job with status '${job.status}'. Only FAILED, DEAD, or CANCELLED jobs can be retried.`);
            }

            // Reset job for retry
            const updatedJob = await prisma.job.update({
                where: { id },
                data: {
                    status: 'PENDING',
                    error: null,
                    lockedBy: null,
                    lockedAt: null,
                    attempts: 0,
                    completedAt: null,
                },
            });

            await prisma.jobHistory.create({
                data: {
                    jobId: job.id,
                    status: 'PENDING',
                    message: 'Manual retry initiated',
                },
            });

            // Remove from DLQ if it was there
            await removeFromDLQ(job.queue, job.id);

            // Re-enqueue
            await enqueueJob(job.queue, job.id, job.priority);

            jobsRetriedTotal.inc({ queue: job.queue, type: job.type });

            logger.info({ jobId: job.id, queue: job.queue }, 'Job manually retried');

            return reply.send({ job: updatedJob });
        },
    });

    // ─── DELETE /jobs/:id — Cancel a job ──────────────────────────

    fastify.delete('/jobs/:id', {
        preHandler: [fastify.authorizeAdmin],
        handler: async (request, reply) => {
            const { id } = JobIdParamsSchema.parse(request.params);

            const job = await prisma.job.findUnique({ where: { id } });
            if (!job) {
                throw new NotFoundError('Job', id);
            }

            if (!['PENDING', 'SCHEDULED'].includes(job.status)) {
                throw new ConflictError(`Cannot cancel job with status '${job.status}'. Only PENDING or SCHEDULED jobs can be cancelled.`);
            }

            const updatedJob = await prisma.job.update({
                where: { id },
                data: {
                    status: 'CANCELLED',
                    completedAt: new Date(),
                },
            });

            await prisma.jobHistory.create({
                data: {
                    jobId: job.id,
                    status: 'CANCELLED',
                    message: 'Job cancelled by user',
                },
            });

            // Remove from Redis queue
            await removeFromQueue(job.queue, job.id);

            logger.info({ jobId: job.id, queue: job.queue }, 'Job cancelled');

            return reply.send({ job: updatedJob });
        },
    });

    // ─── POST /jobs/:id/complete — Mark a job as completed ────────

    fastify.post('/jobs/:id/complete', {
        preHandler: [fastify.authenticate],
        handler: async (request, reply) => {
            const { id } = JobIdParamsSchema.parse(request.params);
            const user = request.user as any;

            const job = await prisma.job.findUnique({ where: { id } });
            if (!job) {
                throw new NotFoundError('Job', id);
            }

            if (job.status !== 'PROCESSING') {
                throw new ConflictError(`Cannot complete job with status '${job.status}'. Only PROCESSING jobs can be completed.`);
            }

            const updatedJob = await prisma.job.update({
                where: { id },
                data: {
                    status: 'COMPLETED',
                    completedAt: new Date(),
                    completedBy: user.sub || 'Unknown',
                    lockedBy: null,
                    lockedAt: null,
                },
            });

            await prisma.jobHistory.create({
                data: {
                    jobId: job.id,
                    status: 'COMPLETED',
                    message: `Completed by ${user.sub || 'Unknown'}`,
                },
            });

            // Remove from Redis queue
            await removeFromQueue(job.queue, job.id);

            logger.info({ jobId: job.id, completedBy: user.sub }, 'Job manually completed');

            return reply.send({ job: updatedJob });
        },
    });

    // ─── GET /jobs — List jobs (with filters) ─────────────────────

    fastify.get('/jobs', {
        preHandler: [fastify.authenticate],
        handler: async (request, reply) => {
            const query = ListJobsQuerySchema.parse(request.query);

            const where: any = {};
            if (query.queue) where.queue = query.queue;
            if (query.status) where.status = query.status;

            const [jobs, total] = await Promise.all([
                prisma.job.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    take: query.limit,
                    skip: query.offset,
                }),
                prisma.job.count({ where }),
            ]);

            return reply.send({
                jobs,
                pagination: {
                    total,
                    limit: query.limit,
                    offset: query.offset,
                },
            });
        },
    });
}
