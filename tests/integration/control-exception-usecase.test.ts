/**
 * Epic G-5 — usecase-layer integration tests.
 *
 * Coverage
 * --------
 *   1. requestException creates a REQUESTED row + emits audit + binds
 *      compensating control. Self-compensating (control == compensating)
 *      rejected at parse time.
 *   2. Non-existent / cross-tenant control id rejected at request.
 *   3. Permission gate — assertCanWrite required to request.
 *   4. approveException requires expiresAt in the future and only
 *      acts on REQUESTED rows; double-approve rejected.
 *   5. Approval gate — admin-only.
 *   6. rejectException records reason; only acts on REQUESTED.
 *   7. Invalid lifecycle transitions rejected (approve a REJECTED;
 *      reject an APPROVED).
 *   8. renewException creates a NEW row with renewedFromId pointing
 *      at the prior; defaults inherit; prior row is untouched.
 *   9. Renewal of a REJECTED row blocked.
 *  10. getExpiringExceptions filters by tenant + window + status.
 *  11. Audit chain — request → approve → renew creates the right
 *      action sequence.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    requestException,
    approveException,
    rejectException,
    renewException,
    getExpiringExceptions,
    listControlExceptions,
    getControlException,
} from '@/app-layer/usecases/control-exception';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g5u-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const FOREIGN_TENANT_ID = `t-${SUITE_TAG}-other`;

let admin: { userId: string };
let approver: { userId: string };
let editor: { userId: string };
let reader: { userId: string };
let foreignAdmin: { userId: string };
let CONTROL_ID = '';
let COMPENSATING_CONTROL_ID = '';
let FOREIGN_CONTROL_ID = '';

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    await globalPrisma.tenant.upsert({
        where: { id: FOREIGN_TENANT_ID },
        update: {},
        create: {
            id: FOREIGN_TENANT_ID,
            name: `t ${SUITE_TAG} other`,
            slug: `${SUITE_TAG}-other`,
        },
    });
    admin = await makeUser('admin');
    approver = await makeUser('approver2');
    editor = await makeUser('editor');
    reader = await makeUser('reader');
    foreignAdmin = await makeUser('foreign');
    await globalPrisma.tenantMembership.createMany({
        data: [
            {
                tenantId: TENANT_ID,
                userId: admin.userId,
                role: Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
            {
                tenantId: TENANT_ID,
                userId: approver.userId,
                role: Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
            {
                tenantId: TENANT_ID,
                userId: editor.userId,
                role: Role.EDITOR,
                status: MembershipStatus.ACTIVE,
            },
            {
                tenantId: TENANT_ID,
                userId: reader.userId,
                role: Role.READER,
                status: MembershipStatus.ACTIVE,
            },
            {
                tenantId: FOREIGN_TENANT_ID,
                userId: foreignAdmin.userId,
                role: Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
        ],
    });
    const ctrl = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'Affected control' },
    });
    CONTROL_ID = ctrl.id;
    const comp = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'Compensating control' },
    });
    COMPENSATING_CONTROL_ID = comp.id;
    const foreign = await globalPrisma.control.create({
        data: { tenantId: FOREIGN_TENANT_ID, name: 'Foreign control' },
    });
    FOREIGN_CONTROL_ID = foreign.id;
}

async function teardown() {
    const tenantIds = [TENANT_ID, FOREIGN_TENANT_ID];
    await globalPrisma.controlException.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.control.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            `SET LOCAL session_replication_role = 'replica'`,
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            tenantIds,
        );
    });
    const userIds = [admin, approver, editor, reader, foreignAdmin]
        .filter(Boolean)
        .map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

function ctxAs(role: Role, userId: string, tenantId = TENANT_ID) {
    return makeRequestContext(role, { userId, tenantId });
}

const futureDate = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000);

describeFn('Epic G-5 — control exception usecases', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.controlException.deleteMany({
            where: { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } },
        });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `SET LOCAL session_replication_role = 'replica'`,
            );
            await tx.$executeRawUnsafe(
                `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                TENANT_ID,
            );
        });
    });

    // ── 1. requestException happy path ─────────────────────────────

    it('requestException creates a REQUESTED row + emits audit + links compensating', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'legacy database cannot enforce X',
                compensatingControlId: COMPENSATING_CONTROL_ID,
                riskAcceptedByUserId: admin.userId,
            },
        );
        const ex = await getControlException(
            ctxAs(Role.ADMIN, admin.userId),
            exceptionId,
        );
        expect(ex.status).toBe('REQUESTED');
        expect(ex.controlId).toBe(CONTROL_ID);
        expect(ex.compensatingControlId).toBe(COMPENSATING_CONTROL_ID);
        expect(ex.justification).toBe('legacy database cannot enforce X');
        expect(ex.approvedAt).toBeNull();
        expect(ex.rejectedAt).toBeNull();

        const audit = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, action: 'CONTROL_EXCEPTION_REQUESTED' },
        });
        expect(audit).toHaveLength(1);
    });

    it('requestException rejects self-compensating (control === compensating)', async () => {
        await expect(
            requestException(ctxAs(Role.ADMIN, admin.userId), {
                controlId: CONTROL_ID,
                compensatingControlId: CONTROL_ID,
                justification: 'self',
                riskAcceptedByUserId: admin.userId,
            }),
        ).rejects.toThrow(/cannot compensate for itself/i);
    });

    // ── 2. Cross-tenant control rejected ───────────────────────────

    it('requestException rejects a control id that lives in another tenant', async () => {
        await expect(
            requestException(ctxAs(Role.ADMIN, admin.userId), {
                controlId: FOREIGN_CONTROL_ID,
                justification: 'cross-tenant claim',
                riskAcceptedByUserId: admin.userId,
            }),
        ).rejects.toThrow(/Control not found/i);
    });

    // ── 3. Permission gate on request ──────────────────────────────

    it('requestException requires write permission', async () => {
        await expect(
            requestException(ctxAs(Role.READER, reader.userId), {
                controlId: CONTROL_ID,
                justification: 'reader',
                riskAcceptedByUserId: admin.userId,
            }),
        ).rejects.toThrow(/permission/i);
    });

    // ── 4. approveException happy path + invariants ────────────────

    it('approveException sets status=APPROVED + approver triple + records audit', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'to approve',
                riskAcceptedByUserId: admin.userId,
            },
        );
        const expiry = futureDate(90);
        const result = await approveException(
            ctxAs(Role.ADMIN, approver.userId),
            exceptionId,
            { expiresAt: expiry },
        );
        expect(result.expiresAt.getTime()).toBe(expiry.getTime());
        const ex = await getControlException(
            ctxAs(Role.ADMIN, admin.userId),
            exceptionId,
        );
        expect(ex.status).toBe('APPROVED');
        expect(ex.approvedAt).toBeInstanceOf(Date);
        expect(ex.approvedBy?.id).toBe(approver.userId);
        expect(ex.expiresAt?.getTime()).toBe(expiry.getTime());
    });

    it('approveException rejects expiresAt in the past', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'past expiry',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await expect(
            approveException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
                expiresAt: new Date(Date.now() - 1000),
            }),
        ).rejects.toThrow(/in the future/i);
    });

    it('approveException rejects double-approve', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'first approval',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            expiresAt: futureDate(30),
        });
        await expect(
            approveException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
                expiresAt: futureDate(60),
            }),
        ).rejects.toThrow(/only REQUESTED rows can be approved/i);
    });

    it('approveException is admin-only', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'editor approve',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await expect(
            approveException(ctxAs(Role.EDITOR, editor.userId), exceptionId, {
                expiresAt: futureDate(30),
            }),
        ).rejects.toThrow(/permission/i);
    });

    // ── 4b. Separation of duties — requester cannot self-approve/reject ─

    it('approveException blocks self-approval by the requester (separation of duties)', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'self-approve attempt',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await expect(
            approveException(ctxAs(Role.ADMIN, admin.userId), exceptionId, {
                expiresAt: futureDate(30),
            }),
        ).rejects.toThrow(/your own exception request/i);
    });

    it('rejectException blocks self-rejection by the requester (separation of duties)', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'self-reject attempt',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await expect(
            rejectException(ctxAs(Role.ADMIN, admin.userId), exceptionId, {
                reason: 'self reject',
            }),
        ).rejects.toThrow(/your own exception request/i);
    });

    // ── 5. rejectException ─────────────────────────────────────────

    it('rejectException records reason + transitions to REJECTED', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'to reject',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await rejectException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            reason: 'mitigation is insufficient',
        });
        const ex = await getControlException(
            ctxAs(Role.ADMIN, admin.userId),
            exceptionId,
        );
        expect(ex.status).toBe('REJECTED');
        expect(ex.rejectedAt).toBeInstanceOf(Date);
        expect(ex.rejectedBy?.id).toBe(approver.userId);
    });

    // ── 6. Invalid transitions ─────────────────────────────────────

    it('cannot reject an APPROVED row', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'approved-then-reject',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            expiresAt: futureDate(30),
        });
        await expect(
            rejectException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
                reason: 'too late',
            }),
        ).rejects.toThrow(/only REQUESTED rows can be rejected/i);
    });

    it('cannot approve a REJECTED row', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'rejected-then-approve',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await rejectException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            reason: 'no',
        });
        await expect(
            approveException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
                expiresAt: futureDate(30),
            }),
        ).rejects.toThrow(/only REQUESTED rows can be approved/i);
    });

    // ── 7. renewException ─────────────────────────────────────────

    it('renewException creates a new REQUESTED row linked to the prior + inherits defaults', async () => {
        const { exceptionId: priorId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'original rationale',
                compensatingControlId: COMPENSATING_CONTROL_ID,
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(
            ctxAs(Role.ADMIN, approver.userId),
            priorId,
            { expiresAt: futureDate(15) },
        );

        const { exceptionId: renewedId, renewedFromId } = await renewException(
            ctxAs(Role.EDITOR, editor.userId),
            priorId,
            {},
        );
        expect(renewedFromId).toBe(priorId);

        const renewed = await getControlException(
            ctxAs(Role.ADMIN, admin.userId),
            renewedId,
        );
        // New row carries inherited defaults.
        expect(renewed.status).toBe('REQUESTED');
        expect(renewed.controlId).toBe(CONTROL_ID);
        expect(renewed.compensatingControlId).toBe(COMPENSATING_CONTROL_ID);
        expect(renewed.justification).toBe('original rationale');
        expect(renewed.renewedFromId).toBe(priorId);

        // Prior row untouched — still APPROVED with its original timestamps.
        const prior = await getControlException(
            ctxAs(Role.ADMIN, admin.userId),
            priorId,
        );
        expect(prior.status).toBe('APPROVED');
        expect(prior.approvedAt).toBeInstanceOf(Date);
    });

    it('renewException rejects renewal of a REJECTED row', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'will be rejected',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await rejectException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            reason: 'no',
        });
        await expect(
            renewException(ctxAs(Role.EDITOR, editor.userId), exceptionId, {}),
        ).rejects.toThrow(/Cannot renew a REJECTED/i);
    });

    // ── 8. getExpiringExceptions ───────────────────────────────────

    it('getExpiringExceptions returns approved exceptions within the window, ordered by expiry', async () => {
        // Two approved exceptions in window (5d, 20d), one out-of-window (60d).
        // Plus one REJECTED + one REQUESTED — neither should appear.
        const inWindowEarlyId = (
            await requestException(ctxAs(Role.ADMIN, admin.userId), {
                controlId: CONTROL_ID,
                justification: 'in-window-early',
                riskAcceptedByUserId: admin.userId,
            })
        ).exceptionId;
        const inWindowLateId = (
            await requestException(ctxAs(Role.ADMIN, admin.userId), {
                controlId: CONTROL_ID,
                justification: 'in-window-late',
                riskAcceptedByUserId: admin.userId,
            })
        ).exceptionId;
        const outOfWindowId = (
            await requestException(ctxAs(Role.ADMIN, admin.userId), {
                controlId: CONTROL_ID,
                justification: 'out-of-window',
                riskAcceptedByUserId: admin.userId,
            })
        ).exceptionId;
        const rejectedId = (
            await requestException(ctxAs(Role.ADMIN, admin.userId), {
                controlId: CONTROL_ID,
                justification: 'will-reject',
                riskAcceptedByUserId: admin.userId,
            })
        ).exceptionId;
        // Don't approve `pendingId` — leave REQUESTED.
        await requestException(ctxAs(Role.ADMIN, admin.userId), {
            controlId: CONTROL_ID,
            justification: 'pending',
            riskAcceptedByUserId: admin.userId,
        });

        await approveException(ctxAs(Role.ADMIN, approver.userId), inWindowEarlyId, {
            expiresAt: futureDate(5),
        });
        await approveException(ctxAs(Role.ADMIN, approver.userId), inWindowLateId, {
            expiresAt: futureDate(20),
        });
        await approveException(ctxAs(Role.ADMIN, approver.userId), outOfWindowId, {
            expiresAt: futureDate(60),
        });
        await rejectException(ctxAs(Role.ADMIN, approver.userId), rejectedId, {
            reason: 'no',
        });

        const expiring = await getExpiringExceptions(
            ctxAs(Role.ADMIN, admin.userId),
            30,
        );
        expect(expiring.map((e) => e.id)).toEqual([
            inWindowEarlyId,
            inWindowLateId,
        ]);
        // Window doesn't include the 60d row; the rejected + pending
        // rows are gated by status.
        expect(expiring.find((e) => e.id === outOfWindowId)).toBeUndefined();
        expect(expiring.find((e) => e.id === rejectedId)).toBeUndefined();
    });

    it('getExpiringExceptions rejects negative / non-finite days', async () => {
        await expect(
            getExpiringExceptions(ctxAs(Role.ADMIN, admin.userId), -1),
        ).rejects.toThrow(/non-negative/i);
        await expect(
            getExpiringExceptions(ctxAs(Role.ADMIN, admin.userId), Infinity),
        ).rejects.toThrow(/non-negative/i);
    });

    // ── 9. Audit chain ─────────────────────────────────────────────

    it('request → approve → renew emits the right audit-action sequence', async () => {
        const { exceptionId: priorId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'audit-trace test',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), priorId, {
            expiresAt: futureDate(30),
        });
        await renewException(ctxAs(Role.EDITOR, editor.userId), priorId, {});
        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: { startsWith: 'CONTROL_EXCEPTION_' },
            },
            orderBy: { createdAt: 'asc' },
            select: { action: true },
        });
        expect(audit.map((a) => a.action)).toEqual([
            'CONTROL_EXCEPTION_REQUESTED',
            'CONTROL_EXCEPTION_APPROVED',
            'CONTROL_EXCEPTION_RENEWED',
        ]);
    });

    // ── 10. listControlExceptions surfaces all states ──────────────

    it('listControlExceptions returns rows in the expected scope', async () => {
        const { exceptionId: req } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'r',
                riskAcceptedByUserId: admin.userId,
            },
        );
        const { exceptionId: app } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'a',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), app, {
            expiresAt: futureDate(30),
        });
        const all = await listControlExceptions(
            ctxAs(Role.ADMIN, admin.userId),
        );
        const ids = new Set(all.map((r) => r.id));
        expect(ids.has(req)).toBe(true);
        expect(ids.has(app)).toBe(true);

        const onlyApproved = await listControlExceptions(
            ctxAs(Role.ADMIN, admin.userId),
            { status: 'APPROVED' },
        );
        expect(onlyApproved.map((r) => r.id)).toEqual([app]);
    });
});
