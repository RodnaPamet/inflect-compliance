/**
 * The mobile audit — every page of the app on a phone, measured.
 *
 *     npm run mobile:audit -- --base-url http://localhost:3000 --create-records
 *
 * against a running app (the E2E build is the reference: `next build` with
 * `NEXT_TEST_MODE=1` + `next start`, on a database seeded by
 * `prisma/seed.ts`). It enumerates every `src/app/**\/page.tsx` route, fills
 * dynamic segments from the database (`resolve.ts`), signs in the way
 * `tests/e2e` does, loads each page in each phone configuration
 * (`configs.ts`), measures it (`measure.ts`, the same module the mobile E2E
 * project uses), and writes `metrics.json`, `summary.md` and screenshots.
 *
 * Flags:
 *   --base-url <url>      the running app (default http://localhost:3000)
 *   --database-url <url>  the database the app reads (default $DATABASE_URL)
 *   --routes <a,b,...>    only routes whose pattern contains one of these fragments, e.g. 'risks,controls'
 *   --configs <ids>       comma-separated (default 390-dark-bg,390-light-en,360-dark-bg)
 *   --out <dir>           report directory (default tmp/mobile-audit/<timestamp>)
 *   --concurrency <n>     pages measured at once per configuration (default 2)
 *   --no-screenshots      measure only
 *   --no-states           skip the open states (drawer, menus, sheets…)
 *   --compare <file>      a previous metrics.json: print every count that moved,
 *                         exit 1 if any count of failing pages went up, and
 *                         write comparison.md + comparison.json beside the report
 *   --chromium <path>     a Chromium binary, when Playwright's own is not installed
 *   --create-records      first run the fixture setup (fixtures.ts): create, through
 *                         the app's API, the records the seed lacks, and mint the
 *                         tokens the public pages open with. WRITES to the
 *                         database: use a throwaway audit database only
 *
 * See docs/mobile-audit.md for what each metric means and how this relates to
 * the mobile E2E project's ratchet.
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoUnknownArgs, readValueFlag } from '../lib/value-flag';
import { signInOrgContext, signInTenantContext } from './auth';
import { AUDIT_CONFIG_IDS, PHONE_CONFIGS, contextOptionsFor, preferenceCookies, type PhoneConfig, type PhoneConfigId } from './configs';
import { findEnglishLeaks, loadLeakCatalog, type LeakCatalog } from './leaks';
import { countsOf, measurePage, settlePage, type RawMeasurement } from './measure';
import { compareReports, renderComparison, renderSummary, type AuditReport, type CapturedPage, type UncapturedPage } from './report';
import { connectDb, dataNames, libraryTexts, resolveContext, resolveRoute, type ResolvedRoute } from './resolve';
import { apiFor, setUpAuditFixtures, type SetupOutcome } from './fixtures';
import { enumerateRoutes, routeSlug, type RouteAudience } from './routes';
import { OPEN_STATES, StateUnavailable, type OpenState } from './states';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Console messages that are network noise, not script errors (as `tests/e2e/e2e-utils.ts` filters them). */
const BENIGN_CONSOLE = [/^Failed to load resource/, /Failed to fetch RSC payload/, /ClientFetchError/];

interface Options {
    baseUrl: string;
    databaseUrl: string;
    routeFilter: ((pattern: string) => boolean) | null;
    configs: PhoneConfig[];
    out: string;
    concurrency: number;
    screenshots: boolean;
    states: boolean;
    compare: string | null;
    chromium: string | null;
    createRecords: boolean;
}

/**
 * `--routes` is a list of plain fragments, matched as substrings — never a
 * regular expression built from the command line.
 */
function routeFragmentFilter(arg: string): (pattern: string) => boolean {
    const fragments = arg.split(',').map((f) => f.trim()).filter(Boolean);
    return (pattern) => fragments.some((f) => pattern.includes(f));
}

function parseArgs(argv: readonly string[]): Options {
    const BOOL = ['no-screenshots', 'no-states', 'create-records'];
    const VALUE = ['base-url', 'database-url', 'routes', 'configs', 'out', 'concurrency', 'compare', 'chromium'];
    assertNoUnknownArgs(argv, BOOL, VALUE);
    const configIds = (readValueFlag(argv, 'configs')?.split(',') ?? AUDIT_CONFIG_IDS) as PhoneConfigId[];
    for (const id of configIds) if (!(id in PHONE_CONFIGS)) throw new Error(`unknown configuration ${id}; known: ${Object.keys(PHONE_CONFIGS).join(', ')}`);
    const databaseUrl = readValueFlag(argv, 'database-url') ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('set DATABASE_URL or pass --database-url: dynamic routes are filled from the database');
    const routes = readValueFlag(argv, 'routes');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
        baseUrl: (readValueFlag(argv, 'base-url') ?? 'http://localhost:3000').replace(/\/$/, ''),
        databaseUrl,
        routeFilter: routes ? routeFragmentFilter(routes) : null,
        configs: configIds.map((id) => PHONE_CONFIGS[id]),
        out: path.resolve(readValueFlag(argv, 'out') ?? path.join(REPO_ROOT, 'tmp', 'mobile-audit', stamp)),
        concurrency: Math.max(1, Number(readValueFlag(argv, 'concurrency') ?? 2)),
        screenshots: !argv.includes('--no-screenshots'),
        states: !argv.includes('--no-states'),
        compare: readValueFlag(argv, 'compare') ?? null,
        chromium: readValueFlag(argv, 'chromium') ?? null,
        createRecords: argv.includes('--create-records'),
    };
}

interface Job {
    kind: 'route' | 'state';
    id: string;
    audience: RouteAudience;
    url: string;
    state?: OpenState;
}

interface ConfigContexts {
    contexts: Map<RouteAudience, BrowserContext>;
}

async function openContexts(browser: Browser, config: PhoneConfig, opts: Options): Promise<ConfigContexts> {
    const contexts = new Map<RouteAudience, BrowserContext>();
    const make = async () => {
        const ctx = await browser.newContext({ ...contextOptionsFor(config), baseURL: opts.baseUrl });
        await ctx.addCookies(preferenceCookies(config, opts.baseUrl));
        return ctx;
    };
    const tenant = await make();
    await signInTenantContext(tenant);
    contexts.set('tenant', tenant);
    contexts.set('session', tenant);
    const org = await make();
    await signInOrgContext(org);
    contexts.set('org', org);
    contexts.set('anonymous', await make());
    return { contexts };
}

async function capture(
    job: Job,
    page: Page,
    config: PhoneConfig,
    leakInputs: { catalog: LeakCatalog; names: ReadonlySet<string>; library: ReadonlySet<string> },
    opts: Options,
): Promise<CapturedPage | UncapturedPage> {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !BENIGN_CONSOLE.some((re) => re.test(msg.text()))) consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message.slice(0, 300)}`));
    let status: number | null = null;
    try {
        const res = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        status = res?.status() ?? null;
        await settlePage(page);
        if (job.state) await job.state.open(page);
    } catch (e) {
        const reason = e instanceof StateUnavailable ? e.message : `failed to load: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`;
        return { kind: job.kind, id: job.id, config: config.id, reason };
    }
    if (status !== null && status >= 500) {
        return { kind: job.kind, id: job.id, config: config.id, reason: `HTTP ${status}` };
    }
    // A page that navigates while it is measured (a client redirect, a
    // refresh) loses its document under the measurement. Measure once more on
    // the settled page; if it still fails, the page is NOT CAPTURED with the
    // reason. One page must never take the whole report down with it.
    let m: RawMeasurement;
    try {
        m = await measurePage(page, { scrollToEnd: job.kind === 'route' });
    } catch {
        try {
            await settlePage(page);
            m = await measurePage(page, { scrollToEnd: job.kind === 'route' });
        } catch (e) {
            const why = (e instanceof Error ? e.message : String(e)).split('\n')[0];
            console.warn(`[mobile-audit] ${config.id} ${job.id}: measurement failed: ${why}`);
            return { kind: job.kind, id: job.id, config: config.id, reason: `measurement failed: ${why}` };
        }
    }
    const leaks = config.locale === 'bg' ? findEnglishLeaks(m, leakInputs.catalog, leakInputs.names, leakInputs.library) : [];
    let screenshot: string | undefined;
    if (opts.screenshots) {
        // After measuring: the overlay pass scrolled to the end; go back to the top for the picture.
        if (job.kind === 'route') await page.evaluate(() => window.scrollTo(0, 0));
        const file = `${job.kind === 'state' ? `state-${job.id.replace(/^state:/, '')}` : routeSlug(job.id)}__${config.id}.jpg`;
        mkdirSync(path.join(opts.out, 'screenshots'), { recursive: true });
        await page.screenshot({ path: path.join(opts.out, 'screenshots', file), type: 'jpeg', quality: 60 }).catch(() => {});
        screenshot = `screenshots/${file}`;
    }
    const { texts: _t, chromeTexts: _c, viewport: _v, documentWidth: _d, docScrollsSideways: _s, ...metrics } = m;
    const samples: CapturedPage['samples'] = {};
    for (const [k, v] of Object.entries(metrics)) if (v.samples.length) samples[k] = v.samples;
    return {
        kind: job.kind,
        id: job.id,
        config: config.id,
        url: job.url,
        finalUrl: new URL(page.url()).pathname,
        status,
        counts: countsOf(m, { englishLeaks: leaks.length, consoleErrors: consoleErrors.length }),
        samples,
        leaks,
        consoleErrors,
        screenshot,
    };
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const catalog = await loadLeakCatalog(REPO_ROOT);
    const db = connectDb(opts.databaseUrl);
    const allRoutes = enumerateRoutes(REPO_ROOT);
    const routes = opts.routeFilter ? allRoutes.filter((r) => opts.routeFilter!(r.pattern)) : allRoutes;
    let resolved: ResolvedRoute[];
    let names = new Set<string>();
    let library = new Set<string>();
    let stateJobs: Array<Job | UncapturedPage> = [];
    let setup: SetupOutcome | undefined;
    const browser = await chromium.launch(opts.chromium ? { executablePath: opts.chromium } : {});
    try {
        const seeded = await resolveContext(db);
        if (opts.createRecords) {
            // SETUP: the fixtures the detail and token routes need, before anything is measured.
            const { contexts } = await openContexts(browser, opts.configs[0], opts);
            try {
                setup = await setUpAuditFixtures(apiFor(contexts.get('tenant')!.request), apiFor(contexts.get('org')!.request), seeded);
            } finally {
                for (const c of new Set(contexts.values())) await c.close();
            }
            console.log(`[mobile-audit] setup: created ${setup.created.join(', ') || 'nothing (every record already exists)'}; ` +
                `minted ${setup.minted.join(', ') || 'nothing'}; ` +
                `${setup.failed.size ? `FAILED ${[...setup.failed.keys()].join(', ')}` : 'nothing failed'}`);
        }
        const ctx = { ...seeded, setup };
        resolved = await Promise.all(routes.map((r) => resolveRoute(r, ctx)));
        names = await dataNames(db);
        library = await libraryTexts(db);
        if (opts.states) {
            stateJobs = await Promise.all(OPEN_STATES.filter((s) => !opts.routeFilter || opts.routeFilter(s.route)).map(async (s) => {
                const route = allRoutes.find((r) => r.pattern === s.route);
                if (!route) return { kind: 'state' as const, id: `state:${s.id}`, config: '*', reason: `route ${s.route} does not exist` };
                const r = await resolveRoute(route, ctx);
                if ('uncaptured' in r) return { kind: 'state' as const, id: `state:${s.id}`, config: '*', reason: r.uncaptured };
                return { kind: 'state' as const, id: `state:${s.id}`, audience: route.audience, url: r.url, state: s };
            }));
        }
    } catch (e) {
        await browser.close();
        throw e;
    } finally {
        await db.$disconnect();
    }

    const routeJobs: Job[] = [];
    const uncaptured: UncapturedPage[] = [];
    for (const r of resolved) {
        if ('uncaptured' in r) {
            for (const c of opts.configs) uncaptured.push({ kind: 'route', id: r.route.pattern, config: c.id, reason: r.uncaptured });
        } else {
            routeJobs.push({ kind: 'route', id: r.route.pattern, audience: r.route.audience, url: r.url });
        }
    }
    const jobs: Job[] = [...routeJobs];
    for (const s of stateJobs) {
        if ('reason' in s) for (const c of opts.configs) uncaptured.push({ ...s, config: c.id });
        else jobs.push(s);
    }

    mkdirSync(opts.out, { recursive: true });
    console.log(`[mobile-audit] ${routes.length} routes (${routeJobs.length} resolvable), ${jobs.length - routeJobs.length} states, ` +
        `${opts.configs.length} configurations → ${opts.out}`);

    const captured: CapturedPage[] = [];
    try {
        for (const config of opts.configs) {
            const { contexts } = await openContexts(browser, config, opts);
            const queue = [...jobs];
            let done = 0;
            const worker = async () => {
                for (let job = queue.shift(); job; job = queue.shift()) {
                    const page = await contexts.get(job.audience)!.newPage();
                    try {
                        const result = await capture(job, page, config, { catalog, names, library }, opts);
                        if ('reason' in result) uncaptured.push(result);
                        else captured.push(result);
                    } finally {
                        await page.close().catch(() => {});
                    }
                    done += 1;
                    if (done % 20 === 0 || done === jobs.length) console.log(`[mobile-audit] ${config.id}: ${done}/${jobs.length}`);
                }
            };
            await Promise.all(Array.from({ length: opts.concurrency }, worker));
            for (const ctx of new Set(contexts.values())) await ctx.close();
        }
    } finally {
        await browser.close();
    }

    let commit: string | null = null;
    try {
        commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
        /* not a checkout */
    }
    const sortKey = (p: { id: string; config: string }) => `${p.config} ${p.id}`;
    const report: AuditReport = {
        generatedAt: new Date().toISOString(),
        baseUrl: opts.baseUrl,
        commit,
        configs: opts.configs.map((c) => c.id),
        routeCount: routes.length,
        captured: captured.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
        uncaptured: uncaptured.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
        ...(setup ? { setup: { created: setup.created, minted: setup.minted, failed: Object.fromEntries(setup.failed) } } : {}),
    };
    writeFileSync(path.join(opts.out, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
    const summary = renderSummary(report);
    writeFileSync(path.join(opts.out, 'summary.md'), `${summary}\n`);
    console.log(summary.split('\n## Open states')[0].split('\n## Not captured')[0]);
    console.log(`[mobile-audit] wrote ${path.join(opts.out, 'summary.md')}`);

    if (opts.compare) {
        const reference = JSON.parse(readFileSync(opts.compare, 'utf8')) as AuditReport;
        const { rows, regressions } = compareReports(reference, report);
        // Beside the summary, for whoever reads the report and for the
        // scheduled workflow, which reads `regressions` to decide whether to
        // open an issue (a crash exits 1 too, and must not read as a regression).
        writeFileSync(path.join(opts.out, 'comparison.md'), `${renderComparison(reference, report)}\n`);
        writeFileSync(path.join(opts.out, 'comparison.json'), `${JSON.stringify({ rows, regressions }, null, 2)}\n`);
        console.log(rows.length ? '\n[mobile-audit] counts that moved (reference → now):' : '\n[mobile-audit] no count moved.');
        for (const r of rows) console.log(`  ${r.config} ${r.metric}: ${r.reference} → ${r.current}${r.current > r.reference ? '   REGRESSION' : ''}`);
        if (regressions.length) process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
