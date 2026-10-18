/**
 * #3674 — the AGENT scope against a real database: the readers, and the
 * generic paths' refusals.
 *
 * The reason the value ships in two deploys is that a Prisma client meeting an
 * enum value it was not generated with fails the whole read — on the register,
 * every campaign the tenant has. So the property worth proving against a real
 * database is the one deploy 2's rollout depends on: an AGENT row, written as
 * deploy 2 will write it, is read by this build's readers without error, its
 * subjects are narrowed to the readers who may see them, and every path that
 * would decide or close it refuses by name and leaves it untouched.
 *
 * The row is written straight through the test client, in the shape a deploy-1
 * container meets it — without deploy 2's own columns — because that is the
 * row the readers must survive. Deploy 2's campaign flow, which does write AGENT,
 * is proved in `access-review-agent-campaign.test.ts`; here the property is that
 * the GENERIC member and connected paths still refuse to act on one, by name.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import {
    closeAccessReview,
    createAccessReview,
    getAccessReviewWithActivity,
    listAccessReviews,
} from '@/app-layer/usecases/access-review';
import {
    closeConnectedAccessReview,
    listConnectedDecisions,
    submitConnectedDecision,
} from '@/app-layer/usecases/access-review-connected';

const prisma: PrismaClient = prismaTestClient();
const T = 'ars-agent-scope';
const REVIEWER = 'ars-reviewer';
const READER = 'ars-reader';
const ctx = (role: string, userId: string) => makeRequestContext(role, { tenantId: T, userId });

let reviewId = '';
let decisionId = '';

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.task.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReviewDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.tenantMembership.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
}

beforeAll(async () => {
    await clearOwnRows();
    await prisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, name: 'Agent scope tenant', slug: T } });
    for (const [id, email] of [[REVIEWER, 'reviewer@ars.test'], [READER, 'reader@ars.test']]) {
        await prisma.user.upsert({ where: { id }, update: {}, create: { id, email, name: id } });
    }
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: READER, role: 'READER', status: 'ACTIVE' } });
});

beforeEach(async () => {
    await prisma.accessReviewConnectedDecision.deleteMany({ where: { tenantId: T } });
    await prisma.accessReview.deleteMany({ where: { tenantId: T } });
    const review = await prisma.accessReview.create({
        data: {
            tenantId: T, name: 'Q4 agent recertification', scope: 'AGENT',
            reviewerUserId: REVIEWER, createdByUserId: REVIEWER,
        },
    });
    reviewId = review.id;
    decisionId = (await prisma.accessReviewConnectedDecision.create({
        data: {
            tenantId: T, accessReviewId: reviewId, connectedAccountId: null,
            subjectRef: 'agent:ag-1',
            snapshotJson: {
                kind: 'AGENT', agentId: 'ag-1', agentName: 'Evidence collector', agentStatus: 'ACTIVE',
                ownerUserId: 'someone', ownerEmail: 'owner@ars.test', grantCount: 2,
            },
        },
    })).id;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the migration', () => {
    it('adds AGENT to the database enum, last', async () => {
        const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
            SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'AccessReviewScope' ORDER BY e.enumsortorder`;
        expect(rows.map((r) => r.enumlabel)).toEqual(['ALL_USERS', 'ADMIN_ONLY', 'CUSTOM', 'CONNECTED_APP', 'LEGACY_APP', 'AGENT']);
    });
});

describe('readers read an AGENT row', () => {
    it('the register lists it, with its subjects counted', async () => {
        const rows = await listAccessReviews(ctx('READER', READER));
        const row = rows.find((r) => r.id === reviewId);
        expect(row?.scope).toBe('AGENT');
        expect(row?._count).toEqual({ decisions: 0, connectedDecisions: 1 });
    });

    it('the detail withholds the subjects from a member who is neither the reviewer nor a register reader', async () => {
        const detail = await getAccessReviewWithActivity(ctx('READER', READER), reviewId);
        expect(detail.subjectsRestricted).toBe(true);
        expect(detail.connectedDecisions).toHaveLength(1);
        expect(detail.connectedDecisions[0].snapshotJson).toBeNull();
        const list = await listConnectedDecisions(ctx('READER', READER), reviewId);
        expect(list[0].snapshotJson).toBeNull();
    });

    it('…and shows them to the assigned reviewer', async () => {
        const detail = await getAccessReviewWithActivity(ctx('READER', REVIEWER), reviewId);
        expect(detail.subjectsRestricted).toBe(false);
        expect(detail.connectedDecisions[0].snapshotJson).toMatchObject({ agentName: 'Evidence collector' });
    });
});

describe('the generic paths do not act on an AGENT campaign', () => {
    it('a decision through the generic decide is refused by name, and the row stays undecided', async () => {
        await expect(
            submitConnectedDecision(ctx('ADMIN', REVIEWER), decisionId, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/AGENT_CAMPAIGN_OWN_FLOW/);
        const row = await prisma.accessReviewConnectedDecision.findUniqueOrThrow({ where: { id: decisionId } });
        expect(row.decision).toBeNull();
        expect(row.decidedAt).toBeNull();
    });

    it('both generic closes refuse by name, even fully decided, and leave the campaign open with no task', async () => {
        await prisma.accessReviewConnectedDecision.update({
            where: { id: decisionId },
            data: { decision: 'CONFIRM', decidedAt: new Date(), decidedByUserId: REVIEWER },
        });
        await expect(closeConnectedAccessReview(ctx('ADMIN', REVIEWER), reviewId)).rejects.toThrow(/AGENT_CAMPAIGN_OWN_FLOW/);
        await expect(closeAccessReview(ctx('ADMIN', REVIEWER), reviewId)).rejects.toThrow(/AGENT_CAMPAIGN_OWN_FLOW/);
        const review = await prisma.accessReview.findUniqueOrThrow({ where: { id: reviewId } });
        expect(review.status).toBe('OPEN');
        expect(review.closedAt).toBeNull();
        expect(await prisma.task.count({ where: { tenantId: T } })).toBe(0);
    });

    it('the member creation route refuses to create one, naming its own route', async () => {
        const before = await prisma.accessReview.count({ where: { tenantId: T } });
        await expect(
            createAccessReview(ctx('ADMIN', REVIEWER), { name: 'nope', reviewerUserId: REVIEWER, scope: 'AGENT' }),
        ).rejects.toThrow(/SCOPE_HAS_ITS_OWN_ROUTE/);
        expect(await prisma.accessReview.count({ where: { tenantId: T } })).toBe(before);
    });
});
