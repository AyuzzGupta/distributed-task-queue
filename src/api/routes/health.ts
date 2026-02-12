import { FastifyInstance } from 'fastify';
import { getPrismaClient } from '../../db/client';
import { getRedisClient } from '../../queue/redis';
import { getLogger } from '../../utils/logger';

const logger = getLogger().child({ module: 'routes:health' });

export default async function healthRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get('/health', async (_request, reply) => {
        const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

        // Check PostgreSQL
        const pgStart = Date.now();
        try {
            const prisma = getPrismaClient();
            await prisma.$queryRaw`SELECT 1`;
            checks.postgresql = { status: 'ok', latencyMs: Date.now() - pgStart };
        } catch (err: any) {
            checks.postgresql = { status: 'error', latencyMs: Date.now() - pgStart, error: err.message };
        }

        // Check Redis
        const redisStart = Date.now();
        try {
            const redis = getRedisClient();
            await redis.ping();
            checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
        } catch (err: any) {
            checks.redis = { status: 'error', latencyMs: Date.now() - redisStart, error: err.message };
        }

        const allHealthy = Object.values(checks).every((c) => c.status === 'ok');
        const statusCode = allHealthy ? 200 : 503;

        return reply.status(statusCode).send({
            status: allHealthy ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            checks,
        });
    });
}
