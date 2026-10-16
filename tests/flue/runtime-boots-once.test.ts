import { ensureFlueRuntime } from '@/lib/agentic/flue/runtime-start';

/**
 * THE PROCESS-WIDE BOOT, EXECUTED ONCE (#3617).
 *
 * `src/lib/agentic/flue/runtime-start.ts` was the third flue module at **zero
 * execution coverage** across all six CI shards. It is the only thing that
 * actually starts the runtime in production: it builds the deployment's
 * providers from `env`, installs the telemetry interceptor, calls `start()`, and
 * memoises the whole thing.
 *
 * ── WHY IT HAD NO TEST, AND WHY THIS FILE IS SEPARATE ───────────────────────
 *
 * Everything it does is once-per-process and deliberately irreversible.
 * `start()` throws if the process already has a runtime, `instrument()` throws
 * on a second install, and the disposer is dropped on purpose — the module says
 * "this process-wide instrumentation lives as long as the runtime does ... and
 * holding a handle nobody calls would imply otherwise".
 *
 * So this file does not tear down, which is exactly why it is a file of its own:
 * jest gives each test file its own module registry, so the memo and the install
 * belong to this file alone and cannot collide with the other flue suites, each
 * of which calls `start()`/`stop()` itself.
 *
 * It needs no environment. `planFlueStart` is a pure wrap and
 * `buildFlueProviders` returns an explicit empty array, so a deployment with no
 * credentials boots with no providers — which is the configuration CI runs in
 * and a real deployment state worth proving does not throw.
 */
describe('ensureFlueRuntime', () => {
    it('starts, and reports the providers it started with', async () => {
        const providers = await ensureFlueRuntime();
        // An ARRAY, always — `buildFlueProviders` promises that explicitly so a
        // caller spreading the result cannot throw at the boot site.
        expect(Array.isArray(providers)).toBe(true);
        // Every entry is a real provider with an id the pre-dispatch check can
        // match a specifier against.
        expect(providers.every((p) => typeof p.id === 'string' && p.id.length > 0)).toBe(true);
    });

    it('is MEMOISED — a second call returns the identical result without re-starting', async () => {
        // The property that makes the single `instrument()` and the single
        // `start()` safe. If the memo were dropped, the second call would throw
        // `InstrumentationAlreadyInstalledError` — so this assertion is also the
        // one that proves the install is not being repeated.
        const first = await ensureFlueRuntime();
        const second = await ensureFlueRuntime();
        expect(second).toBe(first);
    });

    it('serves concurrent callers from one boot', async () => {
        // The memo is assigned before the async body is awaited, so callers that
        // arrive together share the in-flight promise rather than racing two
        // `start()` calls. A boot that assigned after awaiting would let two
        // through and the second would throw.
        const [a, b, c] = await Promise.all([
            ensureFlueRuntime(),
            ensureFlueRuntime(),
            ensureFlueRuntime(),
        ]);
        expect(b).toBe(a);
        expect(c).toBe(a);
    });
});
