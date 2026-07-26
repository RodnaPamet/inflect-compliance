/**
 * Epic G-5 — end-to-end lifecycle hardening + audit-trail integrity.
 *
 * Walks the complete exception story under one DB context:
 *
 *   1. Admin requests an exception
 *   2. Admin approves it with a 5-day expiry
 *   3. Monitor runs (now = approval-day + 1) → no transition,
 *      no reminder (day-1 isn't a window)
 *   4. Monitor runs (now = approval-day + 5d, when expiresAt has
 *      elapsed) → APPROVED → EXPIRED + audit row emitted
 *   5. Editor renews the EXPIRED row → new REQUESTED with
 *      renewedFromId pointing at the prior
 *   6. Audit-log query reproduces the canonical action sequence:
 *        REQUESTED → APPROVED → EXPIRED → RENEWED
 *      with category metadata + before/after status fields.
 *
 * This is the file the auditor's question maps to:
 *   "show me the lifecycle of one control exception, end-to-end,
 *    proven by your audit log."
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
    renewException,
    rejectException,
} from '@/app-layer/usecases/control-exception';
import { runExceptionExpiryMonitor } from '@/app-layer/jobs/exception-expiry-monitor';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g5lc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let admin: { userId: string; email: string };
let approver: { userId: string; email: string };
let editor: { userId: string };
let CONTROL_ID = '';

async function makeUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id, email };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    admin = await makeUser('admin');
    approver = await makeUser('approver');
    editor = await makeUser('editor');
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: approver.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: editor.userId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
        ],
    });
    const c = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'E2E control', code: 'AC.99' },
    });
    CONTROL_ID = c.id;
}

async function teardown() {
    await globalPrisma.notificationOutbox.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await globalPrisma.controlException.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: TENANT_ID },
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
    const userIds = [admin, approver, editor]
        .filter(Boolean)
        .map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

describeFn('Epic G-5 — end-to-end lifecycle + audit integrity', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.notificationOutbox.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.controlException.deleteMany({
            where: { tenantId: TENANT_ID },
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

    // ── 1. Full lifecycle — request → approve → expire → renew ─────

    it('walks request → approve → expire → renew with audit emission at every step', async () => {
        // Step A: request.
        const { exceptionId: priorId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'legacy DB cannot enforce X',
                riskAcceptedByUserId: admin.userId,
            },
        );

        // Step B: approve with 5-day expiry.
        const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        await approveException(
            ctxAs(Role.ADMIN, approver.userId),
            priorId,
            { expiresAt },
        );
        let row = await globalPrisma.controlException.findUniqueOrThrow({
            where: { id: priorId },
        });
        expect(row.status).toBe('APPROVED');

        // Step C: monitor runs ONE day later — out-of-window AND
        // not yet expired. No transition + no reminder yet.
        const dayPlusOne = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
        const r1 = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_ID,
            now: dayPlusOne,
        });
        expect(r1.transitionedToExpired).toBe(0);
        expect(r1.scanned).toBe(0);
        row = await globalPrisma.controlException.findUniqueOrThrow({
            where: { id: priorId },
        });
        expect(row.status).toBe('APPROVED');

        // Step D: monitor runs AT-or-past expiry → flips to EXPIRED.
        const past = new Date(expiresAt.getTime() + 1 * 60 * 60 * 1000);
        const r2 = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_ID,
            now: past,
        });
        expect(r2.transitionedToExpired).toBe(1);
        row = await globalPrisma.controlException.findUniqueOrThrow({
            where: { id: priorId },
        });
        expect(row.status).toBe('EXPIRED');
        // Approver triple is preserved — only status flipped.
        expect(row.approvedAt).toBeInstanceOf(Date);
        expect(row.approvedByUserId).toBe(approver.userId);
        expect(row.expiresAt).toBeInstanceOf(Date);

        // Step E: editor renews → new REQUESTED row points at the
        // expired prior.
        const { exceptionId: renewedId, renewedFromId } = await renewException(
            ctxAs(Role.EDITOR, editor.userId),
            priorId,
            { justification: 'still need the legacy carve-out' },
        );
        expect(renewedFromId).toBe(priorId);
        const renewed = await globalPrisma.controlException.findUniqueOrThrow({
            where: { id: renewedId },
        });
        expect(renewed.status).toBe('REQUESTED');
        expect(renewed.renewedFromId).toBe(priorId);
        // Prior row stays EXPIRED — renewal never mutates history.
        const finalPrior = await globalPrisma.controlException.findUniqueOrThrow({
            where: { id: priorId },
        });
        expect(finalPrior.status).toBe('EXPIRED');

        // Step F: audit chain reconstructs the canonical sequence.
        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: { startsWith: 'CONTROL_EXCEPTION_' },
            },
            orderBy: { createdAt: 'asc' },
            select: {
                action: true,
                entity: true,
                entityId: true,
                actorType: true,
                detailsJson: true,
            },
        });
        const actions = audit.map((a) => a.action);
        expect(actions).toEqual([
            'CONTROL_EXCEPTION_REQUESTED',
            'CONTROL_EXCEPTION_APPROVED',
            'CONTROL_EXCEPTION_EXPIRED',
            'CONTROL_EXCEPTION_RENEWED',
        ]);

        // Each row must carry the canonical category metadata.
        const byAction = new Map(audit.map((a) => [a.action, a]));
        const reqRow = byAction.get('CONTROL_EXCEPTION_REQUESTED')!;
        const appRow = byAction.get('CONTROL_EXCEPTION_APPROVED')!;
        const expRow = byAction.get('CONTROL_EXCEPTION_EXPIRED')!;
        const renRow = byAction.get('CONTROL_EXCEPTION_RENEWED')!;

        // Categories — entity_lifecycle for create/renew,
        // status_change for transitions.
        type Det = { category: string; fromStatus?: string; toStatus?: string };
        expect((reqRow.detailsJson as unknown as Det).category).toBe('entity_lifecycle');
        expect((appRow.detailsJson as unknown as Det).category).toBe('status_change');
        expect((expRow.detailsJson as unknown as Det).category).toBe('status_change');
        expect((renRow.detailsJson as unknown as Det).category).toBe('entity_lifecycle');

        // Status transitions carry both endpoints.
        expect((appRow.detailsJson as unknown as Det).fromStatus).toBe('REQUESTED');
        expect((appRow.detailsJson as unknown as Det).toStatus).toBe('APPROVED');
        expect((expRow.detailsJson as unknown as Det).fromStatus).toBe('APPROVED');
        expect((expRow.detailsJson as unknown as Det).toStatus).toBe('EXPIRED');

        // Expiry transition is system-actor.
        expect(expRow.actorType).toBe('SYSTEM');
        // Other transitions are user-actor.
        expect(reqRow.actorType).toBe('USER');
        expect(appRow.actorType).toBe('USER');
        expect(renRow.actorType).toBe('USER');

        // Renewal entity-id is the NEW row; prior id is in detailsJson.
        expect(renRow.entityId).toBe(renewedId);
        type RenDet = { after?: { renewedFromId?: string } };
        expect((renRow.detailsJson as unknown as RenDet).after?.renewedFromId).toBe(priorId);
    });

    // ── 2. REJECTED path emits one audit row + halts the lifecycle ─

    it('REJECTED branch emits exactly one CONTROL_EXCEPTION_REJECTED row', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'will be rejected',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await rejectException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            reason: 'mitigation insufficient',
        });
        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                entityId: exceptionId,
                action: { startsWith: 'CONTROL_EXCEPTION_' },
            },
            orderBy: { createdAt: 'asc' },
            select: { action: true },
        });
        expect(audit.map((a) => a.action)).toEqual([
            'CONTROL_EXCEPTION_REQUESTED',
            'CONTROL_EXCEPTION_REJECTED',
        ]);
    });

    // ── 3. Audit-trail entity binding — every row references the
    //   correct exception by entityId so the auditor can filter. ──

    it('every audit row carries entity=ControlException + entityId of the affected row', async () => {
        const { exceptionId } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'binding test',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), exceptionId, {
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entityId: exceptionId },
            select: { action: true, entity: true, entityId: true },
        });
        expect(rows.length).toBeGreaterThanOrEqual(2);
        for (const r of rows) {
            expect(r.entity).toBe('ControlException');
            expect(r.entityId).toBe(exceptionId);
        }
    });

    // ── 4. Renewal-chain traversal via renewedFromId ──────────────

    it('renewal chain is reconstructible across multiple generations', async () => {
        // Generation 0 → APPROVED
        const { exceptionId: g0 } = await requestException(
            ctxAs(Role.ADMIN, admin.userId),
            {
                controlId: CONTROL_ID,
                justification: 'gen-0',
                riskAcceptedByUserId: admin.userId,
            },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), g0, {
            expiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
        });
        // Force gen-0 expiry via the monitor.
        await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_ID,
            now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        });

        // Generation 1 — renewal of gen-0
        const { exceptionId: g1 } = await renewException(
            ctxAs(Role.ADMIN, admin.userId),
            g0,
            { justification: 'gen-1' },
        );
        await approveException(ctxAs(Role.ADMIN, approver.userId), g1, {
            expiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
        });
        await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_ID,
            now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        });

        // Generation 2 — renewal of gen-1
        const { exceptionId: g2 } = await renewException(
            ctxAs(Role.ADMIN, admin.userId),
            g1,
            { justification: 'gen-2' },
        );

        // Walk the chain backwards.
        const g2Row = await globalPrisma.controlException.findUniqueOrThrow({
            where: { id: g2 },
            include: {
                renewedFrom: {
                    include: {
                        renewedFrom: { select: { id: true, status: true } },
                    },
                },
            },
        });
        expect(g2Row.renewedFromId).toBe(g1);
        expect(g2Row.renewedFrom?.id).toBe(g1);
        expect(g2Row.renewedFrom?.status).toBe('EXPIRED');
        expect(g2Row.renewedFrom?.renewedFrom?.id).toBe(g0);
        expect(g2Row.renewedFrom?.renewedFrom?.status).toBe('EXPIRED');

        // Audit log reconstructs the same chain via the renewal
        // events alone — no live-table read needed.
        const renewalEvents = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: 'CONTROL_EXCEPTION_RENEWED',
            },
            orderBy: { createdAt: 'asc' },
            select: { entityId: true, detailsJson: true },
        });
        type RenAfter = { after?: { renewedFromId?: string } };
        expect(renewalEvents).toHaveLength(2);
        // First renewal: new = g1, renewedFrom = g0.
        expect(renewalEvents[0].entityId).toBe(g1);
        expect(
            (renewalEvents[0].detailsJson as unknown as RenAfter).after?.renewedFromId,
        ).toBe(g0);
        // Second renewal: new = g2, renewedFrom = g1.
        expect(renewalEvents[1].entityId).toBe(g2);
        expect(
            (renewalEvents[1].detailsJson as unknown as RenAfter).after?.renewedFromId,
        ).toBe(g1);

        // Plus two EXPIRED rows for g0 and g1.
        const expiredEvents = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: 'CONTROL_EXCEPTION_EXPIRED',
            },
            orderBy: { createdAt: 'asc' },
            select: { entityId: true, actorType: true },
        });
        expect(expiredEvents.map((e) => e.entityId).sort()).toEqual(
            [g0, g1].sort(),
        );
        for (const ev of expiredEvents) {
            expect(ev.actorType).toBe('SYSTEM');
        }
    });
});
