/**
 * Epic OI-3 — backup + restore validation ratchet.
 *
 * Locks:
 *   - Managed RDS PITR posture is verified at the IaC layer
 *     (backup_retention_days >= 7 in production tfvars; the variable's
 *     validation already disallows 0 — checked separately by the
 *     terraform ratchets, but we re-assert here so an OI-3 reviewer
 *     can confirm the backup story end-to-end without leaving this
 *     test file).
 *   - infra/scripts/restore-test.sh exists, is executable, has the
 *     load-bearing properties: cleanup trap that runs on EXIT/INT/TERM,
 *     `--skip-final-snapshot --delete-automated-backups` on the
 *     teardown call, no public accessibility, multi-AZ off (cost),
 *     deletion-protection off (cleanup must always succeed),
 *     unique timestamped name (collision-proof), psql validation
 *     covers schema + recent rows + RLS policies.
 *   - infra/scripts/pg-dump-to-s3.sh exists for the self-hosted
 *     fallback, gzip-compressed dumps, optional GPG encryption,
 *     30-day retention referenced in the doc.
 *   - .github/workflows/restore-test.yml schedules monthly via cron,
 *     uses OIDC, gated by the production GitHub Environment.
 *   - .github/workflows/restore-test.yml carries a notifier job that
 *     turns a failed drill into something a human is subscribed to.
 *     That last group exists because the drill failed on every
 *     scheduled attempt from 2026-05-01 onward and nobody noticed: a
 *     red scheduled run is not a notification. It locks the four
 *     properties that make the notifier actually fire and actually
 *     reach someone — (1) it depends on EVERY job a schedule can
 *     start, so it cannot be skipped into silence; (2) its condition
 *     is `failure() || cancelled()`, because a cancelled job's result
 *     is 'cancelled' and `failure()` alone would miss a
 *     timeout-cancelled restore; (3) it declares job-level
 *     `issues: write`, which REPLACES rather than merges with the
 *     workflow-level permissions block; (4) it creates an issue or
 *     COMMENTS on the open one, never a bare `issues.update` — editing
 *     an issue body sends no notification of any kind — and its dedupe
 *     lookup passes `per_page: 100` on a narrow label rather than
 *     relying on the 30-item default page.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const stat = (rel: string) => fs.statSync(path.join(ROOT, rel));

describe('OI-3 — managed RDS PITR (Terraform-verified)', () => {
    const DB_VARS = 'infra/terraform/modules/database/variables.tf';

    it('backup_retention_days variable validation refuses 0 (PITR mandatory)', () => {
        const src = read(DB_VARS);
        // The validation block must enforce >= 1
        expect(src).toMatch(/var\.backup_retention_days\s*>=\s*1/);
    });

    it('production tfvars sets db_backup_retention_days >= 7', () => {
        const src = read('infra/terraform/environments/production/terraform.tfvars');
        const m = src.match(/db_backup_retention_days\s*=\s*(\d+)/);
        expect(m).toBeTruthy();
        expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(7);
    });

    it('storage_encrypted is hardcoded true on the DB instance (snapshots inherit)', () => {
        const src = read('infra/terraform/modules/database/main.tf');
        // The DB's at-rest encryption flows into automated snapshots.
        // Confirmed by the OI-1 part 2 ratchet; re-asserted here so an
        // OI-3 reviewer sees the backup story is end-to-end encrypted.
        expect(src).toMatch(/storage_encrypted\s*=\s*true/);
    });
});

describe('OI-3 — restore-test.sh shape', () => {
    const SCRIPT = 'infra/scripts/restore-test.sh';

    it('exists and is executable', () => {
        expect(exists(SCRIPT)).toBe(true);
        // owner-execute bit set (octal 0o100)

        expect((stat(SCRIPT).mode & 0o100) !== 0).toBe(true);
    });

    it('uses bash strict mode (set -euo pipefail)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/^set\s+-euo\s+pipefail/m);
    });

    it('registers a cleanup trap on EXIT/INT/TERM (no orphaned RDS instances)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/trap\s+cleanup\s+EXIT\s+INT\s+TERM/);
    });

    it('teardown uses --skip-final-snapshot AND --delete-automated-backups', () => {
        const src = read(SCRIPT);
        // --skip-final-snapshot: PITR window is the canonical recovery surface
        // --delete-automated-backups: avoids leaking test backups into cost
        expect(src).toMatch(/--skip-final-snapshot/);
        expect(src).toMatch(/--delete-automated-backups/);
    });

    it('restored instance is NOT publicly accessible', () => {
        const src = read(SCRIPT);
        // Hardcoded --no-publicly-accessible on the restore command.
        // The chart's DB module enforces this on the source; the test
        // instance must inherit the same posture.
        expect(src).toMatch(/--no-publicly-accessible/);
    });

    it('restored instance has --no-multi-az --no-deletion-protection (test = cheap + tearable)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/--no-multi-az/);
        expect(src).toMatch(/--no-deletion-protection/);
    });

    it('uses a TIMESTAMPED unique instance identifier (collision-proof under concurrent runs)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/TIMESTAMP="?\$\(date.*Y.*m.*d.*H.*M.*S\)"?/);
        expect(src).toMatch(/RESTORE_INSTANCE_ID=.*\$\{?TIMESTAMP\}?/);
    });

    it('finds the LATEST snapshot via sort_by + last index, snapshot-type defaulting to automated', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/describe-db-snapshots/);
        // The snapshot type is parameterized (--snapshot-type flag) so the
        // quarterly cross-region DR job can target `manual` (DR copies are
        // manual snapshots); it still DEFAULTS to `automated` for the
        // same-region monthly run.
        expect(src).toMatch(/SNAPSHOT_TYPE="automated"/);
        expect(src).toMatch(/--snapshot-type\s+"\$SNAPSHOT_TYPE"/);
        // Sort by snapshot create time + take the last → newest
        expect(src).toMatch(/sort_by\(DBSnapshots,\s*&SnapshotCreateTime\)\s*\|\s*\[-1\]/);
    });

    it('waits for the restored instance to become available before validating', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/aws rds wait db-instance-available/);
    });

    it('validates schema + recent rows + RLS policies via psql', () => {
        const src = read(SCRIPT);
        // Schema reachability
        expect(src).toMatch(/SELECT 1/);
        // Tables (the bash heredoc-style queries quote table names with \"...\")
        expect(src).toMatch(/Tenant table reachable/);
        expect(src).toMatch(/User table reachable/);
        // Recent activity (catches "snapshot is empty" / very-old failures)
        expect(src).toMatch(/AuditLog/);
        expect(src).toMatch(/INTERVAL\s+'14 days'/);
        // RLS policies survived the restore
        expect(src).toMatch(/pg_policies/);
        expect(src).toMatch(/tenant_isolation/);
        // app_user role exists (RLS depends on it)
        expect(src).toMatch(/pg_roles.*app_user/);
        // Migrations are applied
        expect(src).toMatch(/_prisma_migrations/);
    });

    it('reads the source DB password from Secrets Manager (no plaintext credentials in env)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/aws secretsmanager get-secret-value/);
        expect(src).toMatch(/DB_PASSWORD_SECRET_ID/);
    });

    it('forces TLS on the validation connection (sslmode=require)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/sslmode=require/);
    });
});

describe('OI-3 — pg-dump-to-s3.sh fallback', () => {
    const SCRIPT = 'infra/scripts/pg-dump-to-s3.sh';

    it('exists and is executable', () => {
        expect(exists(SCRIPT)).toBe(true);

        expect((stat(SCRIPT).mode & 0o100) !== 0).toBe(true);
    });

    it('uses bash strict mode + cleanup trap', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/^set\s+-euo\s+pipefail/m);
        expect(src).toMatch(/trap\s+'.*rm.*\$TMPDIR.*'\s+EXIT/);
    });

    it('uses pg_dump --format=custom --compress=9 (compact, restorable)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/--format=custom/);
        expect(src).toMatch(/--compress=9/);
    });

    it('supports optional GPG encryption layered on top of S3 SSE', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/GPG_RECIPIENT/);
        // gpg invocation spans lines via backslash continuation; assert
        // both the gpg call and --encrypt flag are present (likely on
        // different lines).
        expect(src).toMatch(/gpg\b/);
        expect(src).toMatch(/--encrypt/);
    });

    it('uploads to a versioned S3 path (timestamped key)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/aws s3 cp/);
        expect(src).toMatch(/\$\{?TIMESTAMP\}?/);
    });

    it('verifies upload via head-object (catches silent S3 failures)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/aws s3api head-object/);
    });

    it('aborts on suspiciously small dump (caught early; do not upload garbage)', () => {
        const src = read(SCRIPT);
        // The script uses bash arithmetic: `[ "$DUMP_SIZE_BYTES" -lt 1024 ]`
        expect(src).toMatch(/DUMP_SIZE_BYTES.*-lt\s+1024/);
    });

    it('documents 30-day retention via S3 lifecycle (per OI-3 source-of-truth)', () => {
        const src = read(SCRIPT);
        expect(src).toMatch(/30-day retention/);
        expect(src).toMatch(/S3 lifecycle/);
    });
});

describe('OI-3 — restore-test.yml workflow scheduling', () => {
    const WORKFLOW = '.github/workflows/restore-test.yml';

    interface Workflow {
        on?: Record<string, unknown>;
        true?: Record<string, unknown>; // YAML 1.1 'on' becomes 'true'
        jobs: Record<string, {
            'runs-on'?: string | string[];
            environment?: string;
            steps?: unknown[];
            permissions?: Record<string, string>;
        }>;
    }

    function load(): Workflow {
        return yaml.load(read(WORKFLOW)) as Workflow;
    }

    it('exists and parses as YAML', () => {
        expect(exists(WORKFLOW)).toBe(true);
        expect(() => load()).not.toThrow();
    });

    it('triggers on schedule (cron) AND workflow_dispatch (manual override)', () => {
        const wf = load();
        const triggers = (wf.on ?? wf.true) as Record<string, unknown>;
        expect(triggers.schedule).toBeDefined();
        expect(triggers.workflow_dispatch).toBeDefined();
    });

    it('cron fires monthly (1st of every month)', () => {
        const src = read(WORKFLOW);
        // Day-of-month = 1, month = *
        expect(src).toMatch(/cron:\s*["']\d+\s+\d+\s+1\s+\*\s+\*["']/);
    });

    it('uses OIDC (id-token: write)', () => {
        const wf = load();
        // Top-level permissions
        const perms = (wf as unknown as { permissions?: Record<string, string> }).permissions;
        expect(perms?.['id-token']).toBe('write');
    });

    it('binds to the production GitHub Environment (gates AWS access)', () => {
        const wf = load();
        const job = wf.jobs['restore-test'];
        expect(job).toBeDefined();
        expect(job.environment).toBe('production');
    });

    it('uses aws-actions/configure-aws-credentials@v6', () => {
        expect(read(WORKFLOW)).toMatch(/aws-actions\/configure-aws-credentials@v6/);
    });

    it('invokes infra/scripts/restore-test.sh with the required env vars', () => {
        const src = read(WORKFLOW);
        expect(src).toMatch(/\.\/infra\/scripts\/restore-test\.sh/);
        // Ensure the workflow forwards the script's required inputs
        for (const required of [
            'AWS_REGION',
            'SOURCE_DB_INSTANCE_ID',
            'RESTORE_VPC_SECURITY_GROUP_IDS',
            'RESTORE_DB_SUBNET_GROUP',
            'DB_PASSWORD_SECRET_ID',
        ]) {
            expect(src).toMatch(new RegExp(`${required}:`));
        }
    });

    it('has a concurrency group (prevents overlapping monthly runs)', () => {
        const src = read(WORKFLOW);
        // YAML allows blank lines + comments between `concurrency:` and
        // its `group:`; match more permissively.
        expect(src).toMatch(/concurrency:[\s\S]*?group:\s*restore-test/);
        expect(src).toMatch(/cancel-in-progress:\s*false/);
    });

    it('emits a workflow summary with run link + failure remediation hint', () => {
        const src = read(WORKFLOW);
        expect(src).toMatch(/GITHUB_STEP_SUMMARY/);
        expect(src).toMatch(/restore-test/);
        expect(src).toMatch(/orphaned/);
    });
});


describe('OI-3 — a failed restore drill NOTIFIES someone', () => {
    const WORKFLOW = '.github/workflows/restore-test.yml';

    interface Job {
        needs?: string[];
        if?: string;
        permissions?: Record<string, string>;
        steps?: { uses?: string; if?: string; with?: { script?: string } }[];
    }

    const jobs = (): Record<string, Job> =>
        (yaml.load(read(WORKFLOW)) as { jobs: Record<string, Job> }).jobs;

    const notifier = (): Job => {
        const j = jobs()['notify-on-failure'];
        // Asserted rather than optional-chained: if the job is deleted,
        // every check below would otherwise pass vacuously on undefined.
        expect(j).toBeDefined();
        return j as Job;
    };

    const scriptStep = () => {
        const step = (notifier().steps ?? []).find((s) => s.uses?.startsWith('actions/github-script'));
        expect(step).toBeDefined();
        return step!;
    };

    /**
     * The script with whole-line `//` comments removed.
     *
     * Load-bearing, and the reason is the defect this whole group exists to
     * catch. `with.script` is raw text, so a comment SAYING `per_page: 100`
     * satisfies a regex looking for `per_page: 100` — the assertion passes
     * while the call it describes has neither the argument nor the pagination.
     * Stripping a line whose first non-space characters are `//` leaves
     * `https://` and any `//` inside a string untouched, which is all the
     * precision this needs.
     */
    const script = (): string =>
        scriptStep()
            .with!.script!.split('\n')
            .filter((line) => !/^\s*\/\//.test(line))
            .join('\n');

    /** The argument object of the dedupe lookup, so an assertion cannot match prose elsewhere. */
    const lookupArgs = (): string => {
        const s = script();
        const at = s.indexOf('listForRepo(');
        expect(at).toBeGreaterThan(-1);
        const close = s.indexOf('})', at);
        expect(close).toBeGreaterThan(at);
        return s.slice(at, close);
    };

    it('a notifier job exists and depends on EVERY job a schedule can start', () => {
        // Derived, not hardcoded: a third restore job added later must be
        // added to `needs` too, or it can fail into silence.
        const startable = Object.keys(jobs()).filter((id) => id !== 'notify-on-failure');
        expect(startable.length).toBeGreaterThan(0);
        expect([...(notifier().needs ?? [])].sort()).toEqual([...startable].sort());
    });

    it('fires on cancellation as well as failure', () => {
        // A cancelled job's result is 'cancelled', NOT 'failure', so
        // `failure()` alone goes silent on a timeout-cancelled restore —
        // the 90-minute timeout makes that a realistic outcome here.
        const cond = notifier().if ?? '';
        expect(cond).toMatch(/failure\(\)/);
        expect(cond).toMatch(/cancelled\(\)/);
        // It must NOT be narrowed to a trigger a schedule cannot satisfy.
        // Gating the restore jobs to workflow_dispatch and hanging this off
        // them means that on the monthly cron the needed jobs never run,
        // failure() is false, and the notifier is unreachable on the only
        // trigger that fires by itself.
        expect(cond).not.toMatch(/workflow_dispatch/);
    });

    it('declares issues: write at JOB level (job permissions REPLACE the workflow block)', () => {
        // The workflow-level block grants contents+id-token and NOT issues,
        // and a job-level block overrides it wholesale rather than merging.
        expect(notifier().permissions?.issues).toBe('write');
    });

    it('notifies every time — creates an issue, or COMMENTS on the open one', () => {
        const s = script();
        expect(s).toMatch(/issues\.create\(/);
        expect(s).toMatch(/issues\.createComment\(/);
        // `issues.update` on an existing issue produces NO notification —
        // not email, not web, not mobile. A monthly job that only edits a
        // body is silent from the second month onward while the run
        // reports success.
        expect(s).not.toMatch(/issues\.update\(/);
    });

    it('the dedupe lookup cannot silently miss (per_page + a narrow label)', () => {
        // Asserted against the sliced `listForRepo({...})` ARGUMENTS, not the
        // whole script: matching anywhere would let a `const LABEL = ...`
        // declaration and a comment mentioning per_page satisfy this while the
        // call itself is bare. Both were demonstrated to pass a whole-script
        // version of this test with the arguments stripped out.
        const args = lookupArgs();
        // listForRepo defaults to 30 items of page one; the tracking issue
        // scrolling off it makes the lookup find nothing and open a
        // duplicate every month until people mute the notifications.
        expect(args).toMatch(/per_page:\s*100/);

        // A narrow label, not the generic 'automated' bucket other scheduled
        // jobs also write into. The argument is an identifier, so resolve it
        // to its literal rather than asserting the identifier's NAME — a check
        // for `labels: LABEL` would pass after someone repointed LABEL at
        // 'automated', which is the whole failure being guarded against.
        const bound = args.match(/labels:\s*([A-Za-z_$][\w$]*|\[?\s*'[^']+'\s*\]?)/);
        expect(bound).not.toBeNull();
        let label = bound![1];
        if (/^[A-Za-z_$]/.test(label)) {
            const decl = script().match(new RegExp(`const\\s+${label}\\s*=\\s*'([^']+)'`));
            expect(decl).not.toBeNull();
            label = decl![1];
        } else {
            label = label.replace(/[[\]'\s]/g, '');
        }
        expect(label).toBe('restore-drill');
    });

    it('the notifier STEP is unconditional — a job-level `if` is not the only way to make it inert', () => {
        // The job condition is asserted above, but a single `if:` on the
        // github-script step makes the job run, do nothing, and report
        // SUCCESS — indistinguishable from a healthy month. That is the same
        // never-fires shape the job-level assertion exists to prevent, one
        // level down, and the previous attempt at this change shipped exactly
        // that shape at job level.
        expect(scriptStep().if).toBeUndefined();
    });
});
