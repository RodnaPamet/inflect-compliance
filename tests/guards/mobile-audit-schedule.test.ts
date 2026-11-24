/**
 * The whole-product mobile audit runs on its own, compares against the last
 * good night, and says so when a count rose.
 *
 * `.github/workflows/mobile-audit.yml` is the only thing that measures the
 * pages OUTSIDE the mobile E2E project's fixed route set. If it is
 * unscheduled, if it compares against the wrong reference, or if its notifier
 * is unwired, those pages can regress on a phone with nothing going red — the
 * state the product was in before Phase 5 of docs/mobile-roadmap.md.
 *
 * WHAT THIS CAN AND CANNOT SAY. It asserts SHAPE, on parsed fields: the
 * schedule, the reference the comparison reads, the artifact it publishes and
 * the notifier. Whether a night actually ran green is CONDUCT, and only the
 * workflow's own run history can show it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

interface Step {
    id?: string;
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, unknown>;
    env?: Record<string, unknown>;
}
interface Job {
    needs?: string[] | string;
    if?: string;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    env?: Record<string, unknown>;
    steps: Step[];
}
interface Workflow {
    on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown; pull_request?: unknown };
    jobs: Record<string, Job>;
}

const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/mobile-audit.yml'), 'utf8')) as Workflow;
const audit = wf.jobs.audit;
const notify = wf.jobs.notify;
const step = (job: Job, id: string): Step => {
    const s = job.steps.find((x) => x.id === id);
    if (!s) throw new Error(`no step with id ${id}`);
    return s;
};

describe('the nightly whole-product mobile audit', () => {
    it('runs on a schedule, at most daily and at least weekly, and can be started by hand', () => {
        expect(wf.on.schedule).toHaveLength(1);
        const [minute, hour, dom, , dow] = wf.on.schedule![0].cron.split(/\s+/);
        // A fixed minute and hour: sub-daily crons have never fired in this repo.
        expect(minute).toMatch(/^\d+$/);
        expect(hour).toMatch(/^\d+$/);
        expect(dom).toBe('*');
        expect(dow === '*' || /^\d$/.test(dow)).toBe(true);
        expect(wf.on).toHaveProperty('workflow_dispatch');
        // Never per pull request: the fixed route set is the PR-time check.
        expect(wf.on.pull_request).toBeUndefined();
    });

    it('measures the E2E build, as docs/mobile-audit.md names its reference setup', () => {
        expect(audit.env?.NEXT_TEST_MODE).toBe('1');
        expect(audit.env?.NEXT_PUBLIC_TEST_MODE).toBe('1');
        expect(audit.steps.some((s) => typeof s.run === 'string' && /\bnpm run build\b/.test(s.run))).toBe(true);
    });

    it('compares against the last SUCCESSFUL run on main, so a regression never becomes the reference', () => {
        const ref = step(audit, 'reference').run ?? '';
        expect(ref).toMatch(/gh run list[^\n]*--workflow mobile-audit\.yml/);
        expect(ref).toMatch(/--branch main/);
        expect(ref).toMatch(/--status success/);
        expect(audit.permissions?.actions).toBe('read');
        const run = step(audit, 'audit').run ?? '';
        expect(run).toMatch(/npm run -s mobile:audit/);
        expect(run).toMatch(/--compare "\$REFERENCE"/);
        expect(step(audit, 'audit').env?.REFERENCE).toBe('${{ steps.reference.outputs.file }}');
    });

    it('publishes summary.md and the comparison as an artifact, even on a red night', () => {
        const upload = audit.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
        expect(upload?.if).toBe('always()');
        expect(upload?.with?.name).toBe('mobile-audit');
        // The directory the harness writes summary.md, metrics.json and comparison.md to.
        expect(upload?.with?.path).toBe('mobile-audit/');
        expect(step(audit, 'audit').run).toMatch(/--out mobile-audit\b/);
    });

    it('tells a count that rose apart from a run that could not observe anything', () => {
        expect(audit.outputs?.rose).toBe('${{ steps.verdict.outputs.rose }}');
        expect(step(audit, 'verdict').run).toMatch(/\.regressions \| length/);
    });

    it('opens or updates ONE issue per kind of failure when the audit fails or is cancelled', () => {
        expect([notify.needs].flat()).toEqual(['audit']);
        expect(notify.if).toBe('${{ failure() || cancelled() }}');
        expect(notify.permissions?.issues).toBe('write');
        const script = String(notify.steps.find((s) => s.uses?.startsWith('actions/github-script@'))?.with?.script ?? '');
        expect(script).toMatch(/labels: 'mobile-audit'/);
        expect(script).toMatch(/issues\.createComment/);
        expect(script).toMatch(/issues\.create\(/);
        expect(script).toMatch(/comparison\.md/);
    });
});
