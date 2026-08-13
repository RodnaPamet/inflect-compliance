const createNextIntlPlugin = require('next-intl/plugin');

// Bundle analyzer — only active when ANALYZE=true (npm run analyze).
// Writes HTML reports to .next/analyze/ (git-ignored); a no-op for normal
// builds. See docs/implementation-notes/2026-06-26-perf-baseline.md.
const withBundleAnalyzer = require('@next/bundle-analyzer')({
    enabled: process.env.ANALYZE === 'true',
});

// Bump EventEmitter cap before Next loads any HTTP/socket modules so the
// undici keep-alive socket pool doesn't trigger spurious
// MaxListenersExceededWarning lines for per-socket
// unpipe/error/close/finish listeners that accumulate across pooled
// requests. Set here (not in src/instrumentation.ts) because the dev
// server starts listening on the port before instrumentation.ts runs,
// so sockets created during early bootstrap miss the bump otherwise.
require('node:events').EventEmitter.defaultMaxListeners = Math.max(
    require('node:events').EventEmitter.defaultMaxListeners ?? 10,
    50,
);

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

const defaultOptions = {
    // GAP-05 — Next 15 promoted `serverComponentsExternalPackages`
    // out of `experimental` and renamed it to `serverExternalPackages`.
    // The list itself is unchanged from the v14 era; these packages
    // use native deps (worker_threads, native HTTP clients, dynamic
    // require) that don't survive Next's webpack bundling.
    serverExternalPackages: [
        'pdfkit',
        // Pino & transports — use native worker_threads / dynamic require
        'pino',
        'pino-pretty',
        'thread-stream',
        // OpenTelemetry — heavy native instrumentation modules
        '@opentelemetry/api',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-trace-node',
        '@opentelemetry/sdk-metrics',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/exporter-metrics-otlp-http',
        '@opentelemetry/semantic-conventions',
        // Sentry — optional error reporting
        '@sentry/nextjs',
        '@sentry/node',
        // AWS SDK — native HTTP client, credential resolution
        '@aws-sdk/client-s3',
        '@aws-sdk/s3-request-presigner',
    ],
    experimental: {
        // Client Router Cache stale times (Next 15+). The hot app routes are
        // `force-dynamic` (per-tenant auth + URL filters), so their default
        // client-cache stale time is 0 — every back/forward or re-navigation
        // re-runs the full server render (~276 ms TTFB measured on prod),
        // which is the ~0.5 s "not instant" feel. Holding the prefetched /
        // visited dynamic RSC in the client router cache for 30 s lets a
        // re-navigation render from cache (instant), while the Epic-69 SWR
        // layer still revalidates the DATA on mount/focus so the list is
        // never more than one fetch stale. 30 s mirrors the `cachedSsrPayload`
        // TTL so the two cache layers expire in lockstep. Paired with
        // `prefetch` on the sidebar nav links (nav-item.tsx) so the first
        // click is served from cache too, not just repeat visits.
        staleTimes: {
            dynamic: 30,
            static: 180,
        },
        // The E2E build was OOM-killing its runner.
        //
        // Measured 2026-08-13 on ubuntu-latest (15,989 MB / 4 vCPU), by
        // sampling /proc/meminfo + the build process tree every 1s through
        // `next build --webpack` under NEXT_TEST_MODE:
        //
        //                     peak build RSS      trough available
        //   without this        14,479 MB              275 MB   (5 runs)
        //   with this            8,070 MB            6,880 MB
        //
        // The individual samples matter more than the means, because the
        // means hide the argument. Baseline runs, peak / trough / outcome:
        //
        //   14,548 / 261  lived      14,435 / 285  lived
        //   14,394 / 289  lived      14,449 / 291  lived
        //   14,568 / 251  lived      14,537 / 241  KILLED
        //
        // Read the first and last entries together: the run that peaked
        // HIGHER survived and the one that peaked LOWER was killed. Below
        // this margin the peak is not the variable and the diff under test
        // is not the variable — the timing of the terminal surge is.
        //
        // The build was clearing a 16 GB box by 1.6%. That is not a margin,
        // it is a coin flip — and it presented as one: E2E failed ~3 times in
        // 8 runs with no code cause, on trees that had nothing in common.
        // Two runs make the point on their own: a tree peaking at 14,548 MB
        // SURVIVED while one peaking at 14,537 MB was killed. Below this
        // margin the diff under test does not decide the outcome.
        //
        // Why the failures were unattributable, which is the part worth
        // keeping: NODE_OPTIONS on the E2E build step carries
        // --max-old-space-size=8192, and 8192 EXCEEDS what the box can
        // actually supply once Postgres, Redis and the runner agent are
        // resident. So the kernel OOM-killer always arrived before V8's own
        // limit, and the job died as "The runner has received a shutdown
        // signal" with no heap message and no attribution. A cap set BELOW
        // available memory fails legibly; a cap above it fails silently.
        // Note also that the flag bounds one heap inside the process, not
        // the process: with it set to 8192 the tree still reached 14,479 MB
        // resident, so no value of that flag was ever going to fix this.
        //
        // The flag DOES change the emitted bundle, and the churn is real but
        // semantically empty. Production builds either side, all 882 static
        // chunks compared:
        //
        //   files 882 = 882      distinct module ids 1,210 = 1,210
        //   module definitions 3,915 = 3,915
        //   total bytes 10,754,726 vs 10,754,722   (-4 bytes, -0.00004%)
        //   142 module ids renumbered 1:1; 0 ids differ in definition count
        //
        // i.e. the same modules, renumbered and redistributed across chunks.
        // 182 of 882 chunks change content hash as a result, so a deploy
        // invalidates ~21% of chunk caches ONCE — the ordinary consequence of
        // any bundler-affecting change, including every dependency bump.
        //
        // Note per-chunk textual comparison does NOT show this: module bodies
        // reference other modules' ids, so redistribution defeats any
        // normalisation applied within a single chunk. Compare the module set
        // across the WHOLE bundle instead.
        //
        // Re-derive rather than trust: set NEXT_TEST_MODE=1 and sample
        // MemAvailable + the build tree's RSS through a build.
        webpackMemoryOptimizations: true,
        // optimizePackageImports remains experimental in Next 15.
        // Barrel/submodule packages — let Next rewrite imports to the
        // specific entry points so unused code tree-shakes out of the
        // initial chunks (faster time-to-interactive on chart/list pages).
        optimizePackageImports: [
            'lucide-react',
            // In-repo Nucleo icon barrel — `index.ts` re-exports ~hundreds
            // of single-icon modules via `export *`. Listing it here lets
            // Next rewrite `import { X } from '@/components/ui/icons/nucleo'`
            // to the specific icon module, so an unused icon never lands in
            // a page chunk. The icon-import-discipline guard keeps every
            // consumer on the named-import form this optimization needs.
            '@/components/ui/icons/nucleo',
            '@tanstack/react-query',
            // Charting — visx submodules + motion load eagerly via the
            // chart components on dashboard / risks / assets / etc.
            'motion',
            '@visx/shape',
            '@visx/scale',
            '@visx/curve',
            '@visx/gradient',
            '@visx/group',
            '@visx/responsive',
            '@visx/text',
            '@visx/tooltip',
            '@visx/axis',
            '@visx/event',
        ],
    },
    async headers() {
        return [
            {
                // Apply these headers to all routes globally.
                // NOTE: Content-Security-Policy is set dynamically in middleware.ts
                // (per-request nonce) and is NOT included here.
                source: '/(.*)',
                headers: [
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    },
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY',
                    },
                    {
                        key: 'Permissions-Policy',
                        value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
                    },
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin',
                    },
                    {
                        key: 'Cross-Origin-Resource-Policy',
                        value: 'same-origin',
                    },
                    {
                        // Note: Only add max-age and preload if you guarantee HTTPS.
                        key: 'Strict-Transport-Security',
                        value: process.env.NODE_ENV === 'production' 
                            ? 'max-age=31536000; includeSubDomains; preload' 
                            : 'max-age=0',
                    },
                ],
            },
        ];
    },
};

/** @type {import('next').NextConfig} */
const nextConfig = {
    ...defaultOptions,
    // When the deploy sits behind a CDN (CloudFront — see docs/cdn.md),
    // ASSET_PREFIX is set to the CDN domain so the HTML emits CDN-hosted
    // URLs for /_next/static/*. Unset in dev + on the bare-VM deploy,
    // where assets are served from the origin directly.
    assetPrefix: process.env.ASSET_PREFIX || undefined,
    // Drop the default `X-Powered-By: Next.js` response header — version/
    // tech fingerprinting aids attackers and adds no value. Closes the
    // nightly ZAP baseline finding 10037 (Server Leaks Information via
    // "X-Powered-By"). See docs/dast.md.
    poweredByHeader: false,
    // Use a separate build directory for E2E tests to avoid .next cache
    // contention when multiple dev servers run concurrently.
    ...(process.env.NEXT_TEST_MODE ? { distDir: '.next-test' } : {}),
    eslint: {
        // Lint runs separately in CI (npm run lint). Don't block builds.
        ignoreDuringBuilds: true,
    },
    typescript: {
        // TS errors are checked separately. Don't block production builds.
        ignoreBuildErrors: true,
    },
};
module.exports = withBundleAnalyzer(withNextIntl(nextConfig));
