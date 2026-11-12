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
 *      night, shared with Ragas by D-EV-2): the price and garak's share come
 *      from the shared cost meter (evals/cost-meter/), garak's own request
 *      count fits the proxy's wire cap, the roles fit the night, one planned
 *      role fits garak's share (so the measured breaker can start one), and
 *      the product's own AI quota equals the night's request cap. garak's count is
 *      probes x cap x generations ONLY for a probe that prunes to the cap, so
 *      every configured probe must be one read, in the pinned garak's source,
 *      to do that.
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
const PROXY = '.garak/target-proxy.mjs';

/**
 * The garak version CAP_HONOURING_PROBES was read against. A version bump
 * re-reads each class (and regenerates tests/fixtures/garak/list-probes-*.txt).
 */
const CAP_READ_AGAINST_GARAK = '0.17.1';

/**
 * Probe classes whose prompt count is at most `soft_probe_prompt_cap`, each
 * with where garak's source does it. A class that builds a fixed prompt set
 * and never prunes (web_injection.MarkdownImageExfil: 4 domains x 3 encodings
 * = 12 prompts whatever the cap) is NOT here, and configuring one fails below
 * rather than overrunning the proxy's wire cap every night.
 */
const CAP_HONOURING_PROBES: Record<string, string> = {
    'promptinject.HijackHateHumans': 'promptinject constructor: max_prompts = soft_probe_prompt_cap, then a slice',
    'promptinject.HijackLongPrompt': 'promptinject constructor: max_prompts = soft_probe_prompt_cap, then a slice',
    'dan.DanInTheWild': 'DanInTheWild.__init__: _prune_data(soft_probe_prompt_cap)',
    'encoding.InjectBase64': 'EncodingMixin.__init__: _prune_data(prune_triggers=True)',
    'encoding.InjectROT13': 'EncodingMixin.__init__: _prune_data(prune_triggers=True)',
    'leakreplay.LiteratureCloze': 'ClozeProbeMixin.__init__: _prune_data, follow_prompt_cap = True via NonFullMixin',
    'web_injection.MarkdownURIImageExfilExtended': 'MarkdownExfilMixin.generate_prompts(templates, soft_probe_prompt_cap)',
    'packagehallucination.Python': 'PackageHallucinationProbe.__init__: _prune_data()',
    'packagehallucination.JavaScript': 'PackageHallucinationProbe.__init__: _prune_data()',
};

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
    model: string;
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
        generators: { rest: { RestGenerator: { uri: string; skip_codes?: number[]; ratelimit_codes?: number[] } } };
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
const shares = JSON.parse(read('evals/cost-meter/shares.json')) as {
    nightlyCapUsd: number;
    shares: Record<string, { usd: number; model: string }>;
};
const prices = JSON.parse(read('evals/cost-meter/prices.json')) as {
    models: Record<string, { usdPerMillionInputTokens: number; usdPerMillionOutputTokens: number }>;
};
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

describe('garak spend cap (D-EV-1: USD 5 a night, shared with Ragas by D-EV-2)', () => {
    const garakShare = shares.shares.garak;
    const price = prices.models[budget.model];
    const plannedUsdPerRequest =
        (budget.plannedTurn.inputTokens * price.usdPerMillionInputTokens +
            budget.plannedTurn.outputTokens * price.usdPerMillionOutputTokens) /
        1_000_000;

    it('garak meters against its share of the decided USD 5, on the decided Haiku-class model', () => {
        expect(shares.nightlyCapUsd).toBe(5);
        expect(garakShare.usd).toBeLessThanOrEqual(shares.nightlyCapUsd);
        expect(garakShare.model).toBe(budget.model);
        expect(budget.model).toMatch(/haiku/);
        expect(job.env?.AGENT_FLUE_MODEL).toBe(budget.model);
        // budget.json carries no price and no cap of its own: a second copy
        // would let garak's numbers drift from the meter Ragas shares.
        expect(budget).not.toHaveProperty('nightlyCapUsd');
        expect(JSON.stringify(budget)).not.toMatch(/usdPerMillion/);
    });

    it('every configured probe prunes to the prompt cap in the pinned garak', () => {
        const pinned = read(DOCKERFILE)
            .split('\n')
            .filter((l) => l.startsWith('ARG GARAK_VERSION='));
        expect(pinned).toEqual([`ARG GARAK_VERSION=${CAP_READ_AGAINST_GARAK}`]);
        const unread = probes.filter((p) => !(p in CAP_HONOURING_PROBES));
        expect({
            unread,
            fix:
                'Read the class in garak\'s source: if it prunes to soft_probe_prompt_cap, add it to ' +
                'CAP_HONOURING_PROBES with where; if not, count its fixed prompts into the per-role budget.',
        }).toMatchObject({ unread: [] });
    });

    it("garak's own request count fits the proxy's per-role wire cap", () => {
        expect(config.run.generations).toBe(1);
        expect(config.system.parallel_requests).toBe(false);
        expect(config.system.parallel_attempts).toBe(false);
        const perRole = probes.length * config.run.soft_probe_prompt_cap * config.run.generations;
        expect(perRole).toBeGreaterThan(0);
        expect(perRole).toBeLessThanOrEqual(budget.maxRequestsPerRole);
    });

    it('the roles fit the night, the night fits the whole cap, and one planned role fits garak\'s share', () => {
        expect(budget.roles.length * budget.maxRequestsPerRole).toBeLessThanOrEqual(budget.maxRequestsPerNight);
        expect(budget.maxRequestsPerNight * plannedUsdPerRequest).toBeLessThanOrEqual(shares.nightlyCapUsd);
        // The measured breaker admits a role only while spent + one planned
        // role fits the share; a share below one planned role starts nothing.
        expect(budget.maxRequestsPerRole * plannedUsdPerRequest).toBeLessThanOrEqual(garakShare.usd);
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

    it('the reader is not probed but its feature-gate refusal is checked, and fails the step if admitted', () => {
        expect(budget.roles).not.toContain('reader');
        const scan = scanSteps[0].run ?? '';
        expect(scan).toContain('login viewer@acme.com');
        expect(scan).toContain('gate=ADMITTED; status=1');
    });
});

describe('garak never aborts on a status it cannot score, and never scores one it should not', () => {
    const rest = config.plugins.generators.rest.RestGenerator;
    const proxySrc = read(PROXY);

    it("the proxy's skip status is exactly the generator's skip_codes, and distinct from a rate limit", () => {
        const skip = /export const SKIP_STATUS = (\d+);/.exec(proxySrc)?.[1];
        expect(skip).toBeDefined();
        expect(rest.skip_codes).toEqual([Number(skip)]);
        expect(rest.ratelimit_codes).toEqual([429]);
        expect(Number(skip)).not.toBe(429);
    });

    it('the probe-name check runs the tested parser, not an inline grep', () => {
        const verify = steps.find((s) => s.name === 'Verify every configured probe exists in this garak');
        expect(verify?.run).toContain('node .garak/verify-probes.mjs /tmp/probes.txt .garak/config.yaml');
        expect(verify?.run).not.toMatch(/grep/);
    });

    it("garak's exit code and the configured probes reach the record", () => {
        const scan = scanSteps[0].run ?? '';
        expect(scan).toContain('echo "$garak_exit" > "garak-out/${role}/garak-exit"');
        const summarise = steps.find((s) => s.name === 'Summarise per role (record + job summary)');
        expect(summarise?.run).toContain('--probes "$spec" --garak-exit');
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
