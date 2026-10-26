/**
 * `initTelemetry()` moves gauges registered before it onto the provider it
 * installs.
 *
 * `observable-registry.test.ts` proves `rebindObservables()` does the moving.
 * This proves telemetry startup calls it, once, AFTER the real meter provider is
 * global: called before, it would rebind onto the no-op meter and move nothing.
 *
 * The real `initTelemetry()` runs, with exporters pointed at a closed port. They
 * send only on their 30-second interval or at shutdown, neither of which this
 * reaches, and the global providers are torn down afterwards.
 */
jest.mock('@/lib/observability/observable-registry', () => ({
    rebindObservables: jest.fn(() => 0),
}));

import { context, metrics, propagation, trace } from '@opentelemetry/api';

import { _resetForTesting, initTelemetry } from '@/lib/observability/instrumentation';
import { rebindObservables } from '@/lib/observability/observable-registry';

const rebind = rebindObservables as jest.MockedFunction<typeof rebindObservables>;
const saved = { enabled: process.env.OTEL_ENABLED, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT };

afterAll(() => {
    _resetForTesting();
    metrics.disable();
    trace.disable();
    context.disable();
    propagation.disable();
    if (saved.enabled === undefined) delete process.env.OTEL_ENABLED;
    else process.env.OTEL_ENABLED = saved.enabled;
    if (saved.endpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved.endpoint;
});

it('rebinds the early gauges once, after installing the real meter provider', async () => {
    _resetForTesting();
    metrics.disable();
    const noop = metrics.getMeterProvider();
    let providerAtRebind: unknown;
    rebind.mockImplementation(() => {
        providerAtRebind = metrics.getMeterProvider();
        return 0;
    });

    process.env.OTEL_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    await initTelemetry();

    expect(rebind).toHaveBeenCalledTimes(1);
    expect(providerAtRebind).not.toBe(noop);
    expect(providerAtRebind).toBe(metrics.getMeterProvider());
});

it('does nothing when telemetry is off: there is no provider to move to', async () => {
    _resetForTesting();
    rebind.mockClear();
    process.env.OTEL_ENABLED = 'false';
    await initTelemetry();

    expect(rebind).not.toHaveBeenCalled();
});
