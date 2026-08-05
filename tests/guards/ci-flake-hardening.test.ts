/**
 * CI flake-hardening ratchet (2026-06-18).
 *
 * Locks two fixes for recurring CI flakes that repeatedly cancelled
 * otherwise-green PRs:
 *
 *   1. `concurrency.cancel-in-progress` must NOT be a bare `true`. A PR's
 *      `synchronize` fires when its merge-ref is recomputed (e.g. `main`
 *      advancing via semantic-release's per-merge release commit) WITHOUT a
 *      new PR commit; bare cancel-in-progress then killed the still-in-flight
 *      Build/Docker job while finished siblings stayed green. Allowed values
 *      are `false` (never cancel — current setting; also protects the CodeQL
 *      + Trivy SARIF uploads on push-to-main from being cancelled mid-flight,
 *      which left both tools "reporting errors" on the Security tab) OR the
 *      PR-aware expression that only cancels for push events. Bare `true` is
 *      banned either way.
 *   2. The Build + Docker Build jobs must keep headroom over their observed
 *      durations so a slow-but-fine cold build isn't cancelled as a timeout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const CI = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/ci.yml'),
    'utf8',
);

const SETUP_ACTION = fs.readFileSync(
    path.resolve(__dirname, '../../.github/actions/setup-node-prisma/action.yml'),
    'utf8',
);

/** All workflow + composite-action YAML files under .github. */
function githubYamlFiles(): string[] {
    const root = path.resolve(__dirname, '../../.github');
    const out: string[] = [];
    (function walk(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.ya?ml$/.test(e.name)) out.push(full);
        }
    })(root);
    return out;
}

/** First `timeout-minutes` after a job's `name:` line. */
function jobTimeout(jobName: string): number {
    const re = new RegExp(
        `name: ${jobName}\\b[\\s\\S]{0,900}?timeout-minutes:\\s*(\\d+)`,
    );
    const m = CI.match(re);
    if (!m) throw new Error(`no timeout-minutes found for job "${jobName}"`);
    return Number(m[1]);
}

describe('CI flake hardening', () => {
    it('cancel-in-progress never cancels in-flight runs (false, or the PR-aware expression — never a bare true)', () => {
        expect(CI).toMatch(/cancel-in-progress:/);
        expect(CI).not.toMatch(/cancel-in-progress:\s*true\s*$/m);
        // `false` (never cancel — strongest; protects SARIF uploads on push)
        // OR the PR-aware expression both satisfy "don't cancel PR runs on a
        // base-recompute synchronize".
        const isFalse = /cancel-in-progress:\s*false\s*$/m.test(CI);
        const isPrAware = /cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*!=\s*'pull_request'\s*\}\}/.test(CI);
        expect(isFalse || isPrAware).toBe(true);
    });

    it('the Build job has cold-runner headroom (>= 15 min)', () => {
        expect(jobTimeout('Build')).toBeGreaterThanOrEqual(15);
    });

    it('the Docker Build job has headroom for a cold npm-ci layer (>= 40 min)', () => {
        expect(jobTimeout('Docker Build')).toBeGreaterThanOrEqual(40);
    });

    it('the Docker Build is resilient to the GHA-cache BlobNotFound flake', () => {
        // cache EXPORT failures must never fail the build.
        expect(CI).toMatch(/cache-to:\s*type=gha,mode=max,ignore-error=true/);
        // The cached build is continue-on-error + has a cacheless retry
        // gated on its failure, so a cache IMPORT 404 (BlobNotFound) can't
        // abort an otherwise-fine build. A real build error still fails the
        // retry (it has no continue-on-error).
        expect(CI).toMatch(/id:\s*docker_build/);
        expect(CI).toMatch(/steps\.docker_build\.outcome\s*==\s*'failure'/);
    });

    it('npm ci is retried (no bare `run: npm ci`) so a transient registry ECONNRESET does not fail the job', () => {
        // The shared setup action installs deps for most jobs; its npm ci
        // must retry like prisma generate already does (2026-06: a registry
        // ECONNRESET during npm ci failed an otherwise-green Build job).
        expect(SETUP_ACTION).toMatch(/for attempt in 1 2 3;[\s\S]{0,160}npm ci/);
        // No workflow or composite action may regress to a bare,
        // un-retried `run: npm ci`.
        const offenders = githubYamlFiles().filter((f) =>
            /run: npm ci\s*$/m.test(fs.readFileSync(f, 'utf8')),
        );
        expect(offenders).toEqual([]);
    });
});

describe('CI timeout ceilings', () => {
    /**
     * Parsed jobs of ci.yml. Uses js-yaml rather than the regex helper
     * above because absence is the thing being asserted — a regex can
     * only find a `timeout-minutes:` that exists, and would silently
     * pass for a job that declares none.
     */
    function ciJobs(): Record<string, { name?: string; 'timeout-minutes'?: number }> {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const yaml = require('js-yaml');
        const doc = yaml.load(CI) as {
            jobs: Record<string, { name?: string; 'timeout-minutes'?: number }>;
        };
        return doc.jobs;
    }

    it('every job declares an explicit timeout-minutes', () => {
        // A job with no ceiling inherits GitHub's default of 360 minutes.
        // Found by the 2026-08-03 sweep: `test-summary` had none, so a
        // hang in a job that normally runs 2-5 SECONDS could have burned
        // six hours of runner time. Absence is the failure mode this
        // catches — a missing ceiling looks identical to a healthy job
        // until something wedges.
        const missing = Object.entries(ciJobs())
            .filter(([, j]) => typeof j['timeout-minutes'] !== 'number')
            .map(([id]) => id);
        expect(missing).toEqual([]);
    });

    it('no job carries a ceiling near its observed runtime', () => {
        // Floors from the 2026-08-03 sweep (17 CI runs), each set with
        // real margin over the OBSERVED MAXIMUM, not the median:
        //
        //   job            median   max      ceiling
        //   Coverage       33m24s   35m15s*  50
        //   Trivy          8m42s    12m18s   25
        //   Security       1m05s    3m30s    12
        //   E2E            18m41s   19m43s   40
        //   Docker Build   16m46s   20m10s   40
        //   (* cancelled AT the ceiling — true value unknown, >35)
        //
        // Two of these were cancelled in production before the sweep
        // (Coverage #1780, Trivy #1781), both having reported green
        // while sitting at 85-97% of budget. A median-day duration says
        // nothing about the tail, so these floors are the record of what
        // the tail actually looked like. Lowering one needs fresh data,
        // not intuition.
        const FLOORS: Record<string, number> = {
            // The coverage RUN was sharded 4 ways on 2026-08-05, so the
            // 50-minute floor no longer belongs to the job that carries
            // the "Coverage (≥60%)" name — that job is now a download +
            // merge + threshold check with no test execution in it at
            // all. This is not a floor being lowered on the same work;
            // it is the same work split, and the floor follows the work:
            //
            //   Coverage (shard N/4)   the 35-min unsharded tail / 4
            //                          ≈ 9 min, plus the ~6-min npm ci
            //                          retry path this map accounts for
            //                          everywhere else -> 20
            //   Coverage (≥60%)        merge of four JSON files -> 8
            //
            // If the shards are ever de-sharded back into one job, this
            // entry has to go back to 50 in the same diff.
            'Coverage (shard ${{ matrix.shard }}/${{ matrix.total }})': 20,
            'Coverage (≥60%)': 8,
            'Trivy Image Scan': 25,
            Security: 12,
            E2E: 40,
            'Docker Build': 40,
            // Added 2026-08-04 — the sweep's own blind spot. Every one
            // of its 17 sampled runs had a clean `npm ci`, so the
            // sample could not contain the tail that actually fails.
            // The shared setup action retries npm ci three times with
            // 10s+20s backoff (~5-7 min on a cold cache) BEFORE the
            // job's own work begins, and Typecheck was cancelled at 8
            // minutes on #1786 for exactly that reason while showing
            // 2.74x headroom on paper.
            //
            // So for any job that installs dependencies the budget is
            // observed-max PLUS the retry path, never observed-max
            // alone:
            //   Lint        3m04s + ~6m retry -> 20
            //   Typecheck   2m55s + ~6m retry -> 20
            //   Build       5m05s + ~6m retry -> 25
            //   Load Smoke  6m13s + ~6m retry -> 25  (was ZERO margin)
            Lint: 20,
            Typecheck: 20,
            Build: 25,
            'Load Smoke (k6)': 25,
        };
        const jobs = Object.values(ciJobs());
        for (const [name, floor] of Object.entries(FLOORS)) {
            const job = jobs.find((j) => j.name === name);
            expect({ name, found: Boolean(job) }).toEqual({ name, found: true });
            expect({ name, timeout: job!['timeout-minutes'] }).toEqual({
                name,
                timeout: expect.any(Number),
            });
            expect({ name, atLeast: job!['timeout-minutes']! >= floor }).toEqual({
                name,
                atLeast: true,
            });
        }
    });
});
