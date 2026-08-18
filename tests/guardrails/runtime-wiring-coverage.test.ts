/**
 * Runtime-wiring FORWARD-LOCK (extends H1).
 *
 * Code that exists but is never reached in production is the silent-failure
 * class H1 fixed: the integration provider registry started empty because no
 * runtime entrypoint imported the side-effecting bootstrap, so the automation
 * engine no-op'd and the integrations UI rendered nothing — even though every
 * provider existed. This ratchet locks two wiring invariants:
 *
 *   (1) BOOTSTRAP REACHABILITY — every provider registered in
 *       integrations/bootstrap.ts is reachable from a runtime entrypoint: the
 *       web tier (instrumentation.ts) AND the worker (scripts/worker.ts) both
 *       import the bootstrap module, and the import actually populates the
 *       registry.
 *
 *   (2) JOB SCHEDULING — every job registered in executor-registry.ts is
 *       either scheduled in schedules.ts OR explicitly listed as on-demand
 *       (dispatched by another job, an API route, or an admin action) with a
 *       reason. A NEW executor job that is neither scheduled nor marked
 *       on-demand fails CI — catching a cron that was written but never wired.
 *
 * See docs/new-subsystem-checklist.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import '@/app-layer/integrations/bootstrap';
import { registry } from '@/app-layer/integrations/registry';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Executor jobs that run on-demand rather than on a cron — dispatched by a
 * scheduled fan-out job, an API route, or an admin action. Each carries a
 * reason. A new executor job must be scheduled OR added here deliberately.
 */
const ON_DEMAND_JOBS: Readonly<Record<string, string>> = {
    // The per-tenant half of the calendar push. Deliberately NOT scheduled:
    // JOB_DEFAULTS is inert for cron-fired jobs (registerSchedules passes no
    // opts, so BullMQ falls back to the queue default of 3 exponential
    // attempts), and this job talks to Google / Graph. Arriving via enqueue()
    // is the only way its attempts:1 actually applies.
    'calendar-push-tenant': 'dispatched by calendar-push-dispatch',
    // These three said 'dispatched by automation-runner' and nothing checked
    // it. It was false: automation-runner resolves a control's automationKey
    // and calls the PROVIDER's runCheck — it never enqueues these job names.
    // Nothing did. They sat here, exempted by a plausible sentence, while the
    // rolling-evidence collectors behind them were unreachable. The
    // `dispatched by` assertion below now verifies the claim.
    'aws-posture-collect': 'per-connection collect dispatched by cloud-posture-collect-dispatch',
    'azure-posture-collect': 'per-connection collect dispatched by cloud-posture-collect-dispatch',
    'gcp-posture-collect': 'per-connection collect dispatched by cloud-posture-collect-dispatch',
    'control-test-runner': 'per-plan run dispatched by control-test-scheduler',
    'identity-sync': 'per-connection sync dispatched by identity-sync-dispatch',
    'hris-sync': 'per-connection sync dispatched by hris-sync-dispatch',
    'sharepoint-delta-sync': 'per-connection sync dispatched by sharepoint-delta-sync-dispatch',
    'sharepoint-policy-pull': 'on-demand policy pull from an admin action',
    'sync-pull': 'per-connection pull dispatched by a sync-dispatch job',
    'compliance-posture-summary': 'per-tenant summary dispatched by compliance-posture-summary-dispatch',
    'automation-event-dispatch': 'automation engine internal event fan-out',
    'rule-chain-dispatch': 'automation engine internal rule-chain fan-out',
    'subflow-dispatch': 'automation engine internal sub-flow fan-out',
    'key-rotation': 'admin-triggered master-KEK rotation sweep (API)',
    'tenant-dek-rotation': 'admin-triggered per-tenant DEK rotation sweep (API)',
    'evidence-import': 'user-triggered evidence import from a connected source',
    'vendor-renewal-check': 'on-demand vendor renewal check',
    'health-check': 'liveness probe / on-demand diagnostic',
    'deadline-monitor': 'on-demand deadline recompute (superseded on cron by incident-notification-deadlines)',
    'evidence-expiry-monitor': 'on-demand expiry recompute (superseded on cron by daily-evidence-expiry)',
};

function registeredExecutorJobs(): string[] {
    const src = read('src/app-layer/jobs/executor-registry.ts');
    return [...src.matchAll(/executorRegistry\.register\('([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
}

function scheduledJobs(): string[] {
    const src = read('src/app-layer/jobs/schedules.ts');
    return [...src.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
}

function bootstrapProviders(): string[] {
    const src = read('src/app-layer/integrations/bootstrap.ts');
    // Only non-commented registrations.
    return src
        .split('\n')
        .filter((l) => /^\s*registry\.register\(new \w+Provider\(\)\)/.test(l))
        .map((l) => l.match(/new (\w+)Provider/)![1])
        .sort();
}

describe('Runtime wiring forward-lock', () => {
    describe('(1) bootstrap reachability', () => {
        it('the web instrumentation imports the integration bootstrap at startup', () => {
            expect(read('src/instrumentation.ts')).toMatch(/integrations\/bootstrap/);
        });

        it('the BullMQ worker imports the integration bootstrap at startup', () => {
            expect(read('scripts/worker.ts')).toMatch(/integrations\/bootstrap/);
        });

        it('importing the bootstrap actually populates the provider registry', () => {
            // bootstrap is imported at the top of this file (side effect).
            expect(registry.listProviders().length).toBeGreaterThanOrEqual(bootstrapProviders().length);
        });
    });

    describe('(2) every executor job is scheduled or explicitly on-demand', () => {
        const executors = registeredExecutorJobs();
        const scheduled = new Set(scheduledJobs());

        it('sanity — executors + schedules parsed', () => {
            expect(executors.length).toBeGreaterThan(20);
            expect(scheduled.size).toBeGreaterThan(10);
        });

        it('no executor job is unwired — new jobs must be scheduled or marked on-demand', () => {
            const unwired = executors.filter((j) => !scheduled.has(j) && !(j in ON_DEMAND_JOBS));
            // A new cron written in executor-registry.ts but never added to
            // schedules.ts (and not dispatched on-demand) trips this.
            expect(unwired).toEqual([]);
        });

        it('no scheduled job lacks an executor (dangling schedule)', () => {
            const execSet = new Set(executors);
            const dangling = [...scheduled].filter((j) => !execSet.has(j));
            expect(dangling).toEqual([]);
        });

        /**
         * The escape hatch used to accept prose, and prose is how three jobs
         * stayed exempt while being reachable by nothing at all: their reason
         * named `automation-runner`, which dispatches providers per control
         * and never enqueues a job by these names.
         *
         * A reason of the form "... dispatched by <name>" is a CHECKABLE
         * claim, so check it: some file must actually enqueue this job. That
         * converts the hatch from a place to write a sentence into a place to
         * state a fact.
         */
        it('every "dispatched by" reason names a real enqueue site', () => {
            // Scoped to app-layer, which is where every `enqueue(...)` lives.
            const walk = (dir: string, out: string[] = []): string[] => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, e.name);
                    if (e.isDirectory()) walk(p, out);
                    else if (p.endsWith('.ts')) out.push(p);
                }
                return out;
            };
            // Only files that actually enqueue something can vouch for a job.
            // Requiring the NAME to appear in such a file — rather than
            // anywhere in the tree — is what keeps this from degrading into
            // the hole it replaced: a file must not be able to satisfy the
            // check by merely mentioning the job in a comment or a type.
            const dispatchers = walk(path.join(ROOT, 'src/app-layer'))
                .map((f) => fs.readFileSync(f, 'utf8'))
                .filter((src) => /\benqueue\(/.test(src));

            const unenqueued: string[] = [];
            for (const [job, reason] of Object.entries(ON_DEMAND_JOBS)) {
                if (!/dispatched by/i.test(reason)) continue;
                // Either a literal `enqueue('<job>')`, or the name quoted in a
                // file that enqueues — the latter covers a map-driven
                // dispatcher (`enqueue(JOB_BY_PROVIDER[p], …)`), which is a
                // real enqueue site that a literal-only match would reject.
                const named = new RegExp(`['"\`]${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
                if (!dispatchers.some((src) => named.test(src))) {
                    unenqueued.push(`${job} — reason claims "${reason}"`);
                }
            }

            expect({ unenqueued }).toEqual({ unenqueued: [] });
        });

        it('no stale on-demand entries — every listed job still has an executor', () => {
            const execSet = new Set(executors);
            const stale = Object.keys(ON_DEMAND_JOBS).filter((j) => !execSet.has(j));
            expect(stale).toEqual([]);
        });
    });
});
