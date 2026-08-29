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
        //
        // If the ratio of comment to code here looks wrong, that ratio IS the
        // finding. Because the failure carried no attribution, two sessions
        // spent an afternoon on it, a verified-working production fix was
        // reverted on the strength of a correlation, and background jobs were
        // down for hours. None of that was a code defect. The measurement is
        // written down at this length so the next person spends ten minutes.
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
        // Build workers were OFF, and not by anyone's decision.
        //
        // next/dist/build/index.js:850:
        //   useBuildWorker = config.experimental.webpackBuildWorker
        //     || config.experimental.webpackBuildWorker === undefined
        //        && !config.webpack;
        //
        // i.e. auto-on UNLESS a custom `config.webpack` exists. `next-intl/
        // plugin` injects one — purely to alias ./src/i18n.ts — which
        // silently flipped this off. Verified live: `withNextIntl({})`
        // yields keys `turbopack,webpack`, and useBuildWorker evaluates
        // false. (@next/bundle-analyzer with enabled:false returns the
        // config untouched, so it is not the cause.)
        //
        // Consequence: the client, server and edge compilations all run in
        // the PARENT process, in one heap, with nothing released between
        // them. Peak heap is their accumulated union rather than the
        // largest single compilation — which is exactly the shape of the
        // ~6.1 GB wall this build kept hitting. Next's own guidance says to
        // set it explicitly in this situation (its memory-usage guide:
        // "allows you to run Webpack compilations inside a separate Node.js
        // worker which will decrease memory usage").
        //
        // Why it became necessary rather than merely nice. Both ceilings
        // were exhausted: 6144 gives a deterministic V8 OOM ("Reached heap
        // limit", Mark-Compact 6133.6 MB), and 8192 gets the process
        // OOM-KILLED by the kernel — including in a job with no service
        // containers at all, which is what ruled out container contention
        // as the cause. Demand had to come down; this is the only lever
        // that reduces it rather than moving it around.
        //
        // ── FOLLOW-UP, 2026-08-19: both figures above are SINGLE-HEAP ──
        // They were measured before this flag went on, which is the state
        // this comment exists to describe. Turning the worker on splits the
        // compile into a parent AND a worker, and `--max-old-space-size`
        // arrives via NODE_OPTIONS, so BOTH inherit it — the effective
        // ceiling doubles.
        //
        // CI kept the 8192 that was chosen for one heap, so the real ceiling
        // silently became 16 GB on a 16 GB runner. In-job sampling caught it:
        // 15783 MB used / 206 MB available at peak, on a run that PASSED.
        // That is what produced the intermittent silent build cancellations
        // (kernel OOM-kill -> "signal: SIGKILL" -> "operation was canceled").
        // ci.yml now sets 6144 per process (~12 GB across two heaps).
        //
        // So do NOT read "6144 is a deterministic V8 OOM" as still binding.
        // It was true for ONE heap doing all three compilations.
        webpackBuildWorker: true,
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
const baseConfig = withNextIntl(nextConfig);
const analyzedConfig = withBundleAnalyzer(baseConfig);

/**
 * THE ANALYZER RUNS ON THE CLIENT COMPILATION ONLY.
 *
 * `@next/bundle-analyzer` installs its plugin from a `webpack(config, options)`
 * hook and keys `reportFilename` on `options.nextRuntime`, so wrapping the
 * whole config installs THREE plugin instances — one per compilation. Next
 * compiles them in the order server, edge-server, client
 * (next/dist/build/webpack-build/index.js), and each instance calls
 * `stats.toJson()` plus `getViewerData()` on `compiler.hooks.done`, holding the
 * full module graph for that compilation live at once.
 *
 * So the SERVER pass runs first and is what exhausts the heap — before the
 * client report, the only one anyone reads, is ever produced. Measured locally
 * on 2026-08-29 at a 13000 MB ceiling: 13.87 GB peak RSS, killed ~6 minutes
 * after the server output stopped growing, with `.next/server` complete and no
 * `.next/static` and no `.next/analyze` written at all.
 *
 * `nodejs.html` and `edge.html` have no consumer in this repo and have not been
 * produced since 2026-08-24; the workflow uploads `.next/analyze/*.html` and
 * the budget it protects is the per-route First Load JS check, which is client.
 *
 * PRODUCTION OUTPUT IS UNCHANGED. With ANALYZE unset the factory returns its
 * input by identity (`if (!enabled) return nextConfig`), so `analyzedConfig`
 * IS `baseConfig` and this wrapper is a strict pass-through. `nextConfig` has
 * no `webpack` hook of its own — the one on `baseConfig` comes from
 * next-intl — so delegating preserves it, and `webpackBuildWorker` is
 * untouched.
 */
module.exports = {
    ...analyzedConfig,
    webpack(config, options) {
        // `nextRuntime` is undefined for the client compilation and 'nodejs' /
        // 'edge' for the others — the same discriminator the analyzer itself
        // uses to name its reports.
        const target = options.nextRuntime ? baseConfig : analyzedConfig;
        return typeof target.webpack === 'function' ? target.webpack(config, options) : config;
    },
};
