/**
 * Observable instruments that survive being registered before telemetry starts.
 *
 * ## The trap
 *
 * The OTel metrics API has no proxy provider. Until `initTelemetry()` calls
 * `metrics.setGlobalMeterProvider`, `metrics.getMeter()` returns the API's
 * no-op meter, and an instrument created on it stays a no-op for the life of
 * the process: its `addCallback` is discarded, and nothing later moves it to
 * the real provider. (Tracing does not have this problem; its API proxies.)
 *
 * An observable gauge is registered once, behind an idempotency flag, so a
 * registration that ran too early could never be fixed by a later call either.
 * Measured in a smoke run of the built worker: `agent.runs.in_flight` exported
 * nothing at all, because `src/lib/agentic/in-flight-runs.ts` registers it at
 * module load and the worker imports that module before `bootstrap()` starts
 * telemetry. `audit-stream.ts` registers its buffer gauge the same way, and the
 * worker's integration-freshness gauge raced `initTelemetry()` from an async
 * boot block.
 *
 * ## The fix
 *
 * Every observable gauge is registered through `bindObservable`, which runs the
 * registration now and remembers which meter provider it ran against.
 * `initTelemetry()` calls `rebindObservables()` right after installing the real
 * provider, and every registration that ran against a different provider runs
 * again. A registration that ran after telemetry started already holds the
 * current provider and is not repeated, so no callback is registered twice.
 *
 * `local/observable-gauge-rebinds` refuses a `createObservableGauge` call
 * outside a `bindObservable` callback, so a new gauge cannot reintroduce this.
 *
 * Dependency-free beyond the OTel API on purpose: `metrics.ts`,
 * `integration-metrics.ts`, `business-metrics.ts`, `connection-freshness.ts`
 * and `instrumentation.ts` all import it.
 */
import { metrics } from '@opentelemetry/api';

type MeterProvider = ReturnType<typeof metrics.getMeterProvider>;

interface Binding {
    readonly register: () => void;
    boundTo: MeterProvider;
}

const bindings: Binding[] = [];

/**
 * Run `register` now, and again whenever `rebindObservables()` finds that the
 * global meter provider has changed since it last ran.
 *
 * `register` creates the instrument through the module's own `getMeter()` and
 * adds its callback. It must be safe to run more than once: each run creates a
 * fresh instrument on whichever provider is current, which is the point.
 * Callers keep their own once-only flag; this is about WHERE it is registered,
 * not how often it is asked for.
 */
export function bindObservable(register: () => void): void {
    const binding: Binding = { register, boundTo: metrics.getMeterProvider() };
    bindings.push(binding);
    register();
}

/**
 * Re-run every registration made against a meter provider other than the
 * current one. Called by `initTelemetry()` immediately after it installs the
 * global provider. Returns how many registrations were re-run.
 *
 * Never throws: one gauge whose registration fails must not cost the others,
 * or telemetry startup.
 */
export function rebindObservables(): number {
    const current = metrics.getMeterProvider();
    let rebound = 0;
    for (const binding of bindings) {
        if (binding.boundTo === current) continue;
        try {
            binding.register();
            binding.boundTo = current;
            rebound++;
        } catch {
            // Leave it bound where it was. The next rebind tries again.
        }
    }
    return rebound;
}

/** Forget every registration (testing only). @internal */
export function _resetObservableBindingsForTesting(): void {
    bindings.length = 0;
}
