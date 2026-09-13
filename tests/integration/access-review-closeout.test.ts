/**
 * Epic G-4 — closeAccessReview integration tests.
 *
 * The closeout engine carries the most behavior of the campaign
 * lifecycle: live access mutation, last-OWNER guard, audit
 * emission, and PDF evidence generation. Every assertion below
 * exercises a path the brief explicitly called out.
 *
 * Coverage
 * --------
 *   1. CONFIRM rows are recorded as no-ops with the NO_CHANGE
 *      outcome; live membership stays untouched.
 *   2. REVOKE rows actually deactivate the live TenantMembership.
 *   3. MODIFY rows actually change the live role.
 *   4. closeAccessReview rejects when any decision is pending.
 *   5. Last-OWNER guard — the WHOLE close is rejected when the
 *      planned execution would zero out OWNERs.
 *   6. Audit log carries one ACCESS_REVIEW_DECISION_EXECUTED entry
 *      per decision, plus the final ACCESS_REVIEW_CLOSED + the
 *      ACCESS_REVIEW_EVIDENCE_GENERATED row.
 *   7. PDF artifact is generated, written through the storage
 *      provider, and linked to the campaign via
 *      `evidenceFileRecordId`.
 *   8. Stale subject (membership deleted out from under the
 *      campaign) → SKIPPED_STALE outcome; close still completes.
 *   9. CLOSED campaigns reject re-close.
 *  10. Non-admin actor cannot close.
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
} from '@/app-layer/usecases/access-review';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g4c-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

interface UserFixture {
    userId: string;
    membershipId: string;
}

let ownerA: UserFixture;
let ownerB: UserFixture;
let admin: UserFixture;
let reviewer: UserFixture;
let editor: UserFixture;
let reader: UserFixture;

async function makeUserAndMembership(
    label: string,
    role: Role,
    tenantId: string = TENANT_ID,
    status: MembershipStatus = MembershipStatus.ACTIVE,
): Promise<UserFixture> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    const m = await globalPrisma.tenantMembership.create({
        data: { tenantId, userId: u.id, role, status },
    });
    return { userId: u.id, membershipId: m.id };
}

async function seedFixtures() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    ownerA = await makeUserAndMembership('owner-a', Role.OWNER);
    ownerB = await makeUserAndMembership('owner-b', Role.OWNER);
    admin = await makeUserAndMembership('admin', Role.ADMIN);
    reviewer = await makeUserAndMembership('reviewer', Role.AUDITOR);
    editor = await makeUserAndMembership('editor', Role.EDITOR);
    reader = await makeUserAndMembership('reader', Role.READER);
}

async function teardownFixtures() {
    await globalPrisma.accessReviewDecision.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    // Detach FK from AccessReview before deleting FileRecords.
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
    // Bypass triggers (last-OWNER guard fires otherwise) + immutability.
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
    const userIds = [
        ownerA?.userId,
        ownerB?.userId,
        admin?.userId,
        reviewer?.userId,
        editor?.userId,
        reader?.userId,
    ].filter(Boolean) as string[];
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

/// Helper — create a campaign + decide every subject so it's
/// closeout-ready. Returns the campaign + the snapshot decisions
/// for direct lookup of the per-row mutation.
async function createCampaignAndDecideAll(
    decideMap: Record<
        string, // subjectUserId
        {
            decision: 'CONFIRM' | 'REVOKE' | 'MODIFY';
            modifiedToRole?: Role;
            notes?: string;
        }
    >,
): Promise<string> {
    const { accessReviewId } = await createCustomScopeCampaign(
        Object.keys(decideMap),
    );
    const review = await globalPrisma.accessReview.findUniqueOrThrow({
        where: { id: accessReviewId },
        include: { decisions: true },
    });
    for (const decision of review.decisions) {
        const verdict = decideMap[decision.subjectUserId];
        if (!verdict) continue;
        await submitDecision(
            ctxAs(Role.AUDITOR, reviewer.userId),
            decision.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            verdict as any,
        );
    }
    return accessReviewId;
}

async function createCustomScopeCampaign(subjectUserIds: string[]) {
    const memberships = await globalPrisma.tenantMembership.findMany({
        where: { tenantId: TENANT_ID, userId: { in: subjectUserIds } },
        select: { id: true },
    });
    return createAccessReview(ctxAs(Role.ADMIN, admin.userId), {
        name: `closeout-test-${randomUUID().slice(0, 8)}`,
        scope: 'CUSTOM',
        reviewerUserId: reviewer.userId,
        customMembershipIds: memberships.map((m) => m.id),
    });
}

describeFn('Epic G-4 — closeAccessReview executes decisions + emits evidence', () => {
    beforeAll(async () => {
        // The storage provider defaults to 's3' under env validation;
        // tests run with SKIP_ENV_VALIDATION=1 so process.env wins.
        // Force the local-filesystem backend so PDF generation has
        // somewhere to write without S3 credentials.
        process.env.STORAGE_PROVIDER = 'local';
        process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/inflect-test-uploads';
        const { resetStorageProvider } = await import('@/lib/storage');
        resetStorageProvider();
        await seedFixtures();
    });

    afterAll(async () => {
        await teardownFixtures();
        await globalPrisma.$disconnect();
    });

    afterEach(async () => {
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
        // Clear audit log so cross-test audit-count assertions stay
        // deterministic. AuditLog has the immutability trigger; bypass
        // via session_replication_role=replica (postgres role).
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        // Restore any membership we mutated mid-test.
        const restore: Array<{
            id: string;
            role: Role;
            status: MembershipStatus;
        }> = [
            { id: ownerA.membershipId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            { id: ownerB.membershipId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            { id: admin.membershipId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { id: reviewer.membershipId, role: Role.AUDITOR, status: MembershipStatus.ACTIVE },
            { id: editor.membershipId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
            { id: reader.membershipId, role: Role.READER, status: MembershipStatus.ACTIVE },
        ];
        for (const r of restore) {
            await globalPrisma.tenantMembership
                .update({
                    where: { id: r.id },
                    data: { role: r.role, status: r.status, deactivatedAt: null },
                })
                .catch(() => undefined);
        }
    });

    // ── 1. CONFIRM no-op ───────────────────────────────────────────

    it('CONFIRM decisions execute as NO_CHANGE and live membership is untouched', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'CONFIRM' },
            [reader.userId]: { decision: 'CONFIRM' },
        });
        const before = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: editor.membershipId },
        });
        const result = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            reviewId,
        );
        expect(result.executions.every((e) => e.outcome === 'NO_CHANGE')).toBe(true);
        const after = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: editor.membershipId },
        });
        expect(after.role).toBe(before.role);
        expect(after.status).toBe(before.status);
    });

    // ── 2. REVOKE deactivates ──────────────────────────────────────

    it('REVOKE deactivates the live TenantMembership', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'REVOKE', notes: 'left the company' },
        });
        const result = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            reviewId,
        );
        expect(result.executions[0].outcome).toBe('EXECUTED');
        const after = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: editor.membershipId },
        });
        expect(after.status).toBe('DEACTIVATED');
        expect(after.deactivatedAt).toBeInstanceOf(Date);
    });

    // ── 3. MODIFY changes role ─────────────────────────────────────

    it('MODIFY changes the live role', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'MODIFY', modifiedToRole: Role.READER, notes: 'over-privileged' },
        });
        const result = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            reviewId,
        );
        expect(result.executions[0].outcome).toBe('EXECUTED');
        const after = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: editor.membershipId },
        });
        expect(after.role).toBe('READER');
    });

    // ── 4. Pending decisions reject the close ──────────────────────

    it('rejects close when any decision is still pending', async () => {
        const { accessReviewId } = await createCustomScopeCampaign([editor.userId]);
        // Don't submit a decision — it's still null.
        await expect(
            closeAccessReview(ctxAs(Role.ADMIN, admin.userId), accessReviewId),
        ).rejects.toThrow(/pending|every subject/i);
    });

    // ── 5. Last-OWNER guard ────────────────────────────────────────

    it('rejects the close when planned execution would leave zero ACTIVE OWNERs', async () => {
        // Both OWNERs marked REVOKE — would leave the tenant with zero owners.
        const reviewId = await createCampaignAndDecideAll({
            [ownerA.userId]: { decision: 'REVOKE', notes: 'rotation' },
            [ownerB.userId]: { decision: 'REVOKE', notes: 'rotation' },
        });
        await expect(
            closeAccessReview(ctxAs(Role.ADMIN, admin.userId), reviewId),
        ).rejects.toThrow(/zero ACTIVE OWNERs/i);
        // Both OWNER memberships untouched.
        const a = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: ownerA.membershipId },
        });
        const b = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: ownerB.membershipId },
        });
        expect(a.status).toBe('ACTIVE');
        expect(b.status).toBe('ACTIVE');
    });

    it('allows the close when only ONE of two OWNERs is REVOKEd', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [ownerA.userId]: { decision: 'REVOKE', notes: 'rotation' },
            // ownerB stays
        });
        const result = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            reviewId,
        );
        expect(result.executions[0].outcome).toBe('EXECUTED');
        const a = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: ownerA.membershipId },
        });
        const b = await globalPrisma.tenantMembership.findUniqueOrThrow({
            where: { id: ownerB.membershipId },
        });
        expect(a.status).toBe('DEACTIVATED');
        expect(b.status).toBe('ACTIVE');
    });

    // ── 6. Audit trail ─────────────────────────────────────────────

    it('emits ACCESS_REVIEW_DECISION_EXECUTED for each decision + ACCESS_REVIEW_CLOSED', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'CONFIRM' },
            [reader.userId]: { decision: 'REVOKE', notes: 'left' },
        });
        await closeAccessReview(ctxAs(Role.ADMIN, admin.userId), reviewId);
        const audit = await globalPrisma.auditLog.findMany({
            where: {
                tenantId: TENANT_ID,
                action: { in: ['ACCESS_REVIEW_DECISION_EXECUTED', 'ACCESS_REVIEW_CLOSED', 'ACCESS_REVIEW_EVIDENCE_GENERATED'] },
            },
            orderBy: { createdAt: 'asc' },
        });
        const actions = audit.map((a) => a.action);
        expect(actions.filter((a) => a === 'ACCESS_REVIEW_DECISION_EXECUTED')).toHaveLength(2);
        expect(actions).toContain('ACCESS_REVIEW_CLOSED');
        expect(actions).toContain('ACCESS_REVIEW_EVIDENCE_GENERATED');
    });

    // ── 7. PDF artifact generated + linked ─────────────────────────

    it('generates a PDF artifact and links it to the campaign', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'CONFIRM' },
        });
        const result = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            reviewId,
        );
        expect(result.evidenceFileRecordId).not.toBeNull();
        const review = await globalPrisma.accessReview.findUniqueOrThrow({
            where: { id: reviewId },
        });
        expect(review.status).toBe('CLOSED');
        expect(review.evidenceFileRecordId).toBe(result.evidenceFileRecordId);
        const file = await globalPrisma.fileRecord.findUniqueOrThrow({
            where: { id: review.evidenceFileRecordId! },
        });
        expect(file.mimeType).toBe('application/pdf');
        expect(file.domain).toBe('evidence');
        expect(file.status).toBe('STORED');
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.pathKey.startsWith(`tenants/${TENANT_ID}/evidence/`)).toBe(true);
    });

    // ── 8. Stale subject ───────────────────────────────────────────

    it('handles stale subject (membership deleted mid-campaign) with SKIPPED_STALE', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'REVOKE', notes: 'planned revoke' },
        });
        // Simulate offboard outside the campaign by clearing the
        // decision's membership FK — same as a TenantMembership delete
        // would (SetNull cascade on AccessReviewDecision.membershipId).
        await globalPrisma.accessReviewDecision.updateMany({
            where: { tenantId: TENANT_ID, subjectUserId: editor.userId },
            data: { membershipId: null },
        });
        const result = await closeAccessReview(
            ctxAs(Role.ADMIN, admin.userId),
            reviewId,
        );
        expect(result.executions[0].outcome).toBe('SKIPPED_STALE');
    });

    // ── 9. CLOSED is immutable ─────────────────────────────────────

    it('rejects re-close of an already-CLOSED campaign', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'CONFIRM' },
        });
        await closeAccessReview(ctxAs(Role.ADMIN, admin.userId), reviewId);
        await expect(
            closeAccessReview(ctxAs(Role.ADMIN, admin.userId), reviewId),
        ).rejects.toThrow(/already closed/i);
    });

    // ── 10. Permission gate ────────────────────────────────────────

    it('non-admin actor cannot close', async () => {
        const reviewId = await createCampaignAndDecideAll({
            [editor.userId]: { decision: 'CONFIRM' },
        });
        await expect(
            closeAccessReview(ctxAs(Role.READER, reader.userId), reviewId),
        ).rejects.toThrow(/permission/i);
    });
});
