/**
 * DAST (OWASP ZAP) gating invariants — nightly baseline + weekly full scan.
 *
 * WHY THIS FILE WAS REWRITTEN (2026-08-29). The previous version asserted
 * the scan was non-blocking and called the next block a "sunset check":
 *
 *     const sunset = lines.some(
 *         (l) => /^\s*#/.test(l) && /\d{4}-\d{2}-\d{2}/.test(l) && /fail_action:\s*true/.test(l),
 *     );
 *
 * That greps for the SHAPE of a comment. It never parsed the date and never
 * compared it to anything, so it was structurally incapable of failing: the
 * declared 2026-07-24 sunset passed and the guard stayed green for 36 days
 * while reading, in CI, as coverage of exactly that deadline. A check that
 * cannot fire is worse than no check.
 *
 * The invariant now enforced instead:
 *
 *   1. A DAST scan step is BLOCKING (`fail_action: true`, no
 *      `continue-on-error`) unless it declares a dated deferral.
 *   2. A deferral is a machine-readable `DAST-NON-BLOCKING-UNTIL: YYYY-MM-DD`
 *      marker, and this guard compares it TO THE REAL CLOCK — it fails the
 *      day after the date passes. A deferral cannot outlive its deadline.
 *   3. A deferral never covers High/Critical. Every scan runs
 *      `.zap/assert-no-high-risk.mjs`, which fails on a HIGH even when a
 *      `.zap/rules.tsv` IGNORE line covers the rule.
 *
 * The date arithmetic is exercised against fixed clocks below, so this file
 * proves the comparison is live rather than asserting the current markers
 * happen to be in the future (an all-green population would otherwise look
 * identical to a check that never ran).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const DAST_YML = '.github/workflows/dast.yml';
const DAST_FULL_YML = '.github/workflows/dast-full.yml';
const RULES_TSV = '.zap/rules.tsv';
const HIGH_GATE = '.zap/assert-no-high-risk.mjs';

/** Every workflow in the DAST family; both obey the same gating rules. */
const DAST_WORKFLOWS = [DAST_YML, DAST_FULL_YML];

/**
 * The deferral marker. A REAL date is required — the prose placeholder
 * `DAST-NON-BLOCKING-UNTIL: <YYYY-MM-DD>` in dast.yml's header, which
 * documents the mechanism rather than invoking it, deliberately does not
 * match.
 */
const DEFERRAL_RE = /DAST-NON-BLOCKING-UNTIL:\s*(\d{4}-\d{2}-\d{2})/g;

/**
 * A deferral longer than this is a way of never deciding. Six months is
 * already generous for "we are tuning an allowlist".
 */
const MAX_DEFERRAL_DAYS = 180;

interface WorkflowStep {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    'continue-on-error'?: boolean | string;
    with?: Record<string, unknown>;
}
interface WorkflowJob {
    steps?: WorkflowStep[];
}
interface Workflow {
    jobs?: Record<string, WorkflowJob>;
}

const abs = (rel: string) => path.join(ROOT, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf-8');
const loadWorkflow = (rel: string) => yaml.load(read(rel)) as Workflow;

/** Every step in the file that runs a ZAP scan action (baseline or full). */
function zapScanSteps(wf: Workflow): WorkflowStep[] {
    return Object.values(wf.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('zaproxy/action-'));
}

/**
 * A scan step is blocking when a finding can actually turn the job red.
 * BOTH switches matter: `continue-on-error` overrides the action's own
 * verdict, and action-baseline/full only call `core.setFailed` on a
 * findings exit code when `fail_action` is true.
 */
function isBlocking(step: WorkflowStep): boolean {
    const continueOnError = String(step['continue-on-error'] ?? 'false').toLowerCase() === 'true';
    const failAction = String(step.with?.fail_action ?? 'false').toLowerCase() === 'true';
    return failAction && !continueOnError;
}

/** Dated deferral markers declared in a workflow file, in file order. */
function deferralDates(rel: string): string[] {
    return [...read(rel).matchAll(DEFERRAL_RE)].map((m) => m[1]);
}

type DeferralVerdict = 'active' | 'expired' | 'unreasonable';

/**
 * The live half of this guard. `now` is injected so the arithmetic can be
 * pinned by tests; the real assertions pass `new Date()`.
 *
 * The deadline day itself is still active (end-of-day UTC), so a marker
 * dated today does not fail until tomorrow.
 */
function deferralVerdict(dateStr: string, now: Date): DeferralVerdict {
    const deadline = Date.parse(`${dateStr}T23:59:59Z`);
    if (Number.isNaN(deadline)) return 'expired'; // an unparseable date is not a deferral
    if (now.getTime() > deadline) return 'expired';
    const maxAhead = now.getTime() + MAX_DEFERRAL_DAYS * 24 * 60 * 60 * 1000;
    if (deadline > maxAhead) return 'unreasonable';
    return 'active';
}

describe('DAST deferral clock', () => {
    // These fix the mechanism itself. Without them, a population whose
    // markers all sit in the future is indistinguishable from a comparison
    // that never happens — which is precisely how the old check failed.
    const now = new Date('2026-08-29T08:00:00Z');

    it('a marker whose date has passed is EXPIRED', () => {
        expect(deferralVerdict('2026-07-24', now)).toBe('expired');
        expect(deferralVerdict('2026-08-28', now)).toBe('expired');
    });

    it('the deadline day itself is still active, the next day is not', () => {
        expect(deferralVerdict('2026-08-29', now)).toBe('active');
        expect(deferralVerdict('2026-08-29', new Date('2026-08-30T00:00:01Z'))).toBe('expired');
    });

    it('a date beyond the maximum window is UNREASONABLE, not a deferral', () => {
        expect(deferralVerdict('2026-10-11', now)).toBe('active');
        expect(deferralVerdict('2099-01-01', now)).toBe('unreasonable');
    });

    it('an unparseable date is treated as expired, never as an open deferral', () => {
        expect(deferralVerdict('not-a-date', now)).toBe('expired');
    });
});

describe('DAST workflow gating', () => {
    it.each(DAST_WORKFLOWS)('%s exists and declares a ZAP scan step', (rel) => {
        expect(fs.existsSync(abs(rel))).toBe(true);
        expect(zapScanSteps(loadWorkflow(rel)).length).toBeGreaterThan(0);
    });

    it.each(DAST_WORKFLOWS)(
        '%s: every non-blocking scan carries an UNEXPIRED dated deferral',
        (rel) => {
            const steps = zapScanSteps(loadWorkflow(rel));
            const nonBlocking = steps.filter((s) => !isBlocking(s));
            const dates = deferralDates(rel);

            if (nonBlocking.length === 0) {
                // A blocking scan must not leave a stale deferral behind —
                // it would read as an open decision that is already made.
                expect({ file: rel, staleDeferrals: dates }).toEqual({
                    file: rel,
                    staleDeferrals: [],
                });
                return;
            }

            expect({
                file: rel,
                nonBlockingSteps: nonBlocking.map((s) => s.name ?? s.uses),
                markers: dates,
            }).toEqual({
                file: rel,
                nonBlockingSteps: nonBlocking.map((s) => s.name ?? s.uses),
                markers: [expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)],
            });

            const verdict = deferralVerdict(dates[0], new Date());
            expect({
                file: rel,
                deferredUntil: dates[0],
                verdict,
                fix:
                    `${rel} runs its ZAP scan non-blocking under a deferral that is no longer ` +
                    `valid. Either drop continue-on-error + set fail_action: true (the nightly ` +
                    `baseline did this on 2026-08-29), or move DAST-NON-BLOCKING-UNTIL with a ` +
                    `written reason. See docs/dast.md.`,
            }).toMatchObject({ verdict: 'active' });
        },
    );

    it('the nightly baseline is BLOCKING (its tuning window closed 2026-07-24)', () => {
        const steps = zapScanSteps(loadWorkflow(DAST_YML));
        expect(steps.map((s) => ({ name: s.name, blocking: isBlocking(s) }))).toEqual(
            steps.map((s) => ({ name: s.name, blocking: true })),
        );
        expect(deferralDates(DAST_YML)).toEqual([]);
    });

    it.each(DAST_WORKFLOWS)('%s: a deferral never covers HIGH+ — the gate always runs', (rel) => {
        const wf = loadWorkflow(rel);
        const gateSteps = Object.values(wf.jobs ?? {})
            .flatMap((job) => job.steps ?? [])
            .filter((s) => typeof s.run === 'string' && s.run.includes(HIGH_GATE));
        expect({ file: rel, gateSteps: gateSteps.length }).toEqual({ file: rel, gateSteps: 1 });
        // It must run even when the scan step already failed, else a scan
        // that exits non-zero would skip the HIGH+ verdict entirely.
        expect(gateSteps[0]).toMatchObject({ if: 'always()' });
    });

    it('the HIGH+ gate script exists', () => {
        expect(fs.existsSync(abs(HIGH_GATE))).toBe(true);
    });
});

describe('DAST workflow scope', () => {
    const nightly = read(DAST_YML);
    const weekly = read(DAST_FULL_YML);

    it('the baseline runs nightly and the full scan weekly', () => {
        expect(nightly).toMatch(/-\s*cron:\s*'0 4 \* \* \*'/);
        expect(weekly).toMatch(/-\s*cron:\s*'0 5 \* \* 0'/);
    });

    it('the full scan uses the ACTIVE action, the baseline the passive one', () => {
        expect(weekly).toMatch(/zaproxy\/action-full-scan@/);
        expect(weekly).not.toMatch(/zaproxy\/action-baseline@/);
        expect(nightly).toMatch(/zaproxy\/action-baseline@/);
    });

    it.each(DAST_WORKFLOWS)('%s authenticates via the real NextAuth credentials flow', (rel) => {
        // action-baseline/full only support header-injection auth; without
        // the session cookie the scan never reaches a gated route.
        const yml = read(rel);
        expect(yml).toMatch(/\/api\/auth\/callback\/credentials/);
        expect(yml).toMatch(/ZAP_AUTH_HEADER=Cookie/);
        expect(yml).toMatch(/ZAP_AUTH_HEADER_VALUE=next-auth\.session-token=/);
    });

    it('the baseline scans the full role matrix (owner/editor/reader/auditor)', () => {
        for (const role of ['owner', 'editor', 'reader', 'auditor']) {
            expect(nightly).toMatch(new RegExp(`role:\\s*${role}\\b`));
        }
    });

    it('the full scan publishes to its own SARIF category + shares the allowlist', () => {
        expect(weekly).toMatch(/category:\s*zap-full/);
        expect(weekly).toMatch(/rules_file_name:\s*'\.zap\/rules\.tsv'/);
    });
});

describe('.zap/rules.tsv allowlist', () => {
    it('every entry is the ZAP-required 3 columns with a written reason', () => {
        expect(fs.existsSync(abs(RULES_TSV))).toBe(true);
        const dataLines = read(RULES_TSV)
            .split('\n')
            .filter((l) => /^\d+\t/.test(l));

        // At least the three seeded Next.js false-positives.
        expect(dataLines.length).toBeGreaterThanOrEqual(3);

        // ZAP rejects the rules file unless every entry has >= 3
        // tab-separated tokens (id, action, reason). The 3rd column IS the
        // mandatory written reason. (A 2-column file silently breaks every
        // scan.)
        for (const line of dataLines) {
            const cols = line.split('\t');
            expect(cols.length).toBeGreaterThanOrEqual(3);
            expect(['WARN', 'IGNORE', 'FAIL']).toContain(cols[1]);
            expect(cols[2].trim().length).toBeGreaterThan(0);
        }
    });
});
