/**
 * #5595 — a DSAR erasure REFUSES UP FRONT when the subject is referenced from
 * an immutable audit table, instead of failing part-way while `planErasure`
 * reported it would succeed.
 *
 * THE DEFECT
 * ──────────
 * `OrgAuditLog.actorUserId` / `targetUserId` were `ON DELETE SET NULL` into a
 * table whose trigger refuses EVERY UPDATE (and whose chain hashes both
 * columns). Seven more SET NULL references into `User` sat on recorded
 * decisions whose pair CHECK or one-way trigger refuses a NULL actor once the
 * row is stamped. `planErasure` counted a SET NULL edge as non-blocking, so it
 * reported `wouldSucceed: true`; `eraseUser` then failed on the trigger or the
 * CHECK, an error it did not recognise as a reference refusal.
 *
 * THE DECISION (owner, 2026-11-14): refuse up front. Those nine FKs are
 * `ON DELETE RESTRICT` (migration
 * 20261114140000_dsar_erasure_audit_references_restrict), `planErasure` lists
 * them as blockers with a named reason, and `eraseUser` refuses before it
 * writes anything. The audit chain and its triggers are untouched.
 *
 * WHY EVERY REFUSAL HAS A CONTROL BESIDE IT
 * ─────────────────────────────────────────
 * "Nothing was written" is satisfied just as well by a run that never reached
 * the database. So the same file erases a subject with NO audit reference and
 * requires the erasure to happen, through the same path, on the same client.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { hashForLookup } from '@/lib/security/encryption';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { eraseUser, planErasure } from '@/app-layer/jobs/dsar-erasure';
import { ERASURE_EXECUTED_ACTION } from '@/lib/audit/erasure-record';
import {
    deleteAuditRowsForTenants,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * The nine references the migration moved to RESTRICT, written out here
 * rather than imported: this file pins the DATABASE, and a list it shared with
 * the code under test would agree with that code by construction.
 */
const RESTRICTED_FKS = [
    'OrgAuditLog_actorUserId_fkey',
    'OrgAuditLog_targetUserId_fkey',
    'AccessReviewConnectedDecision_decidedByUserId_fkey',
    'AccessReviewDecision_decidedByUserId_fkey',
    'AccessReviewDecision_executedByUserId_fkey',
    'ControlException_approvedByUserId_fkey',
    'ControlException_rejectedByUserId_fkey',
    'RiskTreatmentPlan_completedByUserId_fkey',
    'TreatmentMilestone_completedByUserId_fkey',
] as const;

const SUFFIX = randomUUID().slice(0, 8);
const TENANT = `t-erase-ref-${SUFFIX}`;
const ORG_SLUG = `org-erase-ref-${SUFFIX}`;
/** Named as the TARGET of an org audit row, and the actor of a tenant audit row. */
const USER_TARGET = `u-erase-target-${SUFFIX}`;
/** Named as the ACTOR of the same org audit row. */
const USER_ACTOR = `u-erase-actor-${SUFFIX}`;
/** The control: a tenant audit row, no org audit reference. */
const USER_FREE = `u-erase-free-${SUFFIX}`;
const AUDIT_TARGET = `a-erase-target-${SUFFIX}`;
const AUDIT_FREE = `a-erase-free-${SUFFIX}`;

describeFn('#5595 — DSAR erasure refuses a subject the immutable audit tables reference', () => {
    let prisma: PrismaClient;
    let organizationId: string;
    let orgAuditRowId: string;

    async function mkUser(id: string) {
        const email = `${id}@example.test`;
        await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
    }

    async function mkAuditRow(id: string, userId: string) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "AuditLog" ("id","tenantId","userId","entity","entityId","action","details","createdAt")
             VALUES ($1,$2,$3,'Control','ctrl-1','CONTROL_CREATED','erasure reference fixture', now())`,
            id, TENANT, userId,
        );
    }

    async function auditAttributionOf(id: string): Promise<string | null> {
        const rows = await prisma.$queryRawUnsafe<Array<{ userId: string | null }>>(
            `SELECT "userId" FROM "AuditLog" WHERE "id" = $1`, id,
        );
        return rows[0]?.userId ?? null;
    }

    async function orgAuditRow() {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ actorUserId: string | null; targetUserId: string | null; entryHash: string }>
        >(
            `SELECT "actorUserId", "targetUserId", "entryHash" FROM "OrgAuditLog" WHERE "id" = $1`,
            orgAuditRowId,
        );
        return rows[0] ?? null;
    }

    async function erasureRecordCount(): Promise<number> {
        const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "AuditLog" WHERE "tenantId" = $1 AND "action" = $2`,
            TENANT, ERASURE_EXECUTED_ACTION,
        );
        return Number(rows[0]?.n ?? 0);
    }

    async function userExists(id: string): Promise<boolean> {
        return (await prisma.user.findUnique({ where: { id } })) !== null;
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const org = await prisma.organization.create({ data: { name: ORG_SLUG, slug: ORG_SLUG } });
        organizationId = org.id;

        await mkUser(USER_TARGET);
        await mkUser(USER_ACTOR);
        await mkUser(USER_FREE);
        await mkAuditRow(AUDIT_TARGET, USER_TARGET);
        await mkAuditRow(AUDIT_FREE, USER_FREE);

        // Through the sanctioned writer, so the row is a real chain entry
        // whose hash covers both user columns.
        const entry = await appendOrgAuditEntry(
            {
                organizationId,
                actorUserId: USER_ACTOR,
                action: 'ORG_MEMBER_ADDED',
                targetUserId: USER_TARGET,
                detailsJson: { role: 'ORG_READER' },
            },
            prisma,
        );
        orgAuditRowId = entry.id;
    });

    afterAll(async () => {
        if (TENANT) {
            await deleteAuditRowsForTenants(prisma, TENANT);
            if (organizationId) await deleteOrgAuditRowsForOrganizations(prisma, organizationId);
            await prisma.organization.deleteMany({ where: { slug: ORG_SLUG } });
            await prisma.tenant.deleteMany({ where: { id: TENANT } });
            await prisma.user.deleteMany({ where: { id: { in: [USER_TARGET, USER_ACTOR, USER_FREE] } } });
        }
    });

    it('the nine references are ON DELETE RESTRICT in the database', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ conname: string; confdeltype: string }>>(
            `SELECT conname, confdeltype::text AS confdeltype
               FROM pg_constraint
              WHERE contype = 'f' AND conname = ANY($1::text[])`,
            [...RESTRICTED_FKS],
        );
        // Every one is present (a renamed constraint would otherwise drop out
        // of this assertion silently) and every one is RESTRICT.
        expect(rows.map((r) => r.conname).sort()).toEqual([...RESTRICTED_FKS].sort());
        expect(rows.filter((r) => r.confdeltype !== 'r')).toEqual([]);
    });

    it('seeds references that are actually visible (denominator)', async () => {
        await expect(auditAttributionOf(AUDIT_TARGET)).resolves.toBe(USER_TARGET);
        await expect(orgAuditRow()).resolves.toMatchObject({
            actorUserId: USER_ACTOR,
            targetUserId: USER_TARGET,
        });
    });

    it('planErasure lists the org audit TARGET reference as a blocker, with a named reason', async () => {
        const plan = await planErasure(USER_TARGET, { db: prisma });
        expect(plan.wouldSucceed).toBe(false);
        expect(plan.blockers).toEqual([
            expect.objectContaining({
                table: 'OrgAuditLog',
                column: 'targetUserId',
                onDelete: 'RESTRICT',
                rows: 1,
                effect: 'BLOCKS_DELETE',
                reason: 'IMMUTABLE_AUDIT_TRAIL',
            }),
        ]);
        expect(plan.writes).toBe(0);
    });

    it('planErasure lists the org audit ACTOR reference as a blocker too', async () => {
        const plan = await planErasure(USER_ACTOR, { db: prisma });
        expect(plan.wouldSucceed).toBe(false);
        expect(plan.blockers.map((b) => `${b.table}.${b.column}:${b.reason}`)).toEqual([
            'OrgAuditLog.actorUserId:IMMUTABLE_AUDIT_TRAIL',
        ]);
    });

    it('eraseUser refuses with a typed error naming the blocker', async () => {
        await expect(eraseUser(USER_TARGET)).rejects.toMatchObject({
            name: 'ErasureBlockedError',
            code: 'CONFLICT',
            blockers: [expect.objectContaining({ table: 'OrgAuditLog', column: 'targetUserId' })],
        });
    });

    it('…and wrote NOTHING: subject, audit attribution, org audit row and erasure records all as they were', async () => {
        expect(await userExists(USER_TARGET)).toBe(true);
        // The pseudonymization never ran. Had it run and rolled back, this
        // would read the same — the next assertion is what tells them apart.
        await expect(auditAttributionOf(AUDIT_TARGET)).resolves.toBe(USER_TARGET);
        await expect(erasureRecordCount()).resolves.toBe(0);
        await expect(orgAuditRow()).resolves.toMatchObject({
            actorUserId: USER_ACTOR,
            targetUserId: USER_TARGET,
        });
    });

    it('the database refuses the delete itself, as an FK refusal — not the audit trigger', async () => {
        // The backstop for a writer that bypasses eraseUser. Under SET NULL this
        // was IMMUTABLE_ORG_AUDIT_LOG from the trigger, mid-cascade; RESTRICT
        // answers before any referencing row is touched.
        let message = '';
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, USER_ACTOR);
            });
        } catch (e) {
            message = String(e instanceof Error ? e.message : e);
        }
        expect(message).toMatch(/OrgAuditLog_actorUserId_fkey/);
        expect(message).not.toMatch(/IMMUTABLE_ORG_AUDIT_LOG/);
        expect(await userExists(USER_ACTOR)).toBe(true);
    });

    it('POSITIVE CONTROL — a subject with no audit-table reference still plans clear and erases', async () => {
        const plan = await planErasure(USER_FREE, { db: prisma });
        expect(plan.blockers).toEqual([]);
        expect(plan.wouldSucceed).toBe(true);
        expect(plan.auditRowsToPseudonymize).toBe(1);

        const receipt = await eraseUser(USER_FREE);
        expect(receipt.userDeleted).toBe(true);
        expect(receipt.auditRowsPseudonymized).toBe(1);
        expect(await userExists(USER_FREE)).toBe(false);
        await expect(auditAttributionOf(AUDIT_FREE)).resolves.toBeNull();
        await expect(erasureRecordCount()).resolves.toBe(1);
    });
});
