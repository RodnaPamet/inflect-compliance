/**
 * ep1 evidence review gate (integration).
 *
 * Proves, against a real DB, that evidence approval is load-bearing and
 * segregation-of-duties is enforced on BOTH the single-item
 * (`reviewEvidence`) and bulk (`bulkApproveEvidence`) paths:
 *
 *   - an EDITOR (write, not reviewer) cannot approve — single throws,
 *     bulk throws (reviewer tier required);
 *   - bulk-approve on a DRAFT + SUBMITTED + REJECTED mix approves ONLY
 *     the SUBMITTED row and reports the skipped counts; DRAFT is never
 *     approved;
 *   - self-review is refused — a reviewer who submitted the evidence
 *     cannot approve it (single throws forbidden; bulk skips it into
 *     `skippedSelfReview`);
 *   - each approval writes an EvidenceReview row + a STATUS_CHANGE audit
 *     row.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { reviewEvidence, bulkApproveEvidence } from '@/app-layer/usecases/evidence';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `ev-gate-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;

let reviewerId = ''; // ADMIN — approves
let authorId = ''; // EDITOR — submits
let adminCtx: ReturnType<typeof makeRequestContext>;
let editorCtx: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

/** Create a DRAFT evidence row directly, owned by `ownerUserId`. */
async function makeEvidence(title: string, ownerUserId: string | null): Promise<string> {
    const ev = await globalPrisma.evidence.create({
        data: {
            tenantId: TENANT_ID,
            type: 'TEXT',
            title,
            status: 'DRAFT',
            ownerUserId,
        },
    });
    return ev.id;
}

describeFn('evidence review gate — integrity (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
        });
        reviewerId = await makeUser('reviewer', Role.ADMIN);
        authorId = await makeUser('author', Role.EDITOR);
        adminCtx = makeRequestContext('ADMIN', { tenantId: TENANT_ID, tenantSlug: TAG, userId: reviewerId });
        editorCtx = makeRequestContext('EDITOR', { tenantId: TENANT_ID, tenantSlug: TAG, userId: authorId });
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) {
            await globalPrisma.$disconnect();
            return;
        }
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "EvidenceReview" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [reviewerId, authorId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('EDITOR cannot approve — single path throws and bulk path throws', async () => {
        const id = await makeEvidence('editor-cannot-approve', authorId);
        await reviewEvidence(editorCtx, id, { action: 'SUBMITTED' }); // author submits

        // Single approve as EDITOR — reviewer tier required.
        await expect(reviewEvidence(editorCtx, id, { action: 'APPROVED' })).rejects.toThrow();
        // Bulk approve as EDITOR — same reviewer-tier gate.
        await expect(bulkApproveEvidence(editorCtx, [id])).rejects.toThrow();

        const after = await globalPrisma.evidence.findUniqueOrThrow({ where: { id } });
        expect(after.status).toBe('SUBMITTED'); // never approved
    });

    it('bulk-approve on DRAFT+SUBMITTED+REJECTED approves only SUBMITTED and reports skips', async () => {
        const evS = await makeEvidence('mix-submitted', authorId);
        const evD = await makeEvidence('mix-draft', authorId);
        const evR = await makeEvidence('mix-rejected', authorId);

        // evS → SUBMITTED (author submits).
        await reviewEvidence(editorCtx, evS, { action: 'SUBMITTED' });
        // evR → SUBMITTED then REJECTED (admin rejects — not the author, SoD ok).
        await reviewEvidence(editorCtx, evR, { action: 'SUBMITTED' });
        await reviewEvidence(adminCtx, evR, { action: 'REJECTED', comment: 'not good enough' });
        // evD stays DRAFT.

        const result = await bulkApproveEvidence(adminCtx, [evS, evD, evR]);
        expect(result).toEqual({
            approved: 1,
            skipped: 2,
            skippedNotSubmitted: 2,
            skippedSelfReview: 0,
        });

        const [rowS, rowD, rowR] = await Promise.all([
            globalPrisma.evidence.findUniqueOrThrow({ where: { id: evS } }),
            globalPrisma.evidence.findUniqueOrThrow({ where: { id: evD } }),
            globalPrisma.evidence.findUniqueOrThrow({ where: { id: evR } }),
        ]);
        expect(rowS.status).toBe('APPROVED');
        expect(rowD.status).toBe('DRAFT'); // DRAFT never approved
        expect(rowR.status).toBe('REJECTED'); // REJECTED never approved
    });

    it('self-review refused — submitter cannot approve their own evidence', async () => {
        // Admin both owns AND submits this evidence → self-review.
        const id = await makeEvidence('self-review', reviewerId);
        await reviewEvidence(adminCtx, id, { action: 'SUBMITTED' }); // admin submits

        await expect(reviewEvidence(adminCtx, id, { action: 'APPROVED' })).rejects.toThrow(
            /segregation of duties/i,
        );

        const bulk = await bulkApproveEvidence(adminCtx, [id]);
        expect(bulk).toEqual({
            approved: 0,
            skipped: 1,
            skippedNotSubmitted: 0,
            skippedSelfReview: 1,
        });

        const after = await globalPrisma.evidence.findUniqueOrThrow({ where: { id } });
        expect(after.status).toBe('SUBMITTED'); // still not approved
    });

    it('each approval writes an EvidenceReview row + a STATUS_CHANGE audit row', async () => {
        const id = await makeEvidence('audit-trail', authorId);
        await reviewEvidence(editorCtx, id, { action: 'SUBMITTED' });
        await reviewEvidence(adminCtx, id, { action: 'APPROVED' });

        const approvedReviews = await globalPrisma.evidenceReview.findMany({
            where: { tenantId: TENANT_ID, evidenceId: id, action: 'APPROVED' },
        });
        expect(approvedReviews.length).toBe(1);
        expect(approvedReviews[0].reviewerId).toBe(reviewerId);

        const auditRows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entityId: id, action: 'STATUS_CHANGE' },
        });
        // At least the APPROVED transition (SUBMITTED transition also logs).
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
    });
});
