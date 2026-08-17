/**
 * BullMQ Worker — Standalone Process Entrypoint
 *
 * Processes async jobs from the `inflect-jobs` queue.
 * Runs independently of the Next.js web server.
 *
 * Usage:
 *   npx tsx scripts/worker.ts
 *   # or in production:
 *   node --import tsx scripts/worker.ts
 *
 * Architecture:
 *   - Creates its own Redis connection (not the app singleton)
 *   - Registers processors for each typed job name
 *   - Delegates to existing business logic functions (preserving observability)
 *   - Graceful shutdown on SIGTERM/SIGINT
 *   - Structured logging via Pino
 *
 * @module scripts/worker
 */
import 'dotenv/config';
// OTel init + the job-trace seam are imported up front. `initTelemetry`
// is invoked in `bootstrap()` BEFORE the `new Worker(...)` below — the
// web tier inits OTel via `src/instrumentation.ts`, but the worker is a
// separate process that never loads that hook, so without this its job
// execution would be invisible to Tempo.
import { initTelemetry, shutdownTelemetry } from '../src/lib/observability/instrumentation';
import {
    runJobInTraceContext,
    readTraceCarrier,
    stripTraceCarrier,
} from '../src/lib/observability/job-trace';
import { Worker, Job, Queue, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import {
    QUEUE_NAME,
    type JobName,
} from '../src/app-layer/jobs/types';
import { registerSchedules } from '../src/app-layer/jobs/register-schedules';

// ─── Standalone logger ───

const log = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' } }
        : undefined,
});

// ─── Redis connection ───

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    log.fatal('REDIS_URL is not set. Cannot start worker.');
    process.exit(1);
}

// ─── GAP-03: production encryption-key fail-fast ───────────────────
//
// The Next.js server runs this check via `src/instrumentation.ts`,
// but BullMQ workers are a separate process — they bootstrap straight
// from this file and never load the instrumentation hook. Without a
// mirror check here, a worker process can boot in production with no
// encryption key, sit idle, and crash on the FIRST job that touches
// an encrypted column (Finding.description, Risk.treatmentNotes,
// PolicyVersion.contentText, …). Same blast-radius as the lazy-throw
// failure mode the audit flagged on the web tier, just shifted to
// background processing.
//
// Imports are dynamic so the worker doesn't pull the encryption
// module unless we're in production.
if (process.env.NODE_ENV === 'production') {
    (async () => {
        const { checkProductionEncryptionKey, runEncryptionSentinel } =
            await import('../src/lib/security/startup-encryption-check');

        const config = checkProductionEncryptionKey(process.env);
        if (!config.ok) {
            log.fatal('[startup] FATAL: ' + config.reason);
            process.exit(1);
        }

        const sentinel = await runEncryptionSentinel();
        if (!sentinel.ok) {
            log.fatal('[startup] FATAL: ' + sentinel.reason);
            process.exit(1);
        }

        log.info('encryption key check passed (presence + sentinel round-trip)');
    })();
}

function createWorkerConnection(): Redis {
    return new Redis(REDIS_URL!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 10000,
        connectionName: 'inflect-worker',
    });
}

// ═══════════════════════════════════════════════════════════════════
// Job Processing — Executor Registry Delegation
//
// All job dispatch is handled by the executor registry in the
// app-layer. The worker simply delegates to it. Adding a new job
// only requires registering it in executor-registry.ts — no
// worker changes needed.
//
// The registry is imported lazily (dynamic import) so that Prisma
// and other heavy modules are only loaded when the first job runs.
// ═══════════════════════════════════════════════════════════════════

// ─── Worker Bootstrap ───

log.info({ queueName: QUEUE_NAME, redisUrl: REDIS_URL.replace(/\/\/.*@/, '//***@') }, 'starting worker');

// Wire the automation bus to BullMQ so any domain event emitted from
// inside a job (e.g. a usecase running inside a scheduled sweep)
// fans back into the dispatch queue. Safe to call before executors
// register — the bus accepts a dispatcher at any point.
(async () => {
    const { installAutomationBusDispatcher } = await import(
        '../src/app-layer/automation/bus-bootstrap'
    );
    // Register all integration providers process-wide (worker tier) so
    // scheduled checks + sync jobs can resolve providers by automation key.
    await import('../src/app-layer/integrations/bootstrap');
    const { startIntegrationFreshnessReporting } = await import('../src/lib/observability/integration-metrics');
    startIntegrationFreshnessReporting();
    const { installRlsTripwire } = await import(
        '../src/lib/db/rls-middleware'
    );
    const { prisma } = await import('../src/lib/prisma');
    installAutomationBusDispatcher();
    installRlsTripwire(prisma);
    // Swap the mailer to SMTP when configured — the worker runs the
    // notification outbox + digests, which send email. Without this the
    // worker stays on the console sink and those emails never deliver.
    const { initMailerFromEnv } = await import('../src/lib/mailer');
    initMailerFromEnv();
    log.info('automation bus dispatcher + RLS tripwire + mailer installed');
})();

// The Worker and its Redis connection are created inside bootstrap()
// (below) so OTel is initialised before the first job runs. Declared at
// module scope so the graceful-shutdown handler can close them.
let connection: Redis | undefined;
let worker: Worker | undefined;

// ─── Boot-time schedule self-registration (item 28) ───
//
// A running worker must ALWAYS imply the repeatable cron schedules
// exist. Previously the deploy relied solely on the one-shot
// `scripts/scheduler.ts` running before the worker
// (`node scheduler && node worker`); if that step was skipped or the
// VM's hand-managed compose drifted off it, the repeatable jobs were
// never registered and nothing ever enqueued the daily
// `task-due-notification` scan — the in-app deadline reminders
// silently never fired. `upsertJobScheduler` is idempotent, so
// registering here on every boot is safe and removes that single
// point of failure. Failure-soft: a registration error is logged but
// must NOT stop the worker from coming up to drain already-enqueued
// jobs (the standalone scheduler step is still the explicit path).
(async () => {
    const schedulerQueue = new Queue(QUEUE_NAME, { connection: createWorkerConnection() });
    try {
        const count = await registerSchedules(schedulerQueue, log);
        log.info({ count }, 'repeatable schedules registered on worker boot');
    } catch (err) {
        log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'failed to register repeatable schedules on boot — cron jobs may not fire until the scheduler step runs',
        );
    } finally {
        await schedulerQueue.close();
    }
})();

// ═══════════════════════════════════════════════════════════════════
// Worker bootstrap.
//
// OTel MUST be initialised before the Worker starts processing jobs so
// the job-execution spans (and the usecase/repository spans nested
// under them) export to Tempo. `initTelemetry()` is a fast no-op when
// `OTEL_ENABLED` is unset, so dev/test pay nothing.
// ═══════════════════════════════════════════════════════════════════
async function bootstrap(): Promise<void> {
    await initTelemetry();

    // Register the DAU/MAU observable gauges (business KPIs). The
    // callbacks read the cached snapshot the `dau-mau-aggregator` job
    // refreshes every 5 min — cheap at scrape time. Idempotent.
    const { startActiveUserGauges } = await import('../src/lib/observability/business-metrics');
    startActiveUserGauges();

    connection = createWorkerConnection();

    worker = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
            const jobName = job.name as JobName;

            // Lazy-import the executor registry on first job
            const { executorRegistry } = await import('../src/app-layer/jobs/executor-registry');

            if (!executorRegistry.has(jobName)) {
                log.warn({ jobName, jobId: job.id }, 'no executor registered for job — skipping');
                return { skipped: true, reason: `no executor for "${jobName}"` };
            }

            // Extract the W3C trace carrier the web tier stashed at enqueue
            // time and run the job inside a span that is a child of the
            // originating HTTP-handler span. The carrier is stripped before
            // the payload reaches the executor (and before it is logged).
            return runJobInTraceContext(
                readTraceCarrier(job.data),
                `execute ${jobName}`,
                {
                    'job.name': jobName,
                    'job.id': job.id ?? 'unknown',
                    'job.attempts': job.attemptsMade,
                    'messaging.system': 'bullmq',
                    'messaging.destination.name': QUEUE_NAME,
                    'messaging.operation': 'process',
                    'messaging.message.id': job.id ?? 'unknown',
                },
                async () => {
                    const startTime = performance.now();
                    const payload = stripTraceCarrier(job.data as Record<string, unknown>);

                    log.info({ jobName, jobId: job.id, payload }, 'processing job');

                    // GAP-22: forward the BullMQ Job's progress channel so
                    // executors that report mid-run progress (currently
                    // tenant-dek-rotation) surface it via `GET .../?jobId=…`
                    // without depending on bullmq from the executor side.
                    const result = await executorRegistry.execute(jobName, payload, {
                        updateProgress: (p) => job.updateProgress(p as object | number),
                    });
                    const durationMs = Math.round(performance.now() - startTime);

                    if (!result.success) {
                        log.error({
                            jobName,
                            jobId: job.id,
                            attemptsMade: job.attemptsMade,
                            durationMs,
                            errorMessage: result.errorMessage,
                        }, 'job processing failed');

                        // Thrown inside the trace span so it is marked ERROR
                        // and recorded, then re-thrown for BullMQ's retry.
                        //
                        // `noRetry` opts out of that retry. A revoked
                        // credential and a rate limit both FAIL, but retrying
                        // either in 5s is worse than not retrying: the first
                        // delays every other tenant in the fan-out, the second
                        // answers a throttle with three more full syncs.
                        // UnrecoverableError makes BullMQ record the failure
                        // and stop, leaving the next scheduled tick to retry.
                        const message = result.errorMessage || `Job "${jobName}" failed`;
                        throw result.noRetry ? new UnrecoverableError(message) : new Error(message);
                    }

                    log.info({
                        jobName,
                        jobId: job.id,
                        attemptsMade: job.attemptsMade,
                        durationMs,
                        itemsScanned: result.itemsScanned,
                        itemsActioned: result.itemsActioned,
                    }, 'job processed successfully');

                    return result;
                },
            );
        },
        {
            connection,
            concurrency: 5,
            limiter: {
                max: 50,
                duration: 60000,
            },
        },
    );

    // ─── Worker Events ───

    worker.on('ready', () => {
        log.info({
            queueName: QUEUE_NAME,
            note: 'Dispatch via executor-registry (lazy-loaded on first job)',
        }, 'worker ready — listening for jobs');
    });

    worker.on('failed', (job, error) => {
        log.error({
            jobName: job?.name,
            jobId: job?.id,
            attemptsMade: job?.attemptsMade,
            err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        }, 'job failed (BullMQ event)');
    });

    worker.on('stalled', (jobId) => {
        log.warn({ jobId }, 'job stalled — will be retried');
    });

    worker.on('error', (error) => {
        log.error({
            err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        }, 'worker error');
    });
}

void bootstrap().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker bootstrap failed');
    process.exit(1);
});

// ─── Graceful Shutdown ───

async function shutdown(signal: string) {
    log.info({ signal }, 'shutdown signal received — closing worker');

    try {
        await worker?.close();
        await connection?.quit();
        // Drain in-flight OTel span batches before exit so the final
        // jobs' execution spans reach Tempo (bounded + never throws).
        await shutdownTelemetry().catch(() => { /* best-effort */ });
        log.info('worker shut down gracefully');
        process.exit(0);
    } catch (error) {
        log.error({ err: error }, 'error during shutdown');
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info('worker process started — press Ctrl+C to stop');
