/**
 * A person's email read THROUGH A RELATION comes back as plaintext.
 *
 * Users are written through the PII extension, as production writes them, so
 * the stored column is ciphertext. That is the difference this suite exists
 * for. `access-review-reminder.test.ts` writes its users through a raw client
 * that stores the address unencrypted, so the reminder's `toEmail` read back
 * fine there while production queued every reminder to a `v1:…` address: the
 * nested walk only knew nine relation names, and `AccessReview.reviewer` was
 * not one of them.
 *
 * Covers the three relations an access review reads people through, and the
 * reminder that turned the defect into undeliverable mail.
 */
import { MembershipStatus, Role } from '@prisma/client';
import { randomUUID } from 'crypto';

import { processAccessReviewReminders } from '@/app-layer/jobs/access-review-reminder';
import { isEncryptedValue } from '@/lib/security/encryption';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `piirel-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const emailOf = (label: string) => `${TAG}-${label}@example.test`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: any = DB_AVAILABLE ? prismaTestClient() : null;
const userIds: string[] = [];

async function makeMember(label: string, role: Role): Promise<string> {
    const user = await db.user.create({ data: { email: emailOf(label), name: `${label} person` } });
    userIds.push(user.id);
    await db.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: user.id, role, status: MembershipStatus.ACTIVE },
    });
    return user.id;
}

describeFn('PII decryption through relations (real client, real database)', () => {
    let creatorId: string;
    let reviewerId: string;
    let closerId: string;
    let subjectId: string;

    beforeAll(async () => {
        await db.tenant.create({ data: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        creatorId = await makeMember('creator', Role.ADMIN);
        reviewerId = await makeMember('reviewer', Role.AUDITOR);
        closerId = await makeMember('closer', Role.ADMIN);
        subjectId = await makeMember('subject', Role.EDITOR);
    });

    afterAll(async () => {
        await db.notificationOutbox.deleteMany({ where: { tenantId: TENANT_ID } });
        await db.accessReviewDecision.deleteMany({ where: { tenantId: TENANT_ID } });
        await db.accessReview.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(db, [TENANT_ID]);
        await db.$transaction(async (tx: typeof db) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, userIds);
        await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, TENANT_ID);
    });

    it('stores the address encrypted (the precondition: otherwise nothing here is tested)', async () => {
        const rows: Array<{ emailEncrypted: string }> = await db.$queryRawUnsafe(
            `SELECT "emailEncrypted" FROM "User" WHERE "id" = $1`,
            reviewerId,
        );
        expect(isEncryptedValue(rows[0].emailEncrypted)).toBe(true);
    });

    it('decrypts AccessReview.reviewer, createdBy and closedBy', async () => {
        const review = await db.accessReview.create({
            data: {
                tenantId: TENANT_ID,
                name: 'relation read probe',
                scope: 'ALL_USERS',
                reviewerUserId: reviewerId,
                createdByUserId: creatorId,
                closedByUserId: closerId,
            },
        });
        const read = await db.accessReview.findUnique({
            where: { id: review.id },
            select: {
                reviewer: { select: { email: true, name: true } },
                createdBy: { select: { email: true } },
                closedBy: { select: { email: true } },
            },
        });
        expect(read.reviewer).toEqual({ email: emailOf('reviewer'), name: 'reviewer person' });
        expect(read.createdBy.email).toBe(emailOf('creator'));
        expect(read.closedBy.email).toBe(emailOf('closer'));
    });

    it('queues the access-review reminder to the reviewer\'s real address', async () => {
        const now = new Date('2026-05-07T12:00:00Z');
        const review = await db.accessReview.create({
            data: {
                tenantId: TENANT_ID,
                name: 'reminder address probe',
                scope: 'ALL_USERS',
                reviewerUserId: reviewerId,
                createdByUserId: creatorId,
                dueAt: new Date('2026-05-10T12:00:00Z'),
            },
        });
        await db.accessReviewDecision.create({
            data: {
                tenantId: TENANT_ID,
                accessReviewId: review.id,
                subjectUserId: subjectId,
                snapshotRole: Role.EDITOR,
                snapshotMembershipStatus: MembershipStatus.ACTIVE,
            },
        });

        const result = await processAccessReviewReminders(db, { now, tenantId: TENANT_ID });
        expect(result.enqueued).toBe(1);

        const outbox = await db.notificationOutbox.findMany({
            where: { tenantId: TENANT_ID, type: 'ACCESS_REVIEW_REMINDER' },
        });
        expect(outbox).toHaveLength(1);
        expect(outbox[0].toEmail).toBe(emailOf('reviewer'));
    });
});
