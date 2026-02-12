import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

const envSchema = z.object({
    // Database
    DATABASE_URL: z.string().url(),

    // Redis
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // API — Railway injects PORT, so support both
    PORT: z.coerce.number().optional(),
    API_PORT: z.coerce.number().default(3000),
    API_HOST: z.string().default('0.0.0.0'),

    // Auth
    JWT_SECRET: z.string().min(8),
    ADMIN_PASSWORD: z.string().min(8).default('admin@123!'),
    EMPLOYEE_PASSWORD: z.string().min(8).default('employee@123!'),

    // CORS
    CORS_ORIGIN: z.string().default('*'), // Set to specific origin in production

    // Worker
    WORKER_CONCURRENCY: z.coerce.number().min(1).max(100).default(10),
    WORKER_QUEUES: z.string().default('default'),
    WORKER_ID: z.string().default(`worker-${process.pid}`),

    // Queue
    DEFAULT_MAX_RETRIES: z.coerce.number().default(5),
    RETRY_BASE_DELAY_MS: z.coerce.number().default(1000),
    VISIBILITY_TIMEOUT_MS: z.coerce.number().default(30000),
    POISON_PILL_THRESHOLD: z.coerce.number().default(3),
    POISON_PILL_WINDOW_MS: z.coerce.number().default(60000),

    // Logging
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
    if (!_config) {
        const parsed = envSchema.safeParse(process.env);
        if (!parsed.success) {
            console.error('❌ Invalid environment variables:');
            console.error(parsed.error.format());
            process.exit(1);
        }
        _config = parsed.data;

        // Warn if JWT_SECRET is default in production
        if (
            _config.NODE_ENV === 'production' &&
            (_config.JWT_SECRET.includes('change-me') || _config.JWT_SECRET.includes('dev-secret'))
        ) {
            console.error('⚠️  WARNING: JWT_SECRET is set to a default value. Change it in production!');
        }
    }
    return _config;
}

export function getWorkerQueues(): string[] {
    return getConfig().WORKER_QUEUES.split(',').map((q) => q.trim()).filter(Boolean);
}
