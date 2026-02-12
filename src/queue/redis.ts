import Redis from 'ioredis';
import { getConfig } from '../config';
import { getLogger } from '../utils/logger';

const logger = getLogger().child({ module: 'redis' });

let _redis: Redis | null = null;
let _subscriber: Redis | null = null;

/**
 * Get the singleton Redis client for commands.
 */
export function getRedisClient(): Redis {
    if (!_redis) {
        const config = getConfig();
        _redis = new Redis(config.REDIS_URL, {
            maxRetriesPerRequest: null, // Required for blocking commands
            enableReadyCheck: true,
            retryStrategy(times: number) {
                const delay = Math.min(times * 200, 5000);
                logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting');
                return delay;
            },
        });

        _redis.on('connect', () => logger.info('Redis connected'));
        _redis.on('ready', () => logger.info('Redis ready'));
        _redis.on('error', (err) => logger.error({ err }, 'Redis error'));
        _redis.on('close', () => logger.warn('Redis connection closed'));
    }
    return _redis;
}

/**
 * Get a separate Redis client for subscriber patterns (if needed).
 */
export function getRedisSubscriber(): Redis {
    if (!_subscriber) {
        const config = getConfig();
        _subscriber = new Redis(config.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
        });
    }
    return _subscriber;
}

/**
 * Gracefully disconnect all Redis clients.
 */
export async function disconnectRedis(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (_redis) {
        promises.push(
            _redis.quit().then(() => {
                _redis = null;
                logger.info('Redis client disconnected');
            })
        );
    }

    if (_subscriber) {
        promises.push(
            _subscriber.quit().then(() => {
                _subscriber = null;
                logger.info('Redis subscriber disconnected');
            })
        );
    }

    await Promise.all(promises);
}
