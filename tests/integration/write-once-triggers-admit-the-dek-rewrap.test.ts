/**
 * Every write-once trigger on an encrypted column must admit the key-rotation
 * sweeps' re-wrap (#5065).
 *
 * `tenant-dek-rotation` and the master-KEK sweep rewrite every manifest
 * ciphertext with a RAW `UPDATE "<model>" SET "<field>" = $1 WHERE id = $2`,
 * and count a throw as an error. The sweep clears
 * `Tenant.previousEncryptedDek` only on `totalErrors === 0`, and
 * `rotateTenantDek`'s atomic swap is predicated on that column being NULL. So
 * a trigger that refuses the re-wrap does not merely refuse one row:
 *
 *   1. `previousEncryptedDek` is never cleared, so the OLD — possibly
 *      compromised — DEK stays live in the decrypt fallback for good;
 *   2. those rows stay under the old key; and
 *   3. every later rotation is refused ("concurrent rotation detected"), and
 *      the sweep that would clear the block can never complete.
 *
 * A tenant holding ONE such row can never rotate its DEK again — and a DEK
 * rotation is what an OWNER reaches for on a suspected key compromise.
 *
 * `AgentHarnessAcceptance.justification` and `AuditWorkpaperNarrative.text`
 * are both in the Epic B manifest and neither trigger carried the exception:
 * the first froze the column for every role as one term of its identity
 * check, the second refused every UPDATE outright.
 *
 * ─── Why this is asserted at the TRIGGER, not through the whole sweep ──────
 *
 * `a2a-peer-messaging.test.ts` runs the real `rotateTenantDek` +
 * `runTenantDekRotation` and asserts `{ errors: 0, cleared: true }`, which is
 * the stronger end-to-end shape — but it only covers models that suite already
 * seeds. This file asserts the property these two triggers own, with the exact
 * statement the sweep issues, so it fails for the reason it names rather than
 * for a fixture that drifted.
 *
 * ─── A note for the next table ─────────────────────────────────────────────
 *
 * Do NOT turn this into a scan that greps every trigger for one spelling of
 * the exception. Two siblings look broken to such a scan and are not:
 * `tenant_a2a_signing_key_is_final` spells it inline (`AND NOT (OLD."x" ~
 * '^v[12]:' AND NEW."x" ~ '^v2:')`) rather than with the `to_jsonb`
 * subtraction, and `tenant_skill_version_lifecycle` gates its refusal on
 * `current_setting('role') = 'app_user'`, which the sweep is not. A column-
 * scoped `BEFORE UPDATE OF "a","b"` trigger is a third false positive: it
 * never fires when only the encrypted column is SET.
 */
import type { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'rewrap-probe-tenant';
const USER_EMAIL = 'rewrap-probe@example.test';
let userId = '';

/** A v2 envelope, the shape the sweep reads and writes. */
const V2_OLD = 'v2:aaaaaaaaaaaaaaaaaaaaaaaa';
const V2_NEW = 'v2:bbbbbbbbbbbbbbbbbbbbbbbb';
const V1_OLD = 'v1:cccccccccccccccccccccccc';

/** The EXACT statement `tenant-dek-rotation` issues for every manifest field. */
const sweepUpdate = (model: string, field: string, value: string, id: string) =>
    prisma.$executeRawUnsafe(`UPDATE "${model}" SET "${field}" = $1 WHERE id = $2`, value, id);

async function cleanup() {
    await resetDatabase(prisma);
    await prisma.$transaction(async (tx) => {
        // Triggers off for teardown only: these tables are write-once and
        // several refuse DELETE to app_user, and a probe row must not outlive
        // its run.
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditWorkpaperNarrative" WHERE "tenantId" = $1`, T);
        await tx.$executeRawUnsafe(`DELETE FROM "AgentHarnessAcceptance" WHERE "tenantId" = $1`, T);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditWorkpaper" WHERE "tenantId" = $1`, T);
        await tx.$executeRawUnsafe(`DELETE FROM "DiscoveredAgent" WHERE "tenantId" = $1`, T);
    });
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.user.deleteMany({ where: { email: USER_EMAIL } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const u = await prisma.user.create({ data: { email: USER_EMAIL, name: 'rewrap probe' } });
    userId = u.id;
});

afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

/**
 * Seeds one row per table with `session_replication_role = 'replica'`, which
 * suppresses the FK checks and the INSERT guards. That is deliberate: this
 * file is about the UPDATE triggers, and building each table's full legitimate
 * parent graph would make the fixture, not the trigger, the thing under test.
 * The role is reset before every assertion below, so the UPDATE path runs with
 * every trigger live.
 */
let seedSeq = 0;
async function seed(col: string): Promise<{ acceptanceId: string; narrativeId: string }> {
    // Unique per CALL, not per value: several tests seed the same ciphertext,
    // and ids derived from it collided on the primary key.
    const n = ++seedSeq;
    const acceptanceId = `acc-probe-${n}`;
    const narrativeId = `nar-probe-${n}`;
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `INSERT INTO "AgentHarnessAcceptance"
               ("id","tenantId","discoveredAgentId","acceptedLevel","justification",
                "acceptedByUserId","expiresAt","createdAt","updatedAt")
             VALUES ($1,$2,$5,'H1',$3,$4,NOW() + INTERVAL '30 days',NOW(),NOW())`,
            acceptanceId, T, col, userId, `da-probe-${n}`,
        );
        await tx.$executeRawUnsafe(
            `INSERT INTO "AuditWorkpaperNarrative"
               ("id","tenantId","workpaperId","runId","text","createdAt")
             VALUES ($1,$2,$4,$5,$3,NOW())`,
            narrativeId, T, col, `wp-probe-${n}`, `run-probe-${n}`,
        );
    });
    return { acceptanceId, narrativeId };
}

describe('the sweep re-wrap is admitted', () => {
    it.each([
        ['AgentHarnessAcceptance', 'justification'],
        ['AuditWorkpaperNarrative', 'text'],
    ])('%s.%s accepts a v2 -> v2 re-wrap', async (model, field) => {
        const ids = await seed(V2_OLD);
        const id = model === 'AgentHarnessAcceptance' ? ids.acceptanceId : ids.narrativeId;
        await expect(sweepUpdate(model, field, V2_NEW, id)).resolves.toBe(1);
        const row = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
            `SELECT "${field}" AS v FROM "${model}" WHERE id = $1`, id,
        );
        expect(row[0].v).toBe(V2_NEW);
    });

    it.each([
        ['AgentHarnessAcceptance', 'justification'],
        ['AuditWorkpaperNarrative', 'text'],
    ])('%s.%s accepts a v1 -> v2 re-wrap, which is the master-KEK sweep', async (model, field) => {
        const ids = await seed(V1_OLD);
        const id = model === 'AgentHarnessAcceptance' ? ids.acceptanceId : ids.narrativeId;
        await expect(sweepUpdate(model, field, V2_NEW, id)).resolves.toBe(1);
    });
});

describe('and nothing else is', () => {
    it.each([
        ['AgentHarnessAcceptance', 'justification'],
        ['AuditWorkpaperNarrative', 'text'],
    ])('%s.%s still refuses a PLAINTEXT write', async (model, field) => {
        const ids = await seed(V2_OLD);
        const id = model === 'AgentHarnessAcceptance' ? ids.acceptanceId : ids.narrativeId;
        // Not a ciphertext, so not a re-wrap — this is the edit the trigger
        // exists to refuse, and widening the exception would admit it.
        await expect(sweepUpdate(model, field, 'rewritten by hand', id)).rejects.toThrow();
    });

    it.each([
        ['AgentHarnessAcceptance', 'justification'],
        ['AuditWorkpaperNarrative', 'text'],
    ])('%s.%s refuses a re-wrap that ALSO changes another column', async (model, field) => {
        const ids = await seed(V2_OLD);
        const id = model === 'AgentHarnessAcceptance' ? ids.acceptanceId : ids.narrativeId;
        const other = model === 'AgentHarnessAcceptance' ? 'acceptedLevel' : 'runId';
        const otherValue = model === 'AgentHarnessAcceptance' ? 'H2' : 'run-tampered';
        await expect(prisma.$executeRawUnsafe(
            `UPDATE "${model}" SET "${field}" = $1, "${other}" = $2 WHERE id = $3`,
            V2_NEW, otherValue, id,
        )).rejects.toThrow();
    });

    it('the acceptance still refuses reinstating a revoked row', async () => {
        const { acceptanceId } = await seed(V2_OLD);
        await prisma.$executeRawUnsafe(
            `UPDATE "AgentHarnessAcceptance" SET "revokedAt" = NOW(), "revokedByUserId" = $1 WHERE id = $2`,
            userId, acceptanceId,
        );
        await expect(prisma.$executeRawUnsafe(
            `UPDATE "AgentHarnessAcceptance" SET "revokedAt" = NULL, "revokedByUserId" = NULL WHERE id = $1`,
            acceptanceId,
        )).rejects.toThrow(/stays revoked/);
    });
});

describe('the definition carries it, which is the part a quiet row cannot show', () => {
    it('both functions admit a v1/v2 -> v2 re-wrap of their encrypted column', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ proname: string; prosrc: string }>>(
            `SELECT proname, prosrc FROM pg_proc
              WHERE proname IN ('agent_harness_acceptance_one_way','audit_workpaper_narrative_write_once')
                AND pronamespace = 'public'::regnamespace
              ORDER BY proname`,
        );
        expect(rows.map((r) => r.proname)).toEqual([
            'agent_harness_acceptance_one_way', 'audit_workpaper_narrative_write_once',
        ]);
        // The migration's own DO block checks this at APPLY time and never
        // again; a later CREATE OR REPLACE that dropped the clause would pass
        // it. This is what keeps failing afterwards.
        for (const r of rows) {
            expect(r.prosrc).toContain('to_jsonb(NEW)');
            expect(r.prosrc).toContain("^v[12]:");
            expect(r.prosrc).toContain("^v2:");
        }
    });

    it('and both triggers are still attached BEFORE UPDATE', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string; tbl: string }>>(
            `SELECT t.tgname, c.relname AS tbl
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE NOT t.tgisinternal
                AND c.relname IN ('AgentHarnessAcceptance','AuditWorkpaperNarrative')
                AND t.tgname IN ('agent_harness_acceptance_one_way','audit_workpaper_narrative_write_once_trg')`,
        );
        // An exception inside a function nothing calls protects nothing.
        expect(rows).toHaveLength(2);
    });
});
