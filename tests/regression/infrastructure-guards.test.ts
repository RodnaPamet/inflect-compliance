/**
 * Infrastructure Regression Guards
 *
 * Validates that all Epic 15 hardening guarantees hold:
 *   1. Production defaults are explicit (no silent fallback)
 *   2. Storage defaults to S3
 *   3. AV scanning defaults to strict
 *   4. Job contract types are complete
 *   5. Download gate blocks infected/pending files
 *
 * These tests run WITHOUT live infrastructure (no Redis, no S3, no ClamAV).
 * They validate code-level guarantees only.
 */
import { execSync } from 'child_process';
import path from 'path';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { QUEUE_NAME, JOB_DEFAULTS, SCHEDULED_JOBS } from '../helpers/job-imports';

// ─── Re-export helpers to avoid path alias issues in Jest ───
// We use relative imports from src/ directly

/**
 * Boot the REAL env schema in a subprocess and read back what it resolved.
 *
 * Two in-process routes were tried first and neither observes the schema:
 *   • `import { env } from '@/env'` resolves to `tests/mocks/env.ts` via
 *     `moduleNameMapper` — a Proxy with its own hardcoded fallbacks. It
 *     answers `AV_SCAN_MODE` with 'strict' whatever `src/env.ts` says, so a
 *     test against it passes even if the schema default were deleted.
 *   • `require('../../src/env')` throws "Cannot use import statement outside a
 *     module" — `@t3-oss/env-nextjs` is ESM and untransformed, which is the
 *     reason that mock exists at all.
 * Spawning is the honest option, and `tests/unit/env.test.ts` already uses
 * exactly this harness.
 */
const ENV_SCRIPT = path.resolve(__dirname, '../../scripts/print-env-ok.ts');

/** Everything `src/env.ts` requires, so validation reaches the defaults. */
const VALID_ENV: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:password@localhost:5432/db',
    NEXTAUTH_URL: 'http://localhost:3000',
    AUTH_URL: 'http://localhost:3000',
    AUTH_SECRET: 'supersecretstringthatis16charplus', // pragma: allowlist secret — test fixture (mirrors REPO_BASELINE in tests/guardrails/no-secrets.test.ts)
    JWT_SECRET: 'supersecretstringthatis16charplus', // pragma: allowlist secret — test fixture (mirrors REPO_BASELINE)
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: 'ms-client-id',
    MICROSOFT_CLIENT_SECRET: 'ms-secret',
};

interface ResolvedEnv {
    STORAGE_PROVIDER?: string;
    AV_SCAN_MODE?: string;
    UPLOAD_DIR?: string;
}

function resolveEnvSchema(overrides: Record<string, string | undefined>): ResolvedEnv {
    const childEnv: Record<string, string | undefined> = {
        ...process.env,
        ...VALID_ENV,
        ...overrides,
        // Empty string is falsy for `!!process.env.SKIP_ENV_VALIDATION`, so
        // this turns validation back ON inside the child.
        SKIP_ENV_VALIDATION: '',
    };
    for (const key of Object.keys(childEnv)) {
        if (childEnv[key] === undefined) delete childEnv[key];
    }

    const output = execSync(`npx tsx ${ENV_SCRIPT}`, {
        env: childEnv as NodeJS.ProcessEnv,
        encoding: 'utf-8',
        stdio: 'pipe',
    });
    const line = output.split('\n').find((l) => l.startsWith('RESOLVED '));
    if (!line) throw new Error(`env script printed no RESOLVED line:\n${output}`);
    return JSON.parse(line.slice('RESOLVED '.length)) as ResolvedEnv;
}

/**
 * The scheduled-job set, sorted — the SINGLE SOURCE OF TRUTH for both
 * assertions below. The count is DERIVED from this list
 * (`.length`), never written as a literal.
 *
 * Why: a literal count and the enumeration it counts lived in different
 * files (`src/app-layer/jobs/schedules.ts` and this one). Two branches
 * each adding a job both write the same new number, git merges them
 * WITHOUT CONFLICT, and main then asserts N while reality is N+1 — both
 * PRs green, no suspicious diff. The clean merge is the dangerous case,
 * so deriving is the fix; "review it more carefully" is not.
 *
 * This count is BOOKKEEPING, not a claim about the domain: nothing says
 * the platform should have exactly this many jobs, and the name-set
 * assertion already carries everything the number did. Contrast with a
 * closed VOCABULARY size (e.g. `MATURITY_LEVELS` has five levels), which
 * stays a literal precisely so that growing it cannot pass silently.
 *
 * Adding a job: append its name here, in sort order, with a one-line
 * note on what it does. The length assertion follows automatically.
 */
const EXPECTED_SCHEDULED_JOB_NAMES: readonly string[] = [
    // Audit Coherence S7 — daily admin escalation when
    // an access-review campaign is severely past its
    // dueAt and decisions remain pending.
    'access-review-overdue-escalation',
    // Epic G-4 — daily reviewer reminder for access review
    // campaigns approaching their dueAt.
    'access-review-reminder',
    'automation-runner',
    // C-roadmap — cross-tenant fan-out for the per-user calendar
    // push. The child (calendar-push-tenant) is enqueued, not
    // scheduled, so only the dispatcher appears here.
    'calendar-push-dispatch',
    // The fan-out the three *-posture-collect executors never
    // had — they were registered and enqueued by nothing, so the
    // rolling-evidence collectors behind them were unreachable.
    'cloud-posture-collect-dispatch',
    'compliance-digest',
    // AI compliance-posture hero — daily cross-tenant fan-out
    // enqueuing a per-tenant posture-summary generation.
    'compliance-posture-summary-dispatch',
    'compliance-snapshot',
    // Epic G-2 — every-5-min repeatable scanning
    // ControlTestPlan and enqueuing runner jobs.
    'control-test-scheduler',
    'daily-evidence-expiry',
    'data-lifecycle',
    // Business-KPI — every-5-min cross-tenant DAU/MAU
    // aggregation refreshing the active-user gauge snapshot.
    'dau-mau-aggregator',
    // Epic G-5 — daily 30/14/7-day expiry reminder for
    // control exceptions.
    // Audit Coherence S3 — daily flip of APPROVED evidence past its
    // nextReviewDate to NEEDS_REVIEW, 30 min before notification-dispatch
    // so the owner hears the same morning.
    'evidence-stale-review-sweep',
    'exception-expiry-monitor',
    // PR-4 — daily cross-tenant fan-out: an hris-sync per enabled
    // BambooHR connection.
    'hris-sync-dispatch',
    // PR-2 — daily cross-tenant fan-out: an identity-sync per
    // enabled Okta / Google Workspace connection.
    // Daily leaver pass fan-out, one per (tenant, writable directory
    // provider). Clamped at DRY_RUN — it decides, it does not write.
    'identity-leaver-dispatch',
    'identity-sync-dispatch',
    // NIS2 Article 23 — hourly deadline clock flipping
    // incident notification deadlines PENDING→DUE→OVERDUE.
    'incident-notification-deadlines',
    'notification-dispatch',
    // Vuln integration — daily NVD CVE catalog ingestion +
    // cross-tenant asset-match pass.
    'nvd-cve-sync',
    // Business-KPI — daily sweep emitting business.onboarding.abandoned
    // for tenants idle ≥7 days on an onboarding step.
    'onboarding-abandonment-sweep',
    'policy-review-reminder',
    // RQ-10 — daily cross-tenant scheduled-report delivery.
    'report-delivery',
    'retention-sweep',
    // RQ-2 — daily cross-tenant risk-appetite breach monitor.
    'risk-appetite-monitor',
    // RQ-9 — daily cross-tenant risk + portfolio snapshot.
    'risk-snapshot',
    // PR-E — daily sweep firing SCHEDULE automation rules whose
    // target entity is N days from its due date.
    'schedule-trigger-sweep',
    // SP-3 — every-4-hour fan-out: a delta sync per enabled
    // SharePoint connection (auto-import changed evidence files).
    'sharepoint-delta-sync-dispatch',
    // SP-4 — daily renewal of policy Graph change subscriptions.
    'sharepoint-subscription-renew',
    // Automation Epic 5 — every-5-min SLA breach sweep over
    // RUNNING automation executions.
    'sla-monitor',
    // In-app TASK_DUE notifications fired one week, one
    // day, and on the day a task's dueAt falls.
    'task-due-notification',
    // Continuous vendor monitoring — daily posture sweep
    // (breach / attestation-expiry / TLS) + reassessment reminder.
    'vendor-monitoring',
];

describe('Infrastructure Regression Guards', () => {

    // ═══════════════════════════════════════════════════════════════
    // 1. Production Defaults
    // ═══════════════════════════════════════════════════════════════

    describe('Production Defaults', () => {
        // Both of these tests were `expect(true).toBe(true)` with a comment
        // reading "Schema-level — validated at build time". Nothing about a
        // Jest assertion is validated at build time, and one of them was cited
        // in review as the protection for the strict AV default — a default
        // whose absence makes every PENDING (i.e. never actually scanned) file
        // downloadable. They now boot the schema and read the value back.
        const ABSENT = { STORAGE_PROVIDER: undefined, AV_SCAN_MODE: undefined };
        const SENTINEL_UPLOAD_DIR = '/tmp/env-default-probe';
        let resolved: ResolvedEnv;

        beforeAll(() => {
            resolved = resolveEnvSchema({ ...ABSENT, UPLOAD_DIR: SENTINEL_UPLOAD_DIR });
        }, 120_000);

        test('the probe reflects the environment it was given (not a constant)', () => {
            // Without this, a harness that silently returned `{}` would make
            // both assertions below fail loudly rather than pass vacuously —
            // and if the defaults ever changed to match a stale hardcoding,
            // this is what says the reading is live.
            expect(resolved.UPLOAD_DIR).toBe(SENTINEL_UPLOAD_DIR);
        });

        test('STORAGE_PROVIDER resolves to s3 when the variable is absent', () => {
            expect(resolved.STORAGE_PROVIDER).toBe('s3');
        });

        test('AV_SCAN_MODE resolves to strict when the variable is absent', () => {
            expect(resolved.AV_SCAN_MODE).toBe('strict');
        });

        test('an explicit value still wins over the default', () => {
            const explicit = resolveEnvSchema({
                STORAGE_PROVIDER: 'local',
                AV_SCAN_MODE: 'permissive',
            });
            expect(explicit.STORAGE_PROVIDER).toBe('local');
            expect(explicit.AV_SCAN_MODE).toBe('permissive');
        }, 120_000);
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. Job Contract Completeness
    // ═══════════════════════════════════════════════════════════════

    describe('Job Contract Completeness', () => {
        test('all scheduled jobs have matching JOB_DEFAULTS', () => {
            for (const schedule of SCHEDULED_JOBS) {
                expect(JOB_DEFAULTS).toHaveProperty(schedule.name);
            }
        });

        test('all JOB_DEFAULTS have required fields', () => {
            for (const [_name, defaults] of Object.entries(JOB_DEFAULTS)) {
                expect(defaults).toHaveProperty('attempts');
                expect(defaults).toHaveProperty('backoff');
                expect(defaults).toHaveProperty('removeOnComplete');
                expect(defaults).toHaveProperty('removeOnFail');
                expect(typeof defaults.attempts).toBe('number');
                expect(defaults.attempts).toBeGreaterThan(0);
                expect(defaults.backoff).toHaveProperty('type');
                expect(defaults.backoff).toHaveProperty('delay');
            }
        });

        test('QUEUE_NAME is defined and non-empty', () => {
            expect(QUEUE_NAME).toBeTruthy();
            expect(typeof QUEUE_NAME).toBe('string');
        });

        test('all scheduled jobs have valid cron patterns', () => {
            for (const schedule of SCHEDULED_JOBS) {
                const parts = schedule.pattern.split(' ');
                expect(parts.length).toBeGreaterThanOrEqual(5);
                expect(parts.length).toBeLessThanOrEqual(6);
                expect(schedule.description).toBeTruthy();
            }
        });

        // The derivation is only as trustworthy as the list it derives from:
        // a duplicated name would inflate `.length` (and hide a genuinely
        // double-registered repeatable job), and an out-of-sort-order append
        // turns the name-set failure below into an unreadable diff.
        test('the expected-name list is sorted and duplicate-free', () => {
            expect(new Set(EXPECTED_SCHEDULED_JOB_NAMES).size).toBe(
                EXPECTED_SCHEDULED_JOB_NAMES.length,
            );
            expect([...EXPECTED_SCHEDULED_JOB_NAMES].sort()).toEqual(
                EXPECTED_SCHEDULED_JOB_NAMES,
            );
        });

        test('SCHEDULED_JOBS holds exactly the expected set of jobs', () => {
            // Derived, not a literal — see EXPECTED_SCHEDULED_JOB_NAMES.
            expect(SCHEDULED_JOBS).toHaveLength(
                EXPECTED_SCHEDULED_JOB_NAMES.length,
            );
        });

        test('scheduled job names match expected set', () => {
            const names = SCHEDULED_JOBS.map(s => s.name).sort();
            expect(names).toEqual(EXPECTED_SCHEDULED_JOB_NAMES);
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 3. AV Download Gate
    // ═══════════════════════════════════════════════════════════════

    describe('AV Download Gate', () => {
        // This was `expect(true).toBe(true)` under a comment that both
        // described the invariant WRONGLY ("returns false for INFECTED in ALL
        // modes except disabled" — disabled is precisely the mode where that
        // must still hold) and deferred enforcement to another file. It now
        // calls the predicate.
        const MODES = ['strict', 'permissive', 'disabled', undefined] as const;

        test.each(MODES)('INFECTED is refused with AV_SCAN_MODE=%s', (mode) => {
            const previous = process.env.AV_SCAN_MODE;
            try {
                if (mode === undefined) delete process.env.AV_SCAN_MODE;
                else process.env.AV_SCAN_MODE = mode;
                expect(isDownloadAllowed('INFECTED')).toBe(false);
            } finally {
                if (previous === undefined) delete process.env.AV_SCAN_MODE;
                else process.env.AV_SCAN_MODE = previous;
            }
        });

        test('strict mode refuses an unscanned (PENDING / absent) file', () => {
            // The other half of "defaults to strict": the default only buys
            // anything if strict actually blocks the never-scanned state, which
            // is where every FileRecord sits until a scanner writes a verdict.
            const previous = process.env.AV_SCAN_MODE;
            process.env.AV_SCAN_MODE = 'strict';
            try {
                expect(isDownloadAllowed('PENDING')).toBe(false);
                expect(isDownloadAllowed(undefined)).toBe(false);
                expect(isDownloadAllowed(null)).toBe(false);
                expect(isDownloadAllowed('CLEAN')).toBe(true);
            } finally {
                if (previous === undefined) delete process.env.AV_SCAN_MODE;
                else process.env.AV_SCAN_MODE = previous;
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // 4. No In-Process Cron Remaining
    // ═══════════════════════════════════════════════════════════════

    describe('No In-Process Cron', () => {
        test('no node-cron dependency exists', () => {
            // Verify node-cron is not in package.json
            const pkg = require('../../package.json');
            expect(pkg.dependencies?.['node-cron']).toBeUndefined();
            expect(pkg.devDependencies?.['node-cron']).toBeUndefined();
        });

        test('BullMQ is a production dependency', () => {
            const pkg = require('../../package.json');
            expect(pkg.dependencies?.['bullmq']).toBeDefined();
        });

        test('ioredis is a production dependency', () => {
            const pkg = require('../../package.json');
            expect(pkg.dependencies?.['ioredis']).toBeDefined();
        });
    });
});
