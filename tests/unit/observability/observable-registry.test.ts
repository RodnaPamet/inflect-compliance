/**
 * A gauge registered before telemetry starts still exports once it has.
 *
 * The OTel metrics API has no proxy provider: an instrument made before
 * `metrics.setGlobalMeterProvider` sits on the API's no-op meter for good. The
 * first case below shows that with the real API and the real SDK and no
 * registry, because the rest of the file is only worth having while it stays
 * true. `agent.runs.in_flight` exported nothing from the worker for exactly this
 * reason: its module registers the gauge at load, and the worker loads it
 * before starting telemetry.
 *
 * Real `@opentelemetry/api`, real `@opentelemetry/sdk-metrics`, and a reader
 * that collects in process, so what is asserted is what an exporter would send.
 */
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

import {
    _resetObservableBindingsForTesting,
    bindObservable,
    rebindObservables,
} from '@/lib/observability/observable-registry';

class InProcessReader extends MetricReader {
    protected onForceFlush(): Promise<void> {
        return Promise.resolve();
    }
    protected onShutdown(): Promise<void> {
        return Promise.resolve();
    }
}

/** Install a real SDK meter provider globally; return what it would export, by gauge. */
function installProvider(): () => Promise<Record<string, number[]>> {
    const reader = new InProcessReader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    return async () => {
        const { resourceMetrics } = await reader.collect();
        const out: Record<string, number[]> = {};
        for (const scope of resourceMetrics.scopeMetrics) {
            for (const m of scope.metrics) {
                out[m.descriptor.name] = m.dataPoints.map((d) => d.value as number);
            }
        }
        return out;
    };
}

/** A gauge the way the app registers one: through its module's own meter. */
const registerGauge = (name: string, value: () => number) => () => {
    // Deliberately outside bindObservable: the first test reproduces the trap
    // with no registry, and the others pass this function to bindObservable.
    // eslint-disable-next-line local/observable-gauge-rebinds -- see above
    metrics
        .getMeter('inflect-compliance')
        .createObservableGauge(name)
        .addCallback((r) => r.observe(value()));
};

beforeEach(() => {
    metrics.disable();
    _resetObservableBindingsForTesting();
});

afterAll(() => {
    metrics.disable();
    _resetObservableBindingsForTesting();
});

describe('the trap this registry exists for', () => {
    it('a gauge created before the provider is installed exports nothing, without the registry', async () => {
        registerGauge('early', () => 1)();
        const collect = installProvider();
        registerGauge('late', () => 2)();

        expect(await collect()).toEqual({ late: [2] });
    });
});

describe('bindObservable and rebindObservables', () => {
    it('moves a gauge registered before telemetry onto the provider installed later', async () => {
        bindObservable(registerGauge('early', () => 7));
        const collect = installProvider();

        expect(await collect()).toEqual({});
        expect(rebindObservables()).toBe(1);
        expect(await collect()).toEqual({ early: [7] });
    });

    it('leaves a gauge registered after telemetry alone, so its callback is not added twice', async () => {
        const collect = installProvider();
        let calls = 0;
        bindObservable(registerGauge('late', () => ++calls));

        expect(rebindObservables()).toBe(0);
        expect(await collect()).toEqual({ late: [1] });
        expect(calls).toBe(1);
    });

    it('rebinds once per provider: a second call with nothing new does nothing', async () => {
        bindObservable(registerGauge('early', () => 3));
        installProvider();

        expect(rebindObservables()).toBe(1);
        expect(rebindObservables()).toBe(0);
    });

    it('one registration that throws does not cost the others', async () => {
        let fail = false;
        bindObservable(() => {
            if (fail) throw new Error('boom');
        });
        bindObservable(registerGauge('survivor', () => 5));
        const collect = installProvider();
        fail = true;

        expect(rebindObservables()).toBe(1);
        expect(await collect()).toEqual({ survivor: [5] });
    });
});

describe('the gauge the worker lost', () => {
    it('agent.runs.in_flight, registered when in-flight-runs.ts loads before telemetry, exports after the rebind', async () => {
        // Load the real module first, as the worker does: its top level calls
        // startAgentRunsInFlightReporting while the global meter is the no-op.
        // A fresh module registry, so the module's top level runs here; the
        // registry is taken from the same one, as one process would share it.
        let track!: (id: string) => void;
        let rebind!: () => number;
        jest.isolateModules(() => {
            ({ trackInFlightRun: track } = require('@/lib/agentic/in-flight-runs'));
            ({ rebindObservables: rebind } = require('@/lib/observability/observable-registry'));
        });
        const collect = installProvider();
        track('run-1');
        track('run-2');

        expect(await collect()).toEqual({});
        // What initTelemetry() now does right after installing the provider.
        expect(rebind()).toBeGreaterThanOrEqual(1);

        expect((await collect())['agent.runs.in_flight']).toEqual([2]);
    });
});
