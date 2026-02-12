import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'path';
import { getConfig } from '../config';
import { getLogger } from '../utils/logger';
import { getPrismaClient, disconnectPrisma } from '../db/client';
import { getRedisClient, disconnectRedis } from '../queue/redis';
import { AppError } from '../utils/errors';
import { ZodError } from 'zod';

// Plugins
import jwtPlugin from '../auth/jwt';

// Routes
import jobRoutes from './routes/jobs';
import healthRoutes from './routes/health';
import metricsRoutes from './routes/metrics';
import authRoutes from './routes/auth';

const logger = getLogger().child({ module: 'api-server' });

export async function buildServer(): Promise<FastifyInstance> {
    const config = getConfig();

    const fastify = Fastify({
        logger: false, // We use our own Pino logger
        requestTimeout: 30000,
        bodyLimit: 1048576, // 1MB
    });

    // ─── Global Error Handler ──────────────────────────────────────

    fastify.setErrorHandler((error, request, reply) => {
        // Handle Zod validation errors
        if (error instanceof ZodError) {
            return reply.status(400).send({
                error: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: error.errors.map((e) => ({
                    path: e.path.join('.'),
                    message: e.message,
                })),
            });
        }

        // Handle custom app errors
        if (error instanceof AppError) {
            return reply.status(error.statusCode).send({
                error: error.code,
                message: error.message,
            });
        }

        // Log unexpected errors
        logger.error(
            {
                err: error,
                method: request.method,
                url: request.url,
                requestId: request.id,
            },
            'Unhandled error'
        );

        return reply.status(500).send({
            error: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
        });
    });

    // ─── Request Logging ───────────────────────────────────────────

    fastify.addHook('onRequest', (request, _reply, done) => {
        logger.info(
            { method: request.method, url: request.url, requestId: request.id },
            'Incoming request'
        );
        done();
    });

    fastify.addHook('onResponse', (request, reply, done) => {
        logger.info(
            {
                method: request.method,
                url: request.url,
                statusCode: reply.statusCode,
                responseTime: reply.elapsedTime,
                requestId: request.id,
            },
            'Request completed'
        );
        done();
    });

    // ─── Security & Performance Plugins ──────────────────────────

    await fastify.register(jwtPlugin);

    // CORS — configurable via CORS_ORIGIN env var
    const corsOrigin = config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map(o => o.trim());
    await fastify.register(fastifyCors, { origin: corsOrigin });

    // Helmet — security headers (CSP, X-Frame-Options, etc.)
    await fastify.register(fastifyHelmet, {
        contentSecurityPolicy: false, // Disabled for dashboard SPA
    });

    // Compression — gzip responses
    await fastify.register(fastifyCompress);

    // Rate limiting
    await fastify.register(fastifyRateLimit, {
        max: 100,
        timeWindow: '1 minute',
        allowList: ['127.0.0.1'], // Exempt local requests (health checks)
    });

    // Serve dashboard static files
    const dashboardPath = path.join(__dirname, '..', '..', 'dashboard');
    await fastify.register(fastifyStatic, {
        root: dashboardPath,
        prefix: '/',
        decorateReply: false,
    });

    // ─── Register Routes ──────────────────────────────────────────

    await fastify.register(healthRoutes);
    await fastify.register(metricsRoutes);
    await fastify.register(authRoutes);
    await fastify.register(jobRoutes);

    return fastify;
}

// ─── Server Startup ────────────────────────────────────────────

async function main(): Promise<void> {
    const config = getConfig();

    // Initialize connections
    getPrismaClient();
    getRedisClient();

    const server = await buildServer();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Received shutdown signal');
        try {
            await server.close();
            await disconnectPrisma();
            await disconnectRedis();
            logger.info('Server shut down gracefully');
            process.exit(0);
        } catch (err) {
            logger.error({ err }, 'Error during shutdown');
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    try {
        const port = config.PORT || config.API_PORT;
        await server.listen({ port, host: config.API_HOST });
        logger.info(
            { port, host: config.API_HOST, nodeEnv: config.NODE_ENV },
            '🚀 API server started'
        );
    } catch (err) {
        logger.fatal({ err }, 'Failed to start server');
        process.exit(1);
    }
}

main();
