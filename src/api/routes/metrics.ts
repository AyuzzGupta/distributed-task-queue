import { FastifyInstance } from 'fastify';
import { metricsRegistry, queueSize } from '../../metrics';
import { getQueueSize, getProcessingCount, getDLQSize, getDelayedCount } from '../../queue';
import { getLogger } from '../../utils/logger';

const logger = getLogger().child({ module: 'routes:metrics' });

export default async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get('/metrics', async (_request, reply) => {
        try {
            // Update queue size gauges before reporting
            const queues = ['default', 'emails', 'notifications'];

            for (const queue of queues) {
                try {
                    const waiting = await getQueueSize(queue);
                    const processing = await getProcessingCount(queue);
                    const dlq = await getDLQSize(queue);
                    const delayed = await getDelayedCount(queue);

                    queueSize.set({ queue, status: 'waiting' }, waiting);
                    queueSize.set({ queue, status: 'processing' }, processing);
                    queueSize.set({ queue, status: 'dlq' }, dlq);
                    queueSize.set({ queue, status: 'delayed' }, delayed);
                } catch (err) {
                    logger.warn({ queue, err }, 'Failed to fetch queue metrics');
                }
            }

            const metrics = await metricsRegistry.metrics();
            reply
                .header('Content-Type', metricsRegistry.contentType)
                .send(metrics);
        } catch (err) {
            logger.error({ err }, 'Failed to generate metrics');
            reply.status(500).send('Failed to generate metrics');
        }
    });
}
