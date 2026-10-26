/**
 * The BullMQ worker reports its queue's depth, and stops reading the queue on
 * shutdown before the connection the reads use is closed.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `startQueueDepthReporting` registered the `job.queue.depth` gauge and had no
 * caller outside tests, so `job_queue_depth_ratio` never existed and the rule,
 * alert and panel that read it were removed (#4339). The worker now calls it.
 * A source scan for the call would pass with the call in the wrong place, so
 * this boots the real `scripts/worker.ts` — every dependency that would open a
 * socket or a database connection is mocked — and asserts on what it does:
 *
 *   · the gauge reaches the meter provider `initTelemetry()` installs. The
 *     OTel metrics API has no proxy provider: a gauge created before the
 *     provider is set is a no-op for the life of the process. So a call moved
 *     above `initTelemetry()` fails here, and so does a removed call;
 *   · a collection reads the queue this worker serves (`QUEUE_NAME`), through
 *     the worker's own Redis connection rather than a new one;
 *   · on SIGTERM the reporter stops before its Queue and the connection are
 *     closed, so the final metrics flush in `shutdownTelemetry()` reads
 *     nothing.
 *
 * The meter provider is a recording fake registered through the REAL
 * `@opentelemetry/api`, so the noop-before-registration behaviour is the
 * library's, not a model of it.
 */
import { metrics } from '@opentelemetry/api';

import { QUEUE_NAME } from '@/app-layer/jobs/types';

// ─── What the mocks record ─────────────────────────────────────────────

/** Lifecycle events in the order they happened. */
const events: string[] = [];

type Observation = { value: number; attrs: Record<string, unknown> | undefined };
type ObserveResult = { observe: (value: number, attrs?: Record<string, unknown>) => void };
type GaugeCallback = (result: ObserveResult) => void | Promise<void>;

/** Observable-gauge callbacks registered on the recording meter, by instrument name. */
const gaugeCallbacks = new Map<string, GaugeCallback>();

/** What the final metrics flush inside `shutdownTelemetry()` observed. */
const flushObservations: Observation[][] = [];

async function collect(name: string): Promise<Observation[]> {
    const cb = gaugeCallbacks.get(name);
    if (!cb) throw new Error(`gauge ${name} is not registered on the installed meter provider`);
    const observed: Observation[] = [];
    await cb({ observe: (value, attrs) => observed.push({ value, attrs }) });
    return observed;
}

const noopInstrument = { add() {}, record() {}, addCallback() {}, removeCallback() {} };

/** Stands in for the SDK MeterProvider that `initTelemetry()` registers globally. */
const recordingMeterProvider = {
    getMeter: () => ({
        createCounter: () => noopInstrument,
        createUpDownCounter: () => noopInstrument,
        createHistogram: () => noopInstrument,
        createGauge: () => noopInstrument,
        createObservableCounter: () => noopInstrument,
        createObservableUpDownCounter: () => noopInstrument,
        createObservableGauge: (name: string) => ({
            addCallback: (cb: GaugeCallback) => {
                events.push(`gauge registered: ${name}`);
                gaugeCallbacks.set(name, cb);
            },
            removeCallback: () => {},
        }),
        addBatchObservableCallback: () => {},
        removeBatchObservableCallback: () => {},
    }),
};

interface FakeRedis {
    readonly id: number;
    quit: jest.Mock;
}
const redisConnections: FakeRedis[] = [];

interface FakeQueue {
    readonly name: string;
    readonly opts: { connection?: unknown };
    on: jest.Mock;
    close: jest.Mock;
    getJobCounts: jest.Mock;
}
const queues: FakeQueue[] = [];

interface FakeWorker {
    readonly name: string;
    readonly opts: { connection?: unknown };
    on: jest.Mock;
    close: jest.Mock;
}
const workers: FakeWorker[] = [];

const depthQueueOf = (): FakeQueue => {
    const worker = workers[0];
    const shared = queues.filter((q) => q.opts.connection === worker.opts.connection);
    if (shared.length !== 1) throw new Error(`expected one Queue on the worker's connection, found ${shared.length}`);
    return shared[0];
};

// ─── Mocks: nothing here opens a socket or touches a database ─────────

jest.mock('dotenv/config', () => ({}));

jest.mock('pino', () => () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
}));

jest.mock('ioredis', () =>
    jest.fn().mockImplementation(() => {
        const conn: FakeRedis = {
            id: redisConnections.length,
            quit: jest.fn(async () => {
                events.push(`redis ${conn.id} quit`);
                return 'OK';
            }),
        };
        redisConnections.push(conn);
        return conn;
    }),
);

jest.mock('bullmq', () => {
    class Queue {
        readonly on = jest.fn();
        readonly close: jest.Mock;
        readonly getJobCounts = jest.fn(async (...states: string[]) => {
            events.push(`queue read: ${this.name}`);
            return Object.fromEntries(states.map((s, i) => [s, i + 1]));
        });
        constructor(readonly name: string, readonly opts: { connection?: unknown }) {
            const index = queues.length;
            this.close = jest.fn(async () => {
                events.push(`queue ${index} closed`);
            });
            queues.push(this as unknown as FakeQueue);
        }
    }
    class Worker {
        readonly on = jest.fn();
        readonly close = jest.fn(async () => {
            events.push('worker closed');
        });
        constructor(readonly name: string, _processor: unknown, readonly opts: { connection?: unknown }) {
            workers.push(this as unknown as FakeWorker);
        }
    }
    class UnrecoverableError extends Error {}
    return { Queue, Worker, UnrecoverableError };
});

jest.mock('@/lib/observability/instrumentation', () => ({
    initTelemetry: jest.fn(async () => {
        events.push('initTelemetry');
        // What the real one does when OTEL_ENABLED=true, minus the exporters.
        // `require` so the factory reads the global the worker's copy reads.
        const { metrics: api } = jest.requireActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
        api.setGlobalMeterProvider(recordingMeterProvider as unknown as Parameters<typeof api.setGlobalMeterProvider>[0]);
    }),
    shutdownTelemetry: jest.fn(async () => {
        events.push('shutdownTelemetry');
        // The meter provider's shutdown flushes once more, which runs every
        // observable callback. Model that collection.
        if (gaugeCallbacks.has('job.queue.depth')) flushObservations.push(await collect('job.queue.depth'));
    }),
}));

jest.mock('@/lib/agentic/in-flight-runs', () => ({
    pauseInFlightRuns: jest.fn(async () => {
        events.push('pauseInFlightRuns');
        return { attempted: 0, paused: 0, timedOut: false };
    }),
}));

jest.mock('@/lib/observability/job-trace', () => ({
    runJobInTraceContext: jest.fn(),
    readTraceCarrier: jest.fn(),
    stripTraceCarrier: jest.fn(),
}));

jest.mock('@/app-layer/jobs/worker-heartbeat', () => ({ beat: jest.fn() }));
jest.mock('@/app-layer/jobs/register-schedules', () => ({ registerSchedules: jest.fn(async () => 0) }));

// Dynamically imported by the worker's boot IIFEs and bootstrap().
jest.mock('@/app-layer/automation/bus-bootstrap', () => ({ installAutomationBusDispatcher: jest.fn() }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/lib/observability/integration-metrics', () => ({ startIntegrationFreshnessReporting: jest.fn() }));
jest.mock('@/lib/db/rls-middleware', () => ({ installRlsTripwire: jest.fn() }));
jest.mock('@/lib/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/mailer', () => ({ initMailerFromEnv: jest.fn() }));
jest.mock('@/lib/observability/business-metrics', () => ({ startActiveUserGauges: jest.fn() }));

// ─── Booting the real worker module ────────────────────────────────────

type SignalHandler = () => Promise<void> | void;
let signalHandlers: Map<string, SignalHandler>;
let exitCodes: Array<number | undefined>;
const savedRedisUrl = process.env.REDIS_URL;

async function flushAsync(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Import `scripts/worker.ts` in a fresh module registry and wait for bootstrap() to finish. */
async function bootWorker(): Promise<void> {
    jest.isolateModules(() => {
        require('../../scripts/worker');
    });
    for (let i = 0; i < 50 && workers.length === 0; i++) await flushAsync(1);
    if (workers.length === 0) throw new Error('bootstrap() never constructed the BullMQ Worker');
    // Let the boot IIFEs (schedule registration and its Queue close) settle too.
    await flushAsync();
}

beforeEach(() => {
    events.length = 0;
    gaugeCallbacks.clear();
    flushObservations.length = 0;
    redisConnections.length = 0;
    queues.length = 0;
    workers.length = 0;
    metrics.disable();

    process.env.REDIS_URL = 'redis://worker-test.invalid:6379';
    signalHandlers = new Map();
    exitCodes = [];
    jest.spyOn(process, 'on').mockImplementation(((event: string, handler: SignalHandler) => {
        signalHandlers.set(event, handler);
        return process;
    }) as unknown as typeof process.on);
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCodes.push(code);
        return undefined as never;
    }) as typeof process.exit);
});

afterEach(() => {
    jest.restoreAllMocks();
    metrics.disable();
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('the BullMQ worker registers the queue-depth gauge', () => {
    it('registers job.queue.depth on the meter provider initTelemetry installs', async () => {
        await bootWorker();

        expect(exitCodes).toEqual([]);
        // Registered at all, and after telemetry: before it, the global meter
        // is the API's noop and the recording provider never hears of it.
        expect(gaugeCallbacks.has('job.queue.depth')).toBe(true);
        expect(events.indexOf('initTelemetry')).toBeLessThan(events.indexOf('gauge registered: job.queue.depth'));
    });

    it('reads the queue the worker serves, through the worker\'s own connection', async () => {
        await bootWorker();

        const observed = await collect('job.queue.depth');

        const worker = workers[0];
        const depthQueue = depthQueueOf();
        expect(worker.name).toBe(QUEUE_NAME);
        expect(depthQueue.name).toBe(QUEUE_NAME);
        // One read, of that queue, per collection.
        expect(events.filter((e) => e.startsWith('queue read'))).toEqual([`queue read: ${QUEUE_NAME}`]);
        expect(depthQueue.getJobCounts).toHaveBeenCalledTimes(1);
        // The label names the queue that was read.
        expect(observed.length).toBeGreaterThan(0);
        expect(new Set(observed.map((o) => o.attrs?.['queue.name']))).toEqual(new Set([QUEUE_NAME]));
        expect(observed.map((o) => o.attrs?.['queue.state'])).toEqual(
            depthQueue.getJobCounts.mock.calls[0],
        );
        // No Redis connection beyond the two the worker already opened: the
        // main one and the boot-time schedule registration's.
        expect(redisConnections).toHaveLength(2);
    });

    it('does not read the queue at registration, only when metrics are collected', async () => {
        await bootWorker();

        expect(depthQueueOf().getJobCounts).not.toHaveBeenCalled();
    });
});

describe('the BullMQ worker stops the queue-depth reporter on shutdown', () => {
    it('stops reading before the queue and its connection close, so the final flush reads nothing', async () => {
        await bootWorker();
        expect(await collect('job.queue.depth')).not.toEqual([]);
        const depthQueue = depthQueueOf();
        const sharedConnection = workers[0].opts.connection as FakeRedis;

        const sigterm = signalHandlers.get('SIGTERM');
        if (!sigterm) throw new Error('the worker registered no SIGTERM handler');
        await sigterm();

        expect(exitCodes).toEqual([0]);
        // shutdownTelemetry()'s flush ran the callback, and it read nothing.
        expect(flushObservations).toEqual([[]]);
        expect(depthQueue.getJobCounts).toHaveBeenCalledTimes(1);

        const depthQueueClosed = `queue ${queues.indexOf(depthQueue)} closed`;
        const shutdownOrder = events.filter((e) =>
            ['worker closed', depthQueueClosed, `redis ${sharedConnection.id} quit`, 'shutdownTelemetry'].includes(e),
        );
        expect(shutdownOrder).toEqual([
            'worker closed',
            depthQueueClosed,
            `redis ${sharedConnection.id} quit`,
            'shutdownTelemetry',
        ]);
    });

    it('still quits Redis and drains telemetry when closing the reader\'s Queue fails', async () => {
        await bootWorker();
        depthQueueOf().close.mockRejectedValueOnce(new Error('Connection is closed.'));
        const sharedConnection = workers[0].opts.connection as FakeRedis;

        await signalHandlers.get('SIGTERM')?.();

        expect(exitCodes).toEqual([0]);
        expect(events).toContain(`redis ${sharedConnection.id} quit`);
        expect(events).toContain('shutdownTelemetry');
    });
});
