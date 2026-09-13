/**
 * Epic G-4 — end-to-end campaign lifecycle hardening.
 *
 * Walks the complete reviewer journey under one DB context:
 *
 *   1. Admin creates the campaign        (createAccessReview)
 *   2. Reviewer submits decisions:
 *        - CONFIRM admin
 *        - REVOKE editor
 *        - MODIFY ownerB → READER
 *   3. Reminder job runs while pending  (no extra email after closeout)
 *   4. Admin closes the campaign         (closeAccessReview)
 *      - REVOKE deactivates editor's membership
 *      - MODIFY changes ownerB's role to READER
 *      - last-OWNER guard never triggers because ownerA stays
 *      - PDF artifact created + linked
 *      - Audit log carries every transition: CREATED, every
 *        DECISION_SUBMITTED, every DECISION_EXECUTED, CLOSED, and
 *        EVIDENCE_GENERATED, in that order.
 *
 * This is the file the auditor's logical question maps to
 * directly — "show me a SOC 2 access review where the reviewer
 * decided every user, the system applied the changes, and the
 * trail proves it."
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createAccessReview,
    submitDecision,
    closeAccessReview,
    getAccessReviewWithActivity,
} from '@/app-layer/usecases/access-review';
import { processAccessReviewReminders } from '@/app-layer/jobs/access-review-reminder';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SUITE_TAG = `g4e2e-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

interface UF {
    userId: string;
    membershipId: string;
}
let admin: UF;
let reviewer: UF;
let ownerA: UF;
let ownerB: UF;
let editor: UF;

async function makeUser(label: string, role: Role): Promise<UF> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    const m = await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId: u.id,
            role,
            status: MembershipStatus.ACTIVE,
        },
    });
    return { userId: u.id, membershipId: m.id };
}

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

describeFn('Epic G-4 — end-to-end campaign lifecycle', () => {
    beforeAll(async () => {
        // Force local storage so PDF generation has somewhere to land.
        process.env.STORAGE_PROVIDER = 'local';
        process.env.UPLOAD_DIR =
            process.env.UPLOAD_DIR || '/tmp/inflect-test-uploads';
        const { resetStorageProvider } = await import('@/lib/storage');
        resetStorageProvider();

        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        admin = await makeUser('admin', Role.ADMIN);
        reviewer = await makeUser('reviewer', Role.AUDITOR);
        ownerA = await makeUser('owner-a', Role.OWNER);
        ownerB = await makeUser('owner-b', Role.OWNER);
        editor = await makeUser('editor', Role.EDITOR);
    });

    afterAll(async () => {
        await globalPrisma.notificationOutbox.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.accessReviewDecision.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.accessReview.updateMany({
            where: { tenantId: TENANT_ID },
            data: { evidenceFileRecordId: null },
        });
        await globalPrisma.accessReview.deleteMany({
            where: { tenantId: TENANT_ID },
        });
        await globalPrisma.fileRecord.deleteMany({
            where: { tenantId: TENANT_ID, domain: 'evidence' },
        });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `SET LOCAL session_replication_role = 'replica'`,
            );
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                TENANT_ID,
            );
        });
        const userIds = [admin, reviewer, ownerA, ownerB, editor]
            .filter(Boolean)
            .map((u) => u.userId);
        if (userIds.length > 0) {
            await globalPrisma.user.deleteMany({
                where: { id: { in: userIds } },
            });
        }
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('runs the create → decide → remind → close path end-to-end', async () => {
        // ── 1. Create ───────────────────────────────────────────
        const dueAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        const { accessReviewId, snapshotCount } = await createAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            {
                name: 'E2E quarterly review',
                scope: 'CUSTOM',
                reviewerUserId: reviewer.userId,
                dueAt,
                customMembershipIds: [
                    admin.membershipId,
                    ownerA.membershipId,
                    ownerB.membershipId,
                    editor.membershipId,
                ],
            },
        );
        expect(snapshotCount).toBe(4);

        // Pull decision IDs back so we can target each.
        const review = await getAccessReviewWithActivity(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        const byUser = (uid: string) =>
            review.decisions.find((d) => d.subjectUserId === uid)!;
        const adminDec = byUser(admin.userId);
        const ownerADec = byUser(ownerA.userId);
        const ownerBDec = byUser(ownerB.userId);
        const editorDec = byUser(editor.userId);

        // ── 2. Reminder fires WHILE pending — one email lands ──
        const reminderResult1 = await processAccessReviewReminders(
            globalPrisma,
            { tenantId: TENANT_ID },
        );
        expect(reminderResult1.scanned).toBe(1);
        expect(reminderResult1.enqueued).toBe(1);
        const outbox1 = await globalPrisma.notificationOutbox.count({
            where: {
                tenantId: TENANT_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(outbox1).toBe(1);

        // ── 3. Reviewer submits each decision ───────────────────
        await submitDecision(ctxAs(Role.AUDITOR, reviewer.userId), adminDec.id, {
            decision: 'CONFIRM',
        });
        await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            ownerADec.id,
            { decision: 'CONFIRM', notes: 'Owner A continues to need OWNER' },
        );
        await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            ownerBDec.id,
            {
                decision: 'MODIFY',
                modifiedToRole: Role.READER,
                notes: 'Owner B should be READER going forward',
            },
        );
        await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            editorDec.id,
            { decision: 'REVOKE', notes: 'Left the company on 2026-05-01' },
        );

        // After all decisions land the campaign should be IN_REVIEW.
        const inReview = await globalPrisma.accessReview.findUniqueOrThrow({
            where: { id: accessReviewId },
        });
        expect(inReview.status).toBe('IN_REVIEW');

        // ── 4. Close the campaign ───────────────────────────────
        const closeResult = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            accessReviewId,
        );
        expect(closeResult.counts).toEqual({
            total: 4,
            executed: 2, // ownerB MODIFY + editor REVOKE
            confirmed: 2, // admin CONFIRM + ownerA CONFIRM
            skipped: 0,
        });
        expect(closeResult.evidenceFileRecordId).not.toBeNull();

        // ── 5. Live access — REVOKE deactivated editor; MODIFY moved
        //    ownerB to READER; ownerA still OWNER.
        const live = async (id: string) =>
            globalPrisma.tenantMembership.findUniqueOrThrow({ where: { id } });
        expect((await live(editor.membershipId)).status).toBe('DEACTIVATED');
        expect((await live(ownerB.membershipId)).role).toBe('READER');
        expect((await live(ownerA.membershipId)).role).toBe('OWNER');
        expect((await live(admin.membershipId)).role).toBe('ADMIN');

        // ── 6. Last-OWNER invariant held throughout ─────────────
        const liveOwners = await globalPrisma.tenantMembership.count({
            where: {
                tenantId: TENANT_ID,
                role: 'OWNER',
                status: 'ACTIVE',
            },
        });
        expect(liveOwners).toBeGreaterThanOrEqual(1);

        // ── 7. Audit trail — every meaningful transition emitted ─
        const audit = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID },
            orderBy: { createdAt: 'asc' },
            select: { action: true, entity: true },
        });
        const counts = audit.reduce<Record<string, number>>((acc, a) => {
            acc[a.action] = (acc[a.action] ?? 0) + 1;
            return acc;
        }, {});
        expect(counts['ACCESS_REVIEW_CREATED']).toBe(1);
        expect(counts['ACCESS_REVIEW_DECISION_SUBMITTED']).toBe(4);
        expect(counts['ACCESS_REVIEW_DECISION_EXECUTED']).toBe(4);
        expect(counts['ACCESS_REVIEW_CLOSED']).toBe(1);
        expect(counts['ACCESS_REVIEW_EVIDENCE_GENERATED']).toBe(1);

        // Order check — created before decisions before close before evidence.
        const idx = (action: string) =>
            audit.findIndex((a) => a.action === action);
        expect(idx('ACCESS_REVIEW_CREATED')).toBeLessThan(
            idx('ACCESS_REVIEW_DECISION_SUBMITTED'),
        );
        expect(idx('ACCESS_REVIEW_DECISION_SUBMITTED')).toBeLessThan(
            idx('ACCESS_REVIEW_DECISION_EXECUTED'),
        );
        expect(idx('ACCESS_REVIEW_DECISION_EXECUTED')).toBeLessThan(
            idx('ACCESS_REVIEW_CLOSED'),
        );
        expect(idx('ACCESS_REVIEW_CLOSED')).toBeLessThan(
            idx('ACCESS_REVIEW_EVIDENCE_GENERATED'),
        );

        // ── 8. Reminder is silent after close ───────────────────
        const reminderResult2 = await processAccessReviewReminders(
            globalPrisma,
            { tenantId: TENANT_ID },
        );
        expect(reminderResult2.scanned).toBe(0);
        const outbox2 = await globalPrisma.notificationOutbox.count({
            where: {
                tenantId: TENANT_ID,
                type: 'ACCESS_REVIEW_REMINDER',
            },
        });
        expect(outbox2).toBe(1); // unchanged from earlier

        // ── 9. PDF evidence is real + downloadable ──────────────
        const fileRecord = await globalPrisma.fileRecord.findUniqueOrThrow({
            where: { id: closeResult.evidenceFileRecordId! },
        });
        expect(fileRecord.mimeType).toBe('application/pdf');
        expect(fileRecord.sizeBytes).toBeGreaterThan(1024);
        expect(fileRecord.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(fileRecord.pathKey.startsWith(`tenants/${TENANT_ID}/evidence/`)).toBe(true);
    });
});
