/**
 * OpenTelemetry SDK Bootstrap — initializes tracing and metrics.
 *
 * GUARDED: Does nothing unless `OTEL_ENABLED=true` env var is set.
 * This ensures zero overhead in dev/test when no collector is running.
 *
 * ENV VARS:
 *   OTEL_ENABLED               — "true" to activate (default: off)
 *   OTEL_SERVICE_NAME           — service resource name (default: "inflect-compliance")
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP HTTP endpoint (default: "http://localhost:4318")
 *
 * USAGE:
 *   Called from `src/instrumentation.ts` (Next.js register hook).
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';

import { rebindObservables } from './observable-registry';

let _initialized = false;
/**
 * Populated by initTelemetry when providers are successfully created.
 * shutdownTelemetry drains both on the graceful-shutdown path.
 * Null when OTel is disabled (the guard short-circuits init).
 */
let _shutdown: (() => Promise<void>) | null = null;

/**
 * Initialize OpenTelemetry SDK (traces + metrics).
 * Safe to call multiple times — only initializes once.
 */
export async function initTelemetry(): Promise<void> {
    if (_initialized) return;

    const enabled = process.env.OTEL_ENABLED === 'true';
    if (!enabled) {
        _initialized = true;
        return;
    }

    // Optional: enable OTel diagnostic logging for debugging
    if (process.env.OTEL_DEBUG === 'true') {
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    }

    const serviceName = process.env.OTEL_SERVICE_NAME || 'inflect-compliance';
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

    // Dynamic imports to avoid loading heavy modules when OTel is disabled
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const semConvMod = await import('@opentelemetry/semantic-conventions');
    const ATTR_SERVICE_NAME = semConvMod.ATTR_SERVICE_NAME ?? 'service.name';
    const ATTR_SERVICE_VERSION = semConvMod.ATTR_SERVICE_VERSION ?? 'service.version';
    const { TracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');

    const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
        'deployment.environment': process.env.NODE_ENV || 'development',
    });

    // ── Traces ──
    const traceExporter = new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
    });

    const tracerProvider = new TracerProvider({
        resource,
        // 3.0.0 takes an OPTIONS BAG, not the exporter positionally.
        spanProcessors: [new BatchSpanProcessor({ exporter: traceExporter })],
    });

    // `register()` IS GONE IN 3.0.0, AND IT DID TWO THINGS. The consolidated
    // `@opentelemetry/sdk-trace` replaced `sdk-trace-node` (which has no 3.x at
    // all) and its `TracerProvider` carries only `getTracer`, `forceFlush` and
    // `shutdown` — so both halves of the old call have to be made explicitly.
    //
    // The second half is the one that would go wrong quietly. Setting the
    // global provider alone makes spans record; without the async context
    // manager every span is a ROOT, because the parent cannot be read back
    // across an await. Traces would still arrive, still look plausible, and
    // carry no parent-child structure — which is not something a green CI run
    // can see.
    const { AsyncLocalStorageContextManager } = await import(
        '@opentelemetry/context-async-hooks'
    );
    const {
        trace,
        context: otelContext,
        propagation,
    } = await import('@opentelemetry/api');
    const { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } =
        await import('@opentelemetry/core');

    otelContext.setGlobalContextManager(
        new AsyncLocalStorageContextManager().enable(),
    );
    trace.setGlobalTracerProvider(tracerProvider);
    // THE THIRD THING. `register()` installed a propagator too, and leaving it
    // out is not a test detail — `job-trace.ts` injects a W3C `traceparent`
    // into every job payload through `propagation.inject`, so with no global
    // propagator the carrier comes back EMPTY and each job starts its own
    // trace instead of continuing the request's. Caught by
    // `tests/integration/job-execution-with-trace.test.ts`, which is the only
    // thing in CI that reads a trace id across the enqueue boundary.
    propagation.setGlobalPropagator(
        new CompositePropagator({
            propagators: [
                new W3CTraceContextPropagator(),
                new W3CBaggagePropagator(),
            ],
        }),
    );

    // ── Metrics ──
    const metricExporter = new OTLPMetricExporter({
        url: `${otlpEndpoint}/v1/metrics`,
    });

    const meterProvider = new MeterProvider({
        resource,
        readers: [
            new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: 30_000, // flush every 30s
            }),
        ],
    });

    // Register the meter provider globally
    const { metrics } = await import('@opentelemetry/api');
    metrics.setGlobalMeterProvider(meterProvider);
    // Gauges registered before this line sit on the API's no-op meter, which
    // never hands them to a provider. Re-run those registrations against the
    // one just installed. See observable-registry.ts.
    rebindObservables();

    _shutdown = async () => {
        // Drain exporters in parallel — both independently bounded by
        // the outer shutdownTelemetry timeout via Promise.race.
        await Promise.all([
            tracerProvider.shutdown().catch(() => { /* swallow — best-effort */ }),
            meterProvider.shutdown().catch(() => { /* swallow — best-effort */ }),
        ]);
    };

    _initialized = true;
    // Use pinoInstance directly since request context is not available during bootstrap
    const { pinoInstance: pino } = require('./logger');
    pino.info({ component: 'otel', serviceName, otlpEndpoint }, 'Telemetry initialized');
}

/** Check if OTel has been initialized (useful for tests). */
export function isTelemetryInitialized(): boolean {
    return _initialized;
}

/**
 * Drain the OTel tracer + meter providers. Bounded by `timeoutMs` —
 * if draining hasn't completed within the budget, the promise resolves
 * anyway so graceful shutdown can continue to the next stage (Sentry
 * close, process exit). Never throws.
 *
 * Noop when OTel was disabled or was never initialised.
 *
 * Safe to call multiple times: after the first call, `_shutdown` is
 * cleared so subsequent calls resolve immediately.
 */
export async function shutdownTelemetry(timeoutMs = 2_000): Promise<void> {
    if (!_shutdown) return;
    const shutdown = _shutdown;
    _shutdown = null;
    _initialized = false;

    await Promise.race([
        shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

/**
 * Reset initialization flag (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
    _initialized = false;
    _shutdown = null;
}
