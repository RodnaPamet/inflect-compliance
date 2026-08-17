/**
 * Next.js Instrumentation Hook — called once on server startup.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
    // Only initialize on the server (Node.js runtime), not Edge.
    if (process.env.NEXT_RUNTIME === 'nodejs' || !process.env.NEXT_RUNTIME) {
        // ── GAP-13: Redis is required in production ──
        // Defense-in-depth alongside the env-schema check (`src/env.ts`):
        // schema validation catches missing REDIS_URL at module load,
        // this hook catches the case where SKIP_ENV_VALIDATION=1 leaks
        // into the runtime container.
        //
        // The previous incarnation of this check had a `RATE_LIMIT_ENABLED=0`
        // escape hatch — that's been removed because Redis underpins more
        // than the rate limiter. Login brute-force throttle (Epic A.3),
        // invite-redemption limit, email-dispatch limit, and BullMQ jobs
        // all break silently when Redis is absent. Toggling rate limits
        // off doesn't make Redis optional in production.
        if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {

            console.error(
                '[startup] FATAL: REDIS_URL is required in production. ' +
                'Rate limits, queues, and session coordination depend on it. ' +
                'Set REDIS_URL to your Redis / ElastiCache connection string.',
            );
            process.exit(1);
        }

        // ── AUTH_TEST_MODE must not be "1" in production ──
        // Same defense-in-depth reasoning as the two checks around it: the
        // env schema catches it at module load, this catches the case where
        // SKIP_ENV_VALIDATION=1 leaks into the runtime container — which is
        // exactly the configuration a container image is most likely to
        // carry, since the build sets it deliberately.
        //
        // Worth stating what the flag actually does, because the name
        // undersells it. It does not just enable credentials sign-in: it
        // makes the login brute-force throttle a no-op and bypasses BOTH
        // rate-limit tiers, in four different files, silently.
        //
        // NEXT_TEST_MODE is the exemption, and it is load-bearing rather
        // than a convenience. `next start` OVERWRITES process.env.NODE_ENV
        // to "production" regardless of what the caller passed — the
        // playwright.config.ts webServer comment says so explicitly, and
        // the Epic B encryption sentinel a few lines below already has to
        // account for it. So the E2E server, which legitimately sets
        // AUTH_TEST_MODE=1, presents to this check as production.
        //
        // Without the exemption this refusal kills the E2E webserver: it
        // exits 1, Playwright waits for a port that never opens, and the
        // job dies at its 40-minute timeout with no failing test to point
        // at. That is exactly what happened on the first version of this
        // change. NEXT_TEST_MODE is set only by the Playwright webServer
        // and scripts/e2e-local.mjs; a real production process never has
        // it, so it separates the two cases without weakening the check.
        // SYNTHETIC_TEST_HARNESS is the second exemption, and it exists because
        // NEXT_TEST_MODE could not be stretched to cover the rest. Four CI
        // harnesses besides Playwright legitimately boot a production build
        // with AUTH_TEST_MODE=1 — ci.yml's `load-smoke`, load-test.yml,
        // dast.yml, dast-full.yml — and `next start` forces NODE_ENV=production
        // for all of them, so they present here exactly as production does.
        //
        // NEXT_TEST_MODE is NOT usable for them: next.config.js reroutes
        // distDir to `.next-test/` when it is set, and `load-smoke` starts from
        // the `.next/` artifact the build job published (ci.yml documents this
        // at the "Build Next.js app" step). Setting it there trades a boot
        // failure for a missing-directory failure.
        //
        // A second exemption does not weaken this check. Its strength was
        // already "one env var bypasses it" — anything able to set
        // SYNTHETIC_TEST_HARNESS in a real production environment could equally
        // set NEXT_TEST_MODE. What matters is that each exemption is named for
        // what it is, so nobody sets one believing it does something else.
        if (
            process.env.NODE_ENV === 'production' &&
            process.env.NEXT_TEST_MODE !== '1' &&
            process.env.SYNTHETIC_TEST_HARNESS !== '1' &&
            process.env.AUTH_TEST_MODE === '1'
        ) {
            console.error(
                '[startup] FATAL: AUTH_TEST_MODE=1 is set in production. ' +
                'It enables credentials sign-in AND disables the login ' +
                'brute-force throttle and both rate-limit tiers. ' +
                'Remove AUTH_TEST_MODE from the production environment.',
            );
            process.exit(1);
        }

        // ── GAP-03: DATA_ENCRYPTION_KEY is required in production ──
        // Defense-in-depth alongside the env-schema check (`src/env.ts`):
        // schema validation catches missing/wrong-fallback configs at
        // module load, this hook catches the case where
        // SKIP_ENV_VALIDATION=1 leaks into the runtime container, and
        // the sentinel pre-flight catches structurally-valid keys that
        // happen to fail HKDF/AES (e.g. binary garbage written to env).
        //
        // The check + sentinel logic lives in
        // `@/lib/security/startup-encryption-check` so it's unit-testable
        // without spawning a child process that calls process.exit(1).
        if (process.env.NODE_ENV === 'production') {
            const { checkProductionEncryptionKey, runEncryptionSentinel } =
                await import('@/lib/security/startup-encryption-check');

            const config = checkProductionEncryptionKey(process.env);
            if (!config.ok) {

                console.error('[startup] FATAL: ' + config.reason);
                process.exit(1);
            }

            const sentinel = await runEncryptionSentinel();
            if (!sentinel.ok) {

                console.error('[startup] FATAL: ' + sentinel.reason);
                process.exit(1);
            }
        }

        // GAP-05 — Next 15's bundler resolves `await import('node:events')`
        // to a Module namespace where `EventEmitter` lives at .default
        // rather than as a named export, so the previous destructure
        // here threw `Cannot read properties of undefined (reading
        // 'defaultMaxListeners')` and the entire instrumentation hook
        // unhandled-rejected on every request. The EventEmitter cap is
        // already raised at config-load time in next.config.js (top-
        // level require, no bundler involved); this duplicate raise was
        // belt-and-suspenders for very early bootstrap, redundant once
        // next.config.js runs. Removed entirely.

        const { initTelemetry } = await import('@/lib/observability/instrumentation');
        const { initSentry } = await import('@/lib/observability/sentry');
        // Swap the mailer to SMTP when SMTP_HOST is configured. Without
        // this the mailer stays on the dev console sink and NO email
        // (verification, password reset, notifications, invites) is ever
        // delivered in production. No-op (console sink) when SMTP is unset.
        const { initMailerFromEnv } = await import('@/lib/mailer');
        const { installAutomationBusDispatcher } = await import(
            '@/app-layer/automation/bus-bootstrap'
        );
        // Register all integration providers process-wide (web tier). Without
        // this the provider registry is empty for scheduled checks, identity/
        // HRIS sync, and webhook routing triggered from the web process.
        await import('@/app-layer/integrations/bootstrap');
        const { startIntegrationFreshnessReporting } = await import('@/lib/observability/integration-metrics');
        startIntegrationFreshnessReporting();
        // GAP-3 — durable, per-connection freshness gauge (DB-backed).
        const { startConnectionFreshnessReporting } = await import('@/lib/observability/connection-freshness');
        startConnectionFreshnessReporting();
        const { installRlsTripwire } = await import('@/lib/db/rls-middleware');
        const { prisma } = await import('@/lib/prisma');
        const { installShutdownHandlers } = await import('@/lib/observability/shutdown');
        await initTelemetry();
        initSentry();
        initMailerFromEnv();
        // Wire the automation bus to the BullMQ queue so domain
        // events emitted from usecases enqueue dispatch jobs.
        installAutomationBusDispatcher();
        // Install the RLS observability tripwire. Idempotent — safe
        // under HMR. Installed here (not in `prisma.ts`) to avoid a
        // circular import with `db/rls-middleware.ts`.
        installRlsTripwire(prisma);
        // Register SIGTERM/SIGINT handlers that drain audit-stream
        // buffers, OTel exporters, and Sentry transport before the
        // process exits. Idempotent under HMR.
        installShutdownHandlers();

        // Verify Redis is not configured to EVICT keys — BullMQ job
        // state lives in Redis, so an eviction `maxmemory-policy`
        // would silently drop queued jobs. Best-effort + non-blocking:
        // it logs loudly on a violation but never crash-loops the
        // process (a drifted deployment must stay up). The fail-fast
        // gate is the structural guard at PR time
        // (tests/guards/redis-eviction-policy.test.ts).
        const { verifyRedisEvictionPolicy } = await import('@/lib/redis');
        void verifyRedisEvictionPolicy().catch(() => {
            // A diagnostic check must never break startup.
        });
    }
}

