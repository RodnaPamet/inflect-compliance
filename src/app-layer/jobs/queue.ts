/**
 * Job Queue — BullMQ Queue Abstraction
 *
 * Provides a type-safe enqueue interface for all async jobs.
 * Uses the shared Redis helper from `@/lib/redis` and the typed
 * job contracts from `./types`.
 *
 * Architecture:
 *   - Single BullMQ Queue instance (singleton, HMR-safe)
 *   - Type-safe `enqueue<T>(name, payload, options?)` function
 *   - Default retry/backoff from JOB_DEFAULTS
 *   - Jobs are serialized as JSON into Redis by BullMQ
 *
 * Usage:
 *   import { enqueue } from '@/app-layer/jobs/queue';
 *   await enqueue('health-check', { enqueuedAt: new Date().toISOString() });
 *   await enqueue('automation-runner', { tenantId: 'xyz', dryRun: false });
 *
 * @module app-layer/jobs/queue
 */
import { Queue, type JobsOptions, type ConnectionOptions } from 'bullmq';
import { propagation, trace, context as otelContext, SpanStatusCode } from '@opentelemetry/api';
import { createRedisClient } from '@/lib/redis';
import { QUEUE_NAME, JOB_DEFAULTS, type JobName, type JobPayload } from './types';
import { OTEL_CARRIER_KEY } from '@/lib/observability/job-trace';
import { isValidBullMqJobId } from './fan-out';
import { logger } from '@/lib/observability/logger';

// ─── Singleton queue (survives HMR) ───

const globalForQueue = globalThis as unknown as {
    __bullmq_queue?: Queue;
};

/**
 * Returns the shared BullMQ Queue instance.
 * Creates one lazily on first call.
 *
 * NOTE: Uses `createRedisClient()` (not the singleton) because
 * BullMQ manages its own connection lifecycle.
 */
export function getQueue(): Queue {
    if (!globalForQueue.__bullmq_queue) {
        const connection = createRedisClient();

        globalForQueue.__bullmq_queue = new Queue(QUEUE_NAME, {
            // `connection` is an ioredis@5.11 instance; bullmq bundles
            // its own (exact-pinned) ioredis@5.10 types, so the two
            // `Redis` type copies diverge on the `Connector` property
            // even though the runtime API is identical and bullmq uses
            // the instance we pass. Cast across the duplicate-type gap.
            connection: connection as ConnectionOptions,
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 500,
                removeOnFail: 1000,
            },
        });

        logger.info('BullMQ queue initialized', {
            component: 'queue',
            queueName: QUEUE_NAME,
        });
    }

    return globalForQueue.__bullmq_queue;
}

/**
 * Enqueue a typed job.
 *
 * @param name — job name (must be a key of JobPayloadMap)
 * @param payload — typed payload (must match the job's payload type)
 * @param options — optional BullMQ job options (overrides defaults)
 * @returns the BullMQ Job instance
 *
 * @example
 *   await enqueue('health-check', { enqueuedAt: new Date().toISOString() });
 *   await enqueue('automation-runner', { tenantId: 'abc' }, { priority: 1 });
 */
export async function enqueue<T extends JobName>(
    name: T,
    payload: JobPayload<T>,
    options?: Partial<JobsOptions>,
) {
    // THE ONE PLACE THIS CAN BE ENFORCED ONCE. Every job in the system is
    // enqueued through this function, so a custom id is checked here or at no
    // call site at all.
    //
    // #3554: the control-test scheduler hand-rolled `ctr:{planId}:{iso}`, BullMQ
    // rejected all ~4,300 enqueues over seven days, and nothing noticed —
    // the scheduler's failure path rolled its DB claim back cleanly every time,
    // so a permanent error looked exactly like a transient one being retried.
    //
    // Thrown as a precondition, before the queue or the span exist: an invalid
    // custom id is a programming error, and failing on the caller's own stack
    // names the site better than a span event would.
    if (options?.jobId !== undefined && !isValidBullMqJobId(options.jobId)) {
        throw new Error(
            `enqueue(${name}): jobId "${options.jobId}" is not a valid BullMQ custom id. ` +
                'BullMQ accepts a colon only when the id splits into exactly three parts; ' +
                'build ids with dispatchJobId() or scheduledJobId() rather than by hand.',
        );
    }

    const queue = getQueue();
    const defaults = JOB_DEFAULTS[name];
    const tracer = trace.getTracer('inflect.jobs');

    // Wrap the enqueue in an active span and inject the W3C trace
    // context INSIDE it, so the carrier points at this `enqueue` span.
    // The worker then links the job-execution span as a child of it —
    // giving Tempo the full chain: HTTP handler ▸ enqueue ▸ execute.
    return tracer.startActiveSpan(
        `enqueue ${name}`,
        {
            attributes: {
                'job.name': name,
                // Canonical messaging.* semantic-convention attributes so
                // Tempo's trace search can filter by queue/operation. Set
                // manually rather than via an auto-instrumentation package
                // (see docs/observability/05-job-tracing.md for why).
                'messaging.system': 'bullmq',
                'messaging.destination.name': QUEUE_NAME,
                'messaging.operation': 'publish',
                ...(payload && typeof payload === 'object' && 'tenantId' in payload
                    ? { 'app.tenantId': String((payload as Record<string, unknown>).tenantId) }
                    : {}),
            },
        },
        async (span) => {
            try {
                const carrier: Record<string, string> = {};
                propagation.inject(otelContext.active(), carrier);

                // The carrier rides as an untyped sibling of the typed
                // payload under a namespaced sentinel key; executors never
                // see it (the worker strips it on pickup).
                const augmentedPayload = { ...payload, [OTEL_CARRIER_KEY]: carrier };

                const job = await queue.add(name, augmentedPayload, {
                    attempts: defaults.attempts,
                    backoff: defaults.backoff,
                    removeOnComplete: defaults.removeOnComplete,
                    removeOnFail: defaults.removeOnFail,
                    ...options,
                });

                span.setAttribute('job.id', job.id ?? 'unknown');
                span.setAttribute('messaging.message.id', job.id ?? 'unknown');
                span.setStatus({ code: SpanStatusCode.OK });

                logger.info('job enqueued', {
                    component: 'queue',
                    jobName: name,
                    jobId: job.id,
                });

                return job;
            } catch (err) {
                if (err instanceof Error) {
                    span.recordException(err);
                }
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: err instanceof Error ? err.message : String(err),
                });
                throw err;
            } finally {
                span.end();
            }
        },
    );
}

/**
 * Close the queue connection (for graceful shutdown).
 */
export async function closeQueue(): Promise<void> {
    if (globalForQueue.__bullmq_queue) {
        await globalForQueue.__bullmq_queue.close();
        globalForQueue.__bullmq_queue = undefined;
        logger.info('BullMQ queue closed', { component: 'queue' });
    }
}
