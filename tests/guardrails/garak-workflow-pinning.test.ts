/**
 * The garak nightly's invariants (docs/ai-architecture/garak.md, Phases 0-1).
 *
 *   1. A non-blocking scan carries a DATED `GARAK-NON-BLOCKING-UNTIL` marker,
 *      and this guard compares it to the real clock, so the deferral cannot
 *      outlive its date. The DAST lesson (dast-workflow-pinning.test.ts): a
 *      marker nobody parses never turns red. The arithmetic is pinned against
 *      fixed clocks below, so a population of future-dated markers cannot hide
 *      a comparison that never happens.
 *   2. Without the CI key the job SKIPS cleanly: the first step reads the
 *      secret, every later step is conditioned on its output, and the key
 *      reaches only the app's process, never job-level env.
 *   3. The spend cap is held in config and the numbers agree (D-EV-1, USD 5 a
 *      night): garak's own request count fits the proxy's wire cap, the roles
 *      fit the night, the night fits the cap at the planned turn cost, and the
 *      product's own AI quota equals the night's request cap.
 *   4. The scanner image is pinned by digest and garak by exact version, and
 *      garak can reach only the local proxy.
 *   5. The allowlist's semantics warning is at the top of the file and every
 *      entry carries a reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = '.github/workflows/garak.yml';
const CONFIG = '.garak/config.yaml';
const BUDGET = '.garak/budget.json';
const DOCKERFILE = '.garak/Dockerfile';
const ALLOWLIST = '.garak/allowlist.tsv';

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** A real date only; the `<YYYY-MM-DD>` placeholder in prose does not match. */
const DEFERRAL_RE = /GARAK-NON-BLOCKING-UNTIL:\s*(\d{4}-\d{2}-\d{2})/g;
const MAX_DEFERRAL_DAYS = 180;

interface Step {
    name?: string;
    id?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    'continue-on-error'?: boolean | string;
}
interface Job {
    env?: Record<string, string>;
    steps?: Step[];
}
interface Workflow {
    on?: Record<string, unknown>;
    jobs?: Record<string, Job>;
}
interface Budget {
    nightlyCapUsd: number;
    model: string;
    usdPerMillionInputTokens: number;
    usdPerMillionOutputTokens: number;
    plannedTurn: { inputTokens: number; outputTokens: number };
    roles: string[];
    maxRequestsPerRole: number;
    maxRequestsPerNight: number;
}
interface GarakConfig {
    system: { parallel_requests: boolean; parallel_attempts: boolean };
    run: { generations: number; soft_probe_prompt_cap: number };
    plugins: {
        probe_spec: string;
        generators: { rest: { RestGenerator: { uri: string } } };
    };
}

type Verdict = 'active' | 'expired' | 'unreasonable';

function deferralVerdict(dateStr: string, now: Date): Verdict {
    const deadline = Date.parse(`${dateStr}T23:59:59Z`);
    if (Number.isNaN(deadline)) return 'expired';
    if (now.getTime() > deadline) return 'expired';
    if (deadline > now.getTime() + MAX_DEFERRAL_DAYS * 86_400_000) return 'unreasonable';
    return 'active';
}

const workflow = yaml.load(read(WORKFLOW)) as Workflow;
const job = workflow.jobs?.garak as Job;
const steps = job?.steps ?? [];
const budget = JSON.parse(read(BUDGET)) as Budget;
const config = yaml.load(read(CONFIG)) as GarakConfig;
const probes = config.plugins.probe_spec.split(',').map((p) => p.trim()).filter(Boolean);

/** The steps that run the scanner itself. */
const scanSteps = steps.filter((s) => typeof s.run === 'string' && /inflect-garak:ci\s+--config/.test(s.run));

describe('garak deferral clock', () => {
    const now = new Date('2026-11-11T08:00:00Z');

    it('a passed date is expired; the deadline day itself is still active', () => {
        expect(deferralVerdict('2026-11-10', now)).toBe('expired');
        expect(deferralVerdict('2026-11-11', now)).toBe('active');
        expect(deferralVerdict('2026-11-11', new Date('2026-11-12T00:00:01Z'))).toBe('expired');
    });

    it('a date beyond the maximum window, or an unparseable one, is never an open deferral', () => {
        expect(deferralVerdict('2027-02-28', now)).toBe('active');
        expect(deferralVerdict('2099-01-01', now)).toBe('unreasonable');
        expect(deferralVerdict('not-a-date', now)).toBe('expired');
    });
});

describe('garak workflow gating', () => {
    it('declares exactly one scan step, and it is schedule/dispatch only', () => {
        expect(scanSteps.map((s) => s.name)).toEqual([expect.any(String)]);
        expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    });

    it('a non-blocking scan carries exactly one UNEXPIRED dated deferral; a blocking one carries none', () => {
        const dates = [...read(WORKFLOW).matchAll(DEFERRAL_RE)].map((m) => m[1]);
        const nonBlocking = scanSteps.filter(
            (s) => String(s['continue-on-error'] ?? 'false').toLowerCase() === 'true',
        );
        if (nonBlocking.length === 0) {
            expect({ staleDeferrals: dates }).toEqual({ staleDeferrals: [] });
            return;
        }
        expect(dates).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
        expect({
            deferredUntil: dates[0],
            verdict: deferralVerdict(dates[0], new Date()),
            fix:
                `${WORKFLOW} runs garak non-blocking under a deferral that is no longer valid. ` +
                `Make it a gate (Phase 2: thresholds + assert-thresholds, remove continue-on-error ` +
                `and the marker), or move GARAK-NON-BLOCKING-UNTIL with a written reason.`,
        }).toMatchObject({ verdict: 'active' });
    });

    it('no step other than the scan is allowed to swallow its own failure', () => {
        const swallowing = steps
            .filter((s) => String(s['continue-on-error'] ?? 'false').toLowerCase() === 'true')
            .map((s) => s.name);
        expect(swallowing).toEqual(scanSteps.map((s) => s.name));
    });
});

describe('garak skips cleanly without its CI key', () => {
    it('the first step reads GARAK_CI_ANTHROPIC_KEY and records whether it is present', () => {
        expect(steps[0]).toMatchObject({ id: 'key' });
        expect(steps[0].env?.KEY).toBe('${{ secrets.GARAK_CI_ANTHROPIC_KEY }}');
        expect(steps[0].run).toMatch(/present=false/);
    });

    it('every later step is conditioned on the key being present', () => {
        const unconditioned = steps
            .slice(1)
            .filter((s) => !String(s.if ?? '').includes("steps.key.outputs.present == 'true'"))
            .map((s) => s.name ?? s.uses);
        expect(unconditioned).toEqual([]);
    });

    it('the key reaches only the app process, never job-level env', () => {
        const secretRef = /secrets\.GARAK_CI_ANTHROPIC_KEY/;
        expect(JSON.stringify(job.env ?? {})).not.toMatch(secretRef);
        const carriers = steps.filter((s) => secretRef.test(JSON.stringify(s.env ?? {}))).map((s) => s.id ?? s.name);
        expect(carriers).toEqual(['key', 'Start app (background)']);
        const start = steps.find((s) => s.name === 'Start app (background)');
        expect(start?.env?.ANTHROPIC_API_KEY).toBe('${{ secrets.GARAK_CI_ANTHROPIC_KEY }}');
    });
});

describe('garak spend cap (D-EV-1: USD 5 a night)', () => {
    const plannedUsdPerRequest =
        (budget.plannedTurn.inputTokens * budget.usdPerMillionInputTokens +
            budget.plannedTurn.outputTokens * budget.usdPerMillionOutputTokens) /
        1_000_000;

    it('the cap is the decided USD 5, on the decided Haiku-class model', () => {
        expect(budget.nightlyCapUsd).toBe(5);
        expect(budget.model).toMatch(/haiku/);
        expect(job.env?.AGENT_FLUE_MODEL).toBe(budget.model);
    });

    it("garak's own request count fits the proxy's per-role wire cap", () => {
        expect(config.run.generations).toBe(1);
        expect(config.system.parallel_requests).toBe(false);
        expect(config.system.parallel_attempts).toBe(false);
        const perRole = probes.length * config.run.soft_probe_prompt_cap * config.run.generations;
        expect(perRole).toBeGreaterThan(0);
        expect(perRole).toBeLessThanOrEqual(budget.maxRequestsPerRole);
    });

    it('the roles fit the night, and the night fits the cap at the planned turn cost', () => {
        expect(budget.roles.length * budget.maxRequestsPerRole).toBeLessThanOrEqual(budget.maxRequestsPerNight);
        expect(budget.maxRequestsPerNight * plannedUsdPerRequest).toBeLessThanOrEqual(budget.nightlyCapUsd);
    });

    it("the product's own per-tenant AI quota equals the night's request cap", () => {
        expect(job.env?.AI_RISK_DAILY_QUOTA).toBe(String(budget.maxRequestsPerNight));
    });

    it('the scan loop probes exactly the budgeted roles, and the proxy reads the budget', () => {
        const scan = scanSteps[0].run ?? '';
        const looped = [...scan.matchAll(/(\w+):[\w.]+@acme\.com/g)].map((m) => m[1]);
        expect(looped).toEqual(budget.roles);
        expect(scan).toMatch(/maxRequestsPerRole/);
        expect(scan).toMatch(/GARAK_MAX_REQUESTS="\$MAX_PER_ROLE"/);
        expect(scan).toMatch(/spend\.mjs may-continue/);
    });
});

describe('garak image and reach', () => {
    it('the base image is pinned by digest and garak by exact version', () => {
        const lines = read(DOCKERFILE).split('\n');
        expect(lines.filter((l) => l.startsWith('FROM '))).toEqual([
            expect.stringMatching(/^FROM [\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/),
        ]);
        expect(lines.filter((l) => l.startsWith('ARG GARAK_VERSION='))).toEqual([
            expect.stringMatching(/^ARG GARAK_VERSION=\d+\.\d+\.\d+$/),
        ]);
        expect(lines.filter((l) => l.includes('pip install'))).toEqual([
            'RUN pip install "garak==${GARAK_VERSION}"',
        ]);
    });

    it('the workflow runs only the image it built, never a pulled tag', () => {
        const runs = steps.map((s) => s.run ?? '').join('\n');
        const images = [...runs.matchAll(/docker run[^\n]*?\s(\S+:\S+)\s+--/g)].map((m) => m[1]);
        expect(images.length).toBeGreaterThan(0);
        expect(new Set(images)).toEqual(new Set(['inflect-garak:ci']));
    });

    it('garak reaches only the local target proxy, never the app or a vendor directly', () => {
        expect(config.plugins.generators.rest.RestGenerator.uri).toMatch(/^http:\/\/127\.0\.0\.1:3107\//);
        const vendorOrCredential = /api\.anthropic\.com|openrouter|session-token/i;
        expect(vendorOrCredential.test(read(CONFIG))).toBe(false);
    });

    it('runs no Jest, so it stays out of the coverage partition', () => {
        const runsJest = /\bnpx jest\b|npm (run )?test/;
        expect(runsJest.test(read(WORKFLOW))).toBe(false);
    });
});

describe('.garak/allowlist.tsv', () => {
    const tsv = read(ALLOWLIST);

    it('opens with the warning that an IGNORE silences a class at every severity', () => {
        const header = tsv.split('\n').slice(0, 20).join('\n');
        expect(header).toMatch(/silences that class at EVERY hit rate and EVERY\s+# severity/);
    });

    it('every entry is three tab-separated columns with a written reason', () => {
        const bad = tsv
            .split('\n')
            .filter((l) => l.trim() !== '' && !l.startsWith('#'))
            .filter((l) => {
                const cols = l.split('\t');
                return cols.length < 3 || !['IGNORE', 'WARN'].includes(cols[1]) || cols[2].trim() === '';
            });
        expect(bad).toEqual([]);
    });
});
