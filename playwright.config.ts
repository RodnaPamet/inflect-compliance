import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
// Always use a dedicated port for E2E tests to avoid conflicts with `npm run dev` on 3000.
// This ensures E2E tests always start their own server with AUTH_TEST_MODE=1.
// The port Playwright talks to. HTTPS, terminated by scripts/e2e-http2-proxy.mjs
// so the harness speaks h2 like production does (deploy/caddy: `protocols h1 h2 h3`).
const port = 3006;
// `next start` moves behind the proxy. Nothing outside this file should need it.
const upstreamPort = 3007;

export default defineConfig({
    testDir: './tests/e2e',
    globalSetup: './tests/e2e/global-setup.ts',
    // GAP-23: hard-deletes any tenants the suite created via
    // `createIsolatedTenant` (tracked in
    // `tests/e2e/.tenant-tracker.jsonl`). Idempotent — does
    // nothing when the file is absent. Failures don't abort the
    // run; the tracker file is preserved so the next run retries.
    globalTeardown: './tests/e2e/global-teardown.ts',
    timeout: 180_000,
    // Fully parallel: every mutating spec now provisions its own fresh,
    // empty tenant via the `isolatedTenant` fixture (tests/e2e/fixtures.ts),
    // so concurrent tests can never corrupt each other's data. The few
    // genuinely read-only specs that still read the shared seed are
    // concurrent-read-safe. See docs/implementation-notes/2026-06-23-e2e-parallelization.md.
    fullyParallel: true,
    forbidOnly: isCI,
    // BOTH CI and local runs use `next start` (production mode) — a
    // pre-compiled server that handles the parallel suite cleanly. We
    // previously used `next dev` locally, which JIT-compiles routes and
    // leaks memory over long sessions.
    //
    // `scripts/e2e-local.mjs` already runs `next build` before kicking
    // off Playwright, so the build artifact is always fresh. Direct
    // `npx playwright test` invocations need a prior `npx next build`
    // (without it, `next start` errors out with a clear message).
    //
    // 2 retries on both — local can still hit transient localhost races.
    retries: 2,
    // Parallel workers in CI; local stays auto (Playwright picks ~half the
    // cores). Each worker gets its own browser; per-test isolated tenants
    // keep DB state from colliding across workers.
    //
    // Tuned 4 → 2 after the initial rollout: 4 workers oversubscribed the
    // single shared `next start` server + one Postgres, and the resulting
    // contention made timing-sensitive specs flake (control-tests' async
    // finding render, page-load-budget's TTFB ceiling) on ~half of runs —
    // intermittently red-flagging unrelated PRs. 2 keeps a large speedup
    // (~15 min serial → ~8 min) while leaving the server enough headroom to
    // stay deterministic. Revisit upward only with a bigger CI runner.
    workers: isCI ? 2 : undefined,
    reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.URL || `https://localhost:${port}`,
        // The proxy's cert is a self-signed throwaway generated at first run
        // (see scripts/e2e-http2-proxy.mjs). Trusting it is the point; it is
        // never used outside this harness.
        ignoreHTTPSErrors: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // Matches the two settings above it. `'on'` recorded video for
        // every test — ~260 of which are green on a normal run — and the
        // artifact upload step only fires `if: failure()`, so all of it
        // was encoded and then discarded.
        video: 'retain-on-failure',
    },
    // Two projects, one process. CI used to run `playwright test
    // tests/e2e/a11y.spec.ts` and then `playwright test --grep-invert
    // "a11y"` as SEPARATE invocations — which booted the `next start`
    // server twice and ran the seeding global-setup twice (three times
    // counting the workflow's own seed step), to buy a named step in the
    // CI log.
    //
    // Projects give the same separation for free: `a11y` and `e2e` report
    // independently (and can be run alone with `--project=a11y`), while a
    // single invocation shares one server boot and one setup.
    projects: [
        {
            name: 'a11y',
            testMatch: /a11y\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'e2e',
            testIgnore: /a11y\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        // AUTH_URL / NEXTAUTH_URL must match the actual test port. NextAuth's
        // reqWithEnvURL() rewrites the request origin to AUTH_URL for every
        // /api/auth/* request — any mismatch causes login redirects to land on
        // the wrong host and surfaces as spurious MissingCSRF / stuck-login
        // failures in Playwright.
        // Both CI and local use `next start` (production mode). See the
        // retries comment above for why local stopped using `next dev`.
        // PORT must be set explicitly because `next start -p` doesn't
        // propagate to the env that `auth-config.ts` reads at startup.
        // NEXT_PUBLIC_TEST_MODE=1 is mainly inlined at build time, but
        // keeping it on `next start` too is a belt-and-braces guard in
        // case some part of the runtime re-reads it. Suppresses the
        // Driver.js onboarding-tour auto-trigger so the tour overlay
        // doesn't cover every authenticated page in E2E sessions.
        // DATA_ENCRYPTION_KEY: `next start` overwrites process.env.NODE_ENV
        // to "production" regardless of what cross-env passed in. The Epic B
        // encryption sentinel inside src/instrumentation.ts reads NODE_ENV at
        // runtime and refuses to start a "production" process without a
        // 32+ char DATA_ENCRYPTION_KEY. We seed a default via shell `${VAR:-…}`
        // expansion (NOT cross-env, which would override the value the
        // surrounding env already set) so:
        //   • direct `npx playwright test …` works locally without env wiring
        //   • CI keeps its own `DATA_ENCRYPTION_KEY` (the seed step uses the
        //     same value, so the HMAC-derived `emailHash` matches between
        //     seed and login). Forcing a different value here causes
        //     `unknown_email` login failures because the seed and the
        //     webserver hash `admin@acme.com` under different keys.
        // NOT a real secret; visible in source so no operator confuses it
        // for prod.
        //
        // ── HTTP/2 (2026-08-19) ──
        // `next start` now listens on ${upstreamPort} and a small h2 proxy
        // fronts it on ${port}. Production terminates TLS at Caddy with
        // `h1 h2 h3`; this harness was the only tier serving raw HTTP/1.1,
        // whose SIX-connection-per-origin cap made the sidebar's 14-route
        // prefetch burst queue until `networkidle` never settled (upstream
        // vercel/next.js#96109). AUTH_URL/NEXTAUTH_URL move to https for the
        // same reason they had to match the port: NextAuth rewrites the
        // request origin to AUTH_URL, so a scheme mismatch reintroduces the
        // MissingCSRF/stuck-login class this comment already warns about.
        command:
            `DATA_ENCRYPTION_KEY=\${DATA_ENCRYPTION_KEY:-e2e-deterministic-test-encryption-key-32+-chars} ` +
            `npx cross-env NODE_ENV=test NODE_OPTIONS="--max-old-space-size=4096" ` +
            `NEXT_IGNORE_INCORRECT_LOCKFILE=1 AUTH_TEST_MODE=1 NEXT_TEST_MODE=1 NEXT_PUBLIC_TEST_MODE=1 ` +
            `AUTH_URL=https://localhost:${port} NEXTAUTH_URL=https://localhost:${port} ` +
            `AUTH_TRUST_HOST=true PORT=${upstreamPort} ` +
            `npx next start -p ${upstreamPort} & ` +
            `E2E_HTTPS_PORT=${port} E2E_UPSTREAM_PORT=${upstreamPort} node scripts/e2e-http2-proxy.mjs`,
        // Playwright probes this URL (not just the port) so it waits for the
        // PROXY to be up, not merely `next start`.
        url: `https://localhost:${port}/login`,
        ignoreHTTPSErrors: true,
        reuseExistingServer: !isCI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
