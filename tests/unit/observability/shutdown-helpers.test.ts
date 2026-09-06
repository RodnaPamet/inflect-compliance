/**
 * The never-initialised early return in the two paired shutdown helpers
 * (`shutdownTelemetry`, `shutdownSentry`). `installShutdownHandlers`
 * calls both on SIGTERM in every process, including the ones that never
 * booted OTel or Sentry, so "does nothing, resolves, and holds no timer"
 * is a real contract on the deploy path: a stray refs'd timer here would
 * hold the container open past its drain.
 *
 * SCOPE — this file covers ONLY that early return. The rest of the
 * contract (drains, idempotence, rejection-swallowing, the `timeoutMs`
 * bound) is proved against a really-initialised module, with call
 * counts rather than clocks, in:
 *
 *   - tests/unit/observability/instrumentation-enabled.test.ts
 *       'drains BOTH providers exactly once and clears the initialised
 *       flag' / 'is idempotent — the second call re-drains nothing' /
 *       'swallows a rejecting tracer drain and still drains the meter
 *       provider' / 'swallows a rejecting meter drain too' /
 *       'resolves at the budget when a drain never settles'
 *   - tests/unit/observability/sentry-redaction.test.ts
 *       'closes the transport with the caller budget and clears the
 *       flag' / 'does not re-close on a second call' / 'resolves at the
 *       budget when the transport never drains'
 *
 * Do not grow copies of those here.
 *
 * ─── Removed 2026-09-06: five wall-clock ceilings ────────────────────
 *
 * This file used to assert `expect(Date.now() - start).toBeLessThan(50)`
 * four times and `< 200` once. Every one of them measured a path whose
 * true cost is zero — `_shutdown === null` / `_initialized === false`
 * both return on the first statement — so the whole budget was slack,
 * and on a `--runInBand` shard holding hundreds of suites one major GC
 * pause spends it. They had it backwards in both directions:
 *
 *   * They could not fail when the thing they named regressed. Two of
 *     the five ('is idempotent — second call also resolves fast')
 *     asserted NOTHING ELSE, and on a never-initialised module both
 *     calls take the same early return — so nothing about idempotence
 *     was being observed at all. A third was named 'respects the
 *     timeout budget' while its own comment conceded it does not reach
 *     the budget; `Promise.race` → `Promise.all` in `shutdownTelemetry`
 *     leaves all five green.
 *   * They could fail when nothing regressed, on any loaded runner.
 *
 * The replacements below measure the same claim as WORK, under fake
 * timers: an early return settles on the microtask queue and schedules
 * no timer, which is the same integer on any machine under any load.
 * Same defect class and same remedy as
 * tests/unit/framework-tree-builder.test.ts ('does not read the input
 * quadratically') and tests/unit/password-check.test.ts:183-197.
 */

import { shutdownTelemetry, _resetForTesting as resetTelemetry, isTelemetryInitialized } from '@/lib/observability/instrumentation';
import { shutdownSentry, _resetForTesting as resetSentry, isSentryInitialized } from '@/lib/observability/sentry';

/**
 * Start `op` under fake timers and report whether it settled without a
 * timer having to fire, plus how many timers it left pending.
 *
 * Fake timers never advance on their own, so a helper that awaits a
 * `setTimeout` cannot settle here no matter how fast the machine is —
 * and a helper that returns on its first statement always does.
 */
async function runWithoutAdvancingTimers(
    op: () => Promise<void>,
): Promise<{ settledOnMicrotasks: boolean; pendingTimers: number }> {
    jest.useFakeTimers();
    try {
        let settledOnMicrotasks = false;
        const started = op().then(() => { settledOnMicrotasks = true; });
        // Drain the microtask queue generously. Native promise
        // continuations are not faked, so an early return lands here.
        for (let i = 0; i < 50; i++) await Promise.resolve();
        const pendingTimers = jest.getTimerCount();
        jest.runOnlyPendingTimers();
        await started;
        return { settledOnMicrotasks, pendingTimers };
    } finally {
        jest.useRealTimers();
    }
}

describe('shutdownTelemetry — OTel was never initialised', () => {
    beforeEach(() => {
        resetTelemetry();
    });

    it('returns on the microtask queue, holds no timer, and never throws', async () => {
        expect(isTelemetryInitialized()).toBe(false);

        const { settledOnMicrotasks, pendingTimers } =
            await runWithoutAdvancingTimers(() => shutdownTelemetry(5_000));

        // No drain closure exists, so there is nothing to race against a
        // budget: dropping the `if (!_shutdown) return` guard calls
        // `null()` and rejects, and racing unconditionally against
        // `setTimeout(timeoutMs)` leaves a 5s refs'd timer holding the
        // process open after SIGTERM.
        expect(settledOnMicrotasks).toBe(true);
        expect(pendingTimers).toBe(0);
        expect(isTelemetryInitialized()).toBe(false);
    });
});

describe('shutdownSentry — Sentry was never initialised (no SENTRY_DSN)', () => {
    beforeEach(() => {
        resetSentry();
    });

    it('returns on the microtask queue, holds no timer, and never throws', async () => {
        expect(isSentryInitialized()).toBe(false);

        const { settledOnMicrotasks, pendingTimers } =
            await runWithoutAdvancingTimers(() => shutdownSentry(5_000));

        expect(settledOnMicrotasks).toBe(true);
        expect(pendingTimers).toBe(0);
        expect(isSentryInitialized()).toBe(false);
    });
});
