/**
 * Branch coverage for the OTel bootstrap when it is actually ENABLED.
 *
 * `initTelemetry` short-circuits on `OTEL_ENABLED !== 'true'`, and every
 * existing test takes that early return — so the whole body (exporter URL
 * construction, resource attribution, provider registration, the shutdown
 * closure) has never been executed by a test. That body is what runs in
 * production, and its failure mode is silent: a mistyped exporter path or a
 * dropped `setGlobalMeterProvider` produces a process that boots fine and
 * emits nothing.
 *
 * Every OTel package is mocked, so nothing opens a socket. The assertions
 * target the DECISIONS the bootstrap makes — which URL each exporter is
 * pointed at, which attributes land on the resource, which provider is
 * registered globally, and how the shutdown closure behaves when a drain
 * hangs or rejects.
 */

// ─── Mutable mock state, read by the module factories below ───────────

interface ProviderSpy {
    register: jest.Mock<void, []>;
    shutdown: jest.Mock<Promise<void>, []>;
}

const traceProviders: ProviderSpy[] = [];
const meterProviders: ProviderSpy[] = [];
const traceExporterArgs: Array<{ url?: string }> = [];
const metricExporterArgs: Array<{ url?: string }> = [];
const spanProcessorArgs: unknown[] = [];
const metricReaderArgs: Array<{ exporter?: unknown; exportIntervalMillis?: number }> = [];
const resourceArgs: Array<Record<string, unknown>> = [];

/**
 * Controls what the mocked `@opentelemetry/semantic-conventions` exports.
 * The bootstrap does `semConvMod.ATTR_SERVICE_NAME ?? 'service.name'`, so an
 * older package that lacks the symbol must still produce a usable key.
 */
const semConv: { ATTR_SERVICE_NAME?: string; ATTR_SERVICE_VERSION?: string } = {
    ATTR_SERVICE_NAME: 'service.name',
    ATTR_SERVICE_VERSION: 'service.version',
};

/** Shutdown behaviour of the providers constructed by the next init call. */
const shutdownBehaviour: {
    trace: 'resolve' | 'reject' | 'hang';
    meter: 'resolve' | 'reject' | 'hang';
} = { trace: 'resolve', meter: 'resolve' };

function makeShutdown(kind: 'trace' | 'meter'): jest.Mock<Promise<void>, []> {
    return jest.fn((): Promise<void> => {
        const mode = shutdownBehaviour[kind];
        if (mode === 'reject') return Promise.reject(new Error(`${kind} drain exploded`));
        if (mode === 'hang') return new Promise<void>(() => { /* never settles */ });
        return Promise.resolve();
    });
}

const setGlobalMeterProvider = jest.fn<void, [unknown]>();
const diagSetLogger = jest.fn<void, [unknown, unknown]>();
const pinoInfo = jest.fn<void, [unknown, string]>();

jest.mock('@opentelemetry/api', () => ({
    diag: { setLogger: (a: unknown, b: unknown) => diagSetLogger(a, b) },
    DiagConsoleLogger: class DiagConsoleLogger {},
    DiagLogLevel: { INFO: 'INFO' },
    metrics: { setGlobalMeterProvider: (p: unknown) => setGlobalMeterProvider(p) },
}));

jest.mock('@opentelemetry/resources', () => ({
    resourceFromAttributes: (attrs: Record<string, unknown>) => {
        resourceArgs.push(attrs);
        return { __resource: attrs };
    },
}));

jest.mock('@opentelemetry/semantic-conventions', () => semConv);

jest.mock('@opentelemetry/sdk-trace-node', () => ({
    NodeTracerProvider: class NodeTracerProvider {
        register: jest.Mock<void, []>;
        shutdown: jest.Mock<Promise<void>, []>;
        constructor(_cfg: unknown) {
            this.register = jest.fn<void, []>();
            this.shutdown = makeShutdown('trace');
            traceProviders.push({ register: this.register, shutdown: this.shutdown });
        }
    },
    BatchSpanProcessor: class BatchSpanProcessor {
        constructor(exporter: unknown) {
            spanProcessorArgs.push(exporter);
        }
    },
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
    OTLPTraceExporter: class OTLPTraceExporter {
        constructor(cfg: { url?: string }) {
            traceExporterArgs.push(cfg);
        }
    },
}));

jest.mock('@opentelemetry/sdk-metrics', () => ({
    MeterProvider: class MeterProvider {
        register: jest.Mock<void, []>;
        shutdown: jest.Mock<Promise<void>, []>;
        constructor(_cfg: unknown) {
            this.register = jest.fn<void, []>();
            this.shutdown = makeShutdown('meter');
            meterProviders.push({ register: this.register, shutdown: this.shutdown });
        }
    },
    PeriodicExportingMetricReader: class PeriodicExportingMetricReader {
        constructor(cfg: { exporter?: unknown; exportIntervalMillis?: number }) {
            metricReaderArgs.push(cfg);
        }
    },
}));

jest.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
    OTLPMetricExporter: class OTLPMetricExporter {
        constructor(cfg: { url?: string }) {
            metricExporterArgs.push(cfg);
        }
    },
}));

jest.mock('@/lib/observability/logger', () => ({
    pinoInstance: { info: (a: unknown, b: string) => pinoInfo(a, b) },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    initTelemetry,
    isTelemetryInitialized,
    shutdownTelemetry,
    _resetForTesting,
} from '@/lib/observability/instrumentation';

// ─── env helpers ──────────────────────────────────────────────────────
//
// This repo augments NodeJS.ProcessEnv so NODE_ENV is a REQUIRED key, which
// makes `delete process.env.NODE_ENV` a type error. Absence is precisely the
// branch under test (`process.env.NODE_ENV || 'development'`), so the cast is
// deliberate and confined to this helper. Every key touched here is saved and
// restored around each test.
type MutableEnv = Record<string, string | undefined>;
const mutableEnv = process.env as unknown as MutableEnv;

const TOUCHED_KEYS = [
    'OTEL_ENABLED',
    'OTEL_DEBUG',
    'OTEL_SERVICE_NAME',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'npm_package_version',
    'NODE_ENV',
] as const;

const savedEnv: MutableEnv = {};

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
}

beforeEach(() => {
    for (const k of TOUCHED_KEYS) savedEnv[k] = mutableEnv[k];
    traceProviders.length = 0;
    meterProviders.length = 0;
    traceExporterArgs.length = 0;
    metricExporterArgs.length = 0;
    spanProcessorArgs.length = 0;
    metricReaderArgs.length = 0;
    resourceArgs.length = 0;
    semConv.ATTR_SERVICE_NAME = 'service.name';
    semConv.ATTR_SERVICE_VERSION = 'service.version';
    shutdownBehaviour.trace = 'resolve';
    shutdownBehaviour.meter = 'resolve';
    setGlobalMeterProvider.mockClear();
    diagSetLogger.mockClear();
    pinoInfo.mockClear();
    _resetForTesting();
});

afterEach(() => {
    // Drop any live shutdown closure before restoring env, so a hung provider
    // from one test cannot leak into the next.
    shutdownBehaviour.trace = 'resolve';
    shutdownBehaviour.meter = 'resolve';
    _resetForTesting();
    for (const k of TOUCHED_KEYS) setEnv(k, savedEnv[k]);
});

/** Enable OTel with an explicit, fully-specified environment. */
function enableOtel(overrides: Record<string, string | undefined> = {}): void {
    setEnv('OTEL_ENABLED', 'true');
    setEnv('OTEL_DEBUG', undefined);
    setEnv('OTEL_SERVICE_NAME', 'lane-service');
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.test:4318');
    setEnv('npm_package_version', '9.9.9');
    setEnv('NODE_ENV', 'test');
    for (const key of Object.keys(overrides)) setEnv(key, overrides[key]);
}

describe('initTelemetry — the disabled guard', () => {
    it('constructs NOTHING when OTEL_ENABLED is absent, yet reports initialised', async () => {
        setEnv('OTEL_ENABLED', undefined);
        await initTelemetry();

        expect(traceProviders).toHaveLength(0);
        expect(meterProviders).toHaveLength(0);
        expect(setGlobalMeterProvider).not.toHaveBeenCalled();
        // The flag is set even on the disabled path — that is what makes the
        // guard idempotent rather than re-reading env on every call.
        expect(isTelemetryInitialized()).toBe(true);
    });

    it('treats any value other than the literal "true" as disabled', async () => {
        setEnv('OTEL_ENABLED', '1');
        await initTelemetry();
        expect(traceProviders).toHaveLength(0);
        expect(setGlobalMeterProvider).not.toHaveBeenCalled();
    });
});

describe('initTelemetry — enabled bootstrap', () => {
    it('points each exporter at the endpoint-derived signal path', async () => {
        enableOtel();
        await initTelemetry();

        expect(traceExporterArgs).toEqual([
            { url: 'http://collector.test:4318/v1/traces' },
        ]);
        expect(metricExporterArgs).toEqual([
            { url: 'http://collector.test:4318/v1/metrics' },
        ]);
    });

    it('falls back to the localhost collector when the endpoint is unset', async () => {
        enableOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined });
        await initTelemetry();

        expect(traceExporterArgs[0].url).toBe('http://localhost:4318/v1/traces');
        expect(metricExporterArgs[0].url).toBe('http://localhost:4318/v1/metrics');
    });

    it('names the resource from OTEL_SERVICE_NAME and stamps version + environment', async () => {
        enableOtel({ npm_package_version: '4.2.0', NODE_ENV: 'staging' });
        await initTelemetry();

        expect(resourceArgs[0]).toEqual({
            'service.name': 'lane-service',
            'service.version': '4.2.0',
            'deployment.environment': 'staging',
        });
    });

    it('falls back to the product service name, 0.0.0 and development', async () => {
        enableOtel({
            OTEL_SERVICE_NAME: undefined,
            npm_package_version: undefined,
            NODE_ENV: undefined,
        });
        await initTelemetry();

        expect(resourceArgs[0]).toEqual({
            'service.name': 'inflect-compliance',
            'service.version': '0.0.0',
            'deployment.environment': 'development',
        });
    });

    it('uses literal attribute keys when semantic-conventions omits the ATTR_* exports', async () => {
        // An older @opentelemetry/semantic-conventions does not export the
        // ATTR_* constants. The `??` fallback is what keeps the resource keyed
        // correctly instead of producing an `undefined` attribute name.
        enableOtel();
        semConv.ATTR_SERVICE_NAME = undefined;
        semConv.ATTR_SERVICE_VERSION = undefined;
        await initTelemetry();

        expect(Object.keys(resourceArgs[0]).sort()).toEqual([
            'deployment.environment',
            'service.name',
            'service.version',
        ]);
        expect(resourceArgs[0]['service.name']).toBe('lane-service');
    });

    it('registers the tracer provider and the meter provider globally', async () => {
        enableOtel();
        await initTelemetry();

        expect(traceProviders).toHaveLength(1);
        expect(traceProviders[0].register).toHaveBeenCalledTimes(1);
        expect(meterProviders).toHaveLength(1);
        expect(setGlobalMeterProvider).toHaveBeenCalledTimes(1);

        // The globally-registered meter provider must be THE one that owns the
        // configured reader — registering a different instance is how metrics
        // silently stop exporting.
        const registered = setGlobalMeterProvider.mock.calls[0][0] as {
            shutdown?: unknown;
        };
        expect(registered.shutdown).toBe(meterProviders[0].shutdown);

        expect(metricReaderArgs).toHaveLength(1);
        expect(metricReaderArgs[0].exportIntervalMillis).toBe(30_000);
        expect(metricReaderArgs[0].exporter).toBeDefined();
        expect(spanProcessorArgs).toHaveLength(1);
    });

    it('logs the bootstrap line with the resolved service name and endpoint', async () => {
        enableOtel();
        await initTelemetry();

        expect(pinoInfo).toHaveBeenCalledWith(
            {
                component: 'otel',
                serviceName: 'lane-service',
                otlpEndpoint: 'http://collector.test:4318',
            },
            'Telemetry initialized',
        );
    });

    it('does not install the diag logger unless OTEL_DEBUG is exactly "true"', async () => {
        enableOtel({ OTEL_DEBUG: 'yes' });
        await initTelemetry();
        expect(diagSetLogger).not.toHaveBeenCalled();
    });

    it('installs the diag console logger at INFO when OTEL_DEBUG is "true"', async () => {
        enableOtel({ OTEL_DEBUG: 'true' });
        await initTelemetry();
        expect(diagSetLogger).toHaveBeenCalledTimes(1);
        expect(diagSetLogger.mock.calls[0][1]).toBe('INFO');
    });

    it('is idempotent — a second init builds no second provider pair', async () => {
        enableOtel();
        await initTelemetry();
        await initTelemetry();

        expect(traceProviders).toHaveLength(1);
        expect(meterProviders).toHaveLength(1);
        expect(setGlobalMeterProvider).toHaveBeenCalledTimes(1);
    });
});

describe('shutdownTelemetry — draining a real bootstrap', () => {
    it('drains BOTH providers exactly once and clears the initialised flag', async () => {
        enableOtel();
        await initTelemetry();

        await shutdownTelemetry(1_000);

        expect(traceProviders[0].shutdown).toHaveBeenCalledTimes(1);
        expect(meterProviders[0].shutdown).toHaveBeenCalledTimes(1);
        expect(isTelemetryInitialized()).toBe(false);
    });

    it('is idempotent — the second call re-drains nothing', async () => {
        enableOtel();
        await initTelemetry();

        await shutdownTelemetry(1_000);
        await shutdownTelemetry(1_000);

        expect(traceProviders[0].shutdown).toHaveBeenCalledTimes(1);
        expect(meterProviders[0].shutdown).toHaveBeenCalledTimes(1);
    });

    it('swallows a rejecting tracer drain and still drains the meter provider', async () => {
        // Without the per-provider `.catch()`, `Promise.all` rejects and the
        // rejection escapes — turning a best-effort drain into a crash on the
        // SIGTERM path.
        enableOtel();
        shutdownBehaviour.trace = 'reject';
        await initTelemetry();

        await expect(shutdownTelemetry(1_000)).resolves.toBeUndefined();
        expect(meterProviders[0].shutdown).toHaveBeenCalledTimes(1);
    });

    it('swallows a rejecting meter drain too', async () => {
        enableOtel();
        shutdownBehaviour.meter = 'reject';
        await initTelemetry();

        await expect(shutdownTelemetry(1_000)).resolves.toBeUndefined();
        expect(traceProviders[0].shutdown).toHaveBeenCalledTimes(1);
    });

    it('resolves at the budget when a drain never settles', async () => {
        // The reason shutdown is Promise.race'd: a wedged exporter must not
        // hold the process past the container grace period.
        enableOtel();
        shutdownBehaviour.trace = 'hang';
        await initTelemetry();

        const started = Date.now();
        await shutdownTelemetry(60);
        const elapsed = Date.now() - started;

        expect(traceProviders[0].shutdown).toHaveBeenCalledTimes(1);
        // It returned because of the timer, not because the drain finished
        // (it never does).
        expect(elapsed).toBeLessThan(3_000);
    });
});
