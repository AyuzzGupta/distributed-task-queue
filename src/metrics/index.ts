import client, { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// Create a custom registry so we don't pollute the global one
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (event loop lag, memory, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ─── Job Counters ──────────────────────────────────────────────

export const jobsCreatedTotal = new Counter({
    name: 'taskqueue_jobs_created_total',
    help: 'Total number of jobs created',
    labelNames: ['queue', 'priority'] as const,
    registers: [metricsRegistry],
});

export const jobsCompletedTotal = new Counter({
    name: 'taskqueue_jobs_completed_total',
    help: 'Total number of jobs completed successfully',
    labelNames: ['queue', 'type'] as const,
    registers: [metricsRegistry],
});

export const jobsFailedTotal = new Counter({
    name: 'taskqueue_jobs_failed_total',
    help: 'Total number of jobs that failed',
    labelNames: ['queue', 'type'] as const,
    registers: [metricsRegistry],
});

export const jobsRetriedTotal = new Counter({
    name: 'taskqueue_jobs_retried_total',
    help: 'Total number of job retries',
    labelNames: ['queue', 'type'] as const,
    registers: [metricsRegistry],
});

export const jobsDeadTotal = new Counter({
    name: 'taskqueue_jobs_dead_total',
    help: 'Total number of jobs moved to DLQ',
    labelNames: ['queue', 'type'] as const,
    registers: [metricsRegistry],
});

// ─── Job Processing Duration ───────────────────────────────────

export const jobProcessingDuration = new Histogram({
    name: 'taskqueue_job_processing_duration_seconds',
    help: 'Duration of job processing in seconds',
    labelNames: ['queue', 'type', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [metricsRegistry],
});

// ─── Queue Gauges ──────────────────────────────────────────────

export const queueSize = new Gauge({
    name: 'taskqueue_queue_size',
    help: 'Current number of jobs in queue',
    labelNames: ['queue', 'status'] as const,
    registers: [metricsRegistry],
});

// ─── Worker Gauges ─────────────────────────────────────────────

export const activeWorkers = new Gauge({
    name: 'taskqueue_active_workers',
    help: 'Number of active workers',
    registers: [metricsRegistry],
});

export const workerActiveJobs = new Gauge({
    name: 'taskqueue_worker_active_jobs',
    help: 'Number of jobs currently being processed by this worker',
    labelNames: ['worker_id'] as const,
    registers: [metricsRegistry],
});
