/**
 * A migration must not mix a BARE `ALTER TYPE ... ADD VALUE` with other DDL.
 *
 * ## The incident this comes from (#2746, outage #2745)
 *
 * `20260920120000_agent_proposal_run_provenance` started 2026-09-20 21:27:54
 * and never finished. `entrypoint.sh` runs `prisma migrate deploy` on every
 * container start; Prisma refuses to proceed past a failed migration (P3009),
 * the container exits, Docker restarts it. Production was down ~25 hours.
 *
 * **That file is in the grandfathered list below.** This guard is not
 * reasoning about a hypothetical — it is the detector for the exact shape that
 * caused the outage, and a test at the bottom pins that it still sees it.
 *
 * ## Why BARE, and why `IF NOT EXISTS` is the fix
 *
 * Postgres commits an enum addition in a way that does not roll back with the
 * surrounding transaction, and Prisma wraps a migration in one. When a later
 * statement fails, the enum values are already permanent while the rest is not.
 *
 * That alone would be survivable. What made it unrecoverable is the RE-RUN:
 * `migrate resolve --rolled-back` re-runs the migration from the top, and
 *
 *     ALTER TYPE "WorkflowStepKind" ADD VALUE 'MODEL_CALL';
 *
 * against an enum that already contains `MODEL_CALL` **fails**, putting the
 * app straight back into the loop. The repo's own April precedent
 * (`20260422180000_enable_rls_coverage`, resolved `--rolled-back`) was safe
 * only because nothing there had actually applied.
 *
 *     ALTER TYPE "WorkflowStepKind" ADD VALUE IF NOT EXISTS 'MODEL_CALL';
 *
 * is idempotent, so the re-run survives. This repo already writes it that way
 * 57 times against 24 bare ones — the habit exists, it is just not enforced.
 *
 * So the rule is not "never add an enum value alongside DDL". It is: if you
 * do, make the addition re-runnable. Splitting it into its own migration is
 * the other valid answer, because then a partial failure lands on a BOUNDARY
 * where `--applied` and `--rolled-back` mean what they say.
 *
 * ## Why the detector does not anchor on `^ALTER TYPE`
 *
 * `20260707140000_access_review_connected` wraps its addition in
 * `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`. An
 * anchored match misses it completely, which would let anyone reintroduce the
 * hazard by wrapping it in a DO block. The scan is therefore over the whole
 * file, comments stripped. (That file is NOT an offender: the exception
 * handler makes it re-runnable, which is the property being asked for.)
 *
 * ## Why this is a ratchet
 *
 * Nine migrations already carry the shape. They are APPLIED in production, and
 * editing an applied migration changes its checksum — which breaks
 * `migrate deploy` on every environment that has already run it. They are
 * grandfathered by name, permanently. The list must never grow.
 *
 * @module guardrails/migration-enum-isolation
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/** FROZEN. Adding a name here is how the next 25-hour outage gets written. */
const GRANDFATHERED: ReadonlySet<string> = new Set([
    '20260309115528_audit_workflow_extensions',
    '20260313100032_add_test_run_snapshot_and_evidence_hash',
    '20260505151340_epic_g3_questionnaire_schema',
    '20260505154537_epic_g3_send_followup',
    '20260520183000_task_due_notifications',
    '20260627130000_org_threat_level',
    '20260627140000_org_maturity_rating',
    '20260627150000_org_security_initiative',
    '20260920120000_agent_proposal_run_provenance',
]);

/** `--` comments stripped, so prose describing DDL is never read as DDL. */
function ddlOf(sql: string): string {
    return sql.replace(/--[^\n]*/g, '');
}

/** Every enum addition in the file; `idempotent` is the `IF NOT EXISTS` form. */
function enumAdditions(ddl: string): { idempotent: boolean }[] {
    const re = /ALTER\s+TYPE\s+"?\w+"?\s+ADD\s+VALUE(\s+IF\s+NOT\s+EXISTS)?/gi;
    const out: { idempotent: boolean }[] = [];
    for (const m of ddl.matchAll(re)) out.push({ idempotent: Boolean(m[1]) });
    return out;
}

/** Does the file carry DDL other than the enum additions themselves? */
function hasOtherDdl(ddl: string): boolean {
    const rest = ddl.replace(/ALTER\s+TYPE\s+"?\w+"?\s+ADD\s+VALUE[^;]*;/gi, '');
    return /\b(CREATE|ALTER\s+TABLE|DROP|INSERT|UPDATE)\b/i.test(rest);
}

function offenders(): string[] {
    if (!fs.existsSync(MIGRATIONS)) return [];
    const out: string[] = [];
    for (const name of fs.readdirSync(MIGRATIONS).sort()) {
        const file = path.join(MIGRATIONS, name, 'migration.sql');
        if (!fs.existsSync(file)) continue;
        const ddl = ddlOf(fs.readFileSync(file, 'utf-8'));
        const adds = enumAdditions(ddl);
        if (!adds.some((a) => !a.idempotent)) continue;
        if (hasOtherDdl(ddl)) out.push(name);
    }
    return out;
}

describe('migrations — a bare enum addition is never mixed with other DDL', () => {
    it('no NEW migration carries the shape', () => {
        expect(offenders().filter((n) => !GRANDFATHERED.has(n))).toEqual([]);
    });

    it('no grandfathered entry is stale', () => {
        // Two-sided. An exemption protecting nothing hides the next real one.
        const actual = new Set(offenders());
        expect([...GRANDFATHERED].filter((n) => !actual.has(n))).toEqual([]);
    });

    it('the migration that took production down is still detected', () => {
        // The positive control that matters: a detector nobody has watched fire
        // on a real example is a detector nobody should trust.
        expect(offenders()).toContain('20260920120000_agent_proposal_run_provenance');
    });

    describe('detector proof — on synthetic SQL, so a clean run means something', () => {
        it('flags a BARE addition beside other DDL', () => {
            const ddl = ddlOf(`ALTER TYPE "K" ADD VALUE 'X';\nALTER TABLE "T" ADD COLUMN "c" TEXT;`);
            expect(enumAdditions(ddl).some((a) => !a.idempotent)).toBe(true);
            expect(hasOtherDdl(ddl)).toBe(true);
        });

        it('does NOT flag the IF NOT EXISTS form — that is the fix', () => {
            const ddl = ddlOf(
                `ALTER TYPE "K" ADD VALUE IF NOT EXISTS 'X';\nALTER TABLE "T" ADD COLUMN "c" TEXT;`,
            );
            expect(enumAdditions(ddl).some((a) => !a.idempotent)).toBe(false);
        });

        it('does NOT flag an enum-only migration — the other valid answer', () => {
            const ddl = ddlOf(`ALTER TYPE "K" ADD VALUE 'A';\nALTER TYPE "K" ADD VALUE 'B';`);
            expect(hasOtherDdl(ddl)).toBe(false);
        });

        it('SEES an addition wrapped in a DO block, which an anchored match misses', () => {
            const ddl = ddlOf(
                `DO $$ BEGIN\n  ALTER TYPE "K" ADD VALUE 'X';\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;`,
            );
            expect(enumAdditions(ddl).length).toBe(1);
        });

        it('is not satisfied by a COMMENT that merely describes the shape', () => {
            const ddl = ddlOf(`-- ALTER TYPE "K" ADD VALUE 'X';\nALTER TABLE "T" ADD COLUMN "c" TEXT;`);
            expect(enumAdditions(ddl).length).toBe(0);
        });
    });
});
