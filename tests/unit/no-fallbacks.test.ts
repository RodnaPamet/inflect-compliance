import fs from 'fs';
import path from 'path';

function walkDir(dir: string, fileList: string[] = []) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            if (file !== 'node_modules' && file !== '.next') {
                walkDir(filePath, fileList);
            }
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

describe('Static Analysis: No process.env fallbacks', () => {
    it('should not contain forbidden process.env or secret fallback patterns in src', () => {
        const srcDir = path.resolve(__dirname, '../../src');
        const files = walkDir(srcDir);

        let foundErrors = false;

        for (const file of files) {
            // Ignore the env definition itself since it maps process.env
            if (file.endsWith('env.ts')) continue;
            // Infrastructure routes intentionally use process.env for env gating / build info
            if (file.includes('health') && file.includes('route.ts')) continue;
            if (file.includes('readyz') && file.includes('route.ts')) continue;
            if (file.includes('livez') && file.includes('route.ts')) continue;
            if (file.includes('staging') && file.includes('route.ts')) continue;
            // Stripe SDK wrapper intentionally uses process.env for lazy key loading
            if (file.endsWith('stripe.ts')) continue;
            // Observability modules bootstrap before env validation (OTel/Sentry/diagnostics)
            if (file.includes('observability')) continue;
            if (file.endsWith('instrumentation.ts')) continue;
            // Diagnostics endpoint reads runtime-only observability config (OTEL_*, SENTRY_*, LOG_LEVEL)
            if (file.includes('diagnostics') && file.includes('route.ts')) continue;
            // AV webhook uses process.env for webhook auth that must run before env validation
            if (file.includes('av-webhook') && file.includes('route.ts')) continue;
            // Encryption module reads DATA_ENCRYPTION_KEY directly (must work before env validation)
            if (file.endsWith('encryption.ts') && file.includes('security')) continue;
            // Redis connection helper reads REDIS_URL directly (graceful null when unconfigured, pre-env-validation)
            if (file.endsWith('redis.ts') && file.includes('lib')) continue;
            // Mailer bootstraps the SMTP transport from process.env directly:
            // reading the validated @/env module left the mailer on the console
            // sink in the turbopack prod bundle (a route-handler chunk surfaced
            // no SMTP_* vars), silently dropping every invite/verification email.
            // process.env is populated identically in every chunk. Same
            // env.ts-snapshot-doesn't-reach-this-chunk rationale as the
            // rate-limit / docs / health carve-outs above.
            if (file.endsWith('mailer.ts') && file.includes('lib')) continue;
            // The deployment's sender address, which `mailer.ts` (transport
            // default) and `notifications/settings.ts` (per-tenant fallback)
            // both need. It carries the SAME carve-out reason as mailer.ts
            // directly above — a bundled route chunk can surface no SMTP_* on
            // the `@/env` copy, so `env.SMTP_FROM` reads undefined and the
            // caller silently falls back. That is not hypothetical here: both
            // files previously hardcoded `noreply@inflect.app`, production's
            // relay had verified a different domain, and 520 messages were
            // rejected `550 ... not verified` between 2026-06-03 and
            // 2026-09-03 with nothing surfacing it. This module exists so
            // there is one address to set rather than two to keep in sync.
            if (file.endsWith('sender-identity.ts')) continue;
            // Edge middleware reads CSP_REPORT_ONLY before env validation (optional runtime toggle)
            if (file.endsWith('middleware.ts') && !file.includes('pii-middleware')) continue;
            // Dub-ported utility files use process.env by upstream design
            if (file.includes('dub-utils')) continue;
            // ui-config endpoint is intentionally a runtime process.env
            // reader so operators can toggle AUTH_CREDENTIALS_UI_HIDDEN
            // without a rebuild/rollout (NEXT_PUBLIC_* inlines at build
            // time). See the docblock in the file.
            if (file.endsWith('ui-config/route.ts')) continue;
            // Rate-limit bypass predicate reads RATE_LIMIT_ENABLED /
            // NODE_ENV at request time so tests can flip the bypass
            // per-test via env mutation (used by the Epic A.2/A.3
            // suites and the Epic B end-to-end). Reading through the
            // cached env.ts snapshot would freeze the value at import
            // time and break those flows.
            if (file.endsWith('rate-limit-middleware.ts')) continue;
            // GAP-17 read-tier rate limiter follows the same convention
            // as rate-limit-middleware.ts above — NEXT_TEST_MODE must be
            // read at request time so the Playwright suite can flip the
            // bypass per-test without re-importing the module.
            if (file.endsWith('apiReadRateLimit.ts')) continue;
            // GAP-10 Swagger-UI route gates prod via process.env.NODE_ENV
            // (HARD 404 in production). Same rationale as health/readyz
            // routes above — env.ts snapshot freezes at import time and
            // the route MUST refuse to render under prod.
            if (file.endsWith('docs/route.ts')) continue;
            // GAP-18 billing entitlements reads STRIPE_SECRET_KEY at
            // module load to decide SaaS vs self-hosted mode. The
            // decision MUST happen before env.ts validation runs
            // because self-hosted deployments deliberately do not
            // configure STRIPE_SECRET_KEY (the variable is treated as
            // optional under that mode). Routing through env.ts
            // would force every self-hosted operator to set the
            // variable to satisfy schema validation, contradicting
            // the operating model documented in docs/billing.md.
            if (file.endsWith('billing/entitlements.ts')) continue;
            // ClientProviders gates the Driver.js onboarding-tour
            // auto-trigger via NEXT_PUBLIC_TEST_MODE. NEXT_PUBLIC_*
            // env vars MUST be read via `process.env.NEXT_PUBLIC_*`
            // for Next.js's build-time inlining to fire — env.ts
            // validates at runtime and would break the inlining.
            // The fallback to `process.env.NODE_ENV` covers test
            // environments that don't set NEXT_PUBLIC_TEST_MODE
            // explicitly (e.g. jsdom + jest).
            if (file.endsWith('layout/ClientProviders.tsx')) continue;
            // use-calendar-badge gates the sidebar polling fetch via
            // NEXT_PUBLIC_TEST_MODE for the same build-time-inlining
            // reason. Two SidebarContent mounts × N test page loads
            // produced enough in-flight requests to keep
            // `waitForLoadState('networkidle')` from settling on slow
            // CI runners — see the docblock in use-calendar-badge.ts.
            if (file.endsWith('use-calendar-badge.ts')) continue;
            // Epic 69 SWRDevTools is dev-only by design — it gates
            // visibility on `process.env.NODE_ENV === 'development'`
            // AND `process.env.NEXT_PUBLIC_TEST_MODE === '1'` so
            // Next.js can tree-shake the entire panel from the prod
            // bundle. NEXT_PUBLIC_* MUST be read via process.env for
            // the build-time inlining to fire; routing through env.ts
            // would break the inlining (same rationale as
            // ClientProviders + use-calendar-badge above).
            if (file.endsWith('dev/swr-devtools.tsx')) continue;

            const content = fs.readFileSync(file, 'utf8');

            // Look for `process.env.Something`
            if (content.includes('process.env.')) {
                console.error(`Forbidden 'process.env' usage found in ${file}`);
                foundErrors = true;
            }

            // Look for `|| "secret"` or `|| 'secret'` pattern (simplistic regex but effective)
            if (/\|\|\s*["'].*secret.*["']/i.test(content)) {
                console.error(`Forbidden hardcoded secret fallback found in ${file}`);
                foundErrors = true;
            }
        }

        expect(foundErrors).toBe(false);
    });
});
