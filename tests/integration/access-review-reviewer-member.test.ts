/**
 * A campaign's reviewer must be an ACTIVE member of the caller's tenant —
 * every create path, the settings change, and the reminder that would email
 * them. Real usecases, real database.
 *
 * Before this rule, the member, connected and legacy creates stored any
 * existing `User` id as the reviewer: somebody from another workspace, or a
 * member who had been deactivated. That person cannot open the campaign, and
 * the daily reminder emailed them its name and how much of it was undecided.
 * The agent create and the settings change already refused such a reviewer;
 * all five now ask the same function (`assertReviewerIsActiveMember`) and give
 * the same refusal.
 *
 * For each create: a user from another tenant is refused, a DEACTIVATED member
 * of this tenant is refused, an ACTIVE member is accepted, and a refusal
 * writes nothing — no campaign, no subject row, no audit row. The agent
 * create's acceptance needs a scored, granted preparer agent and is proved in
 * `access-review-agent-campaign.test.ts`; its refusals are proved here, because
 * the reviewer is asked before anything about the agents.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { createAccessReview, updateAccessReviewSettings } from '@/app-layer/usecases/access-review';
import { createConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { createLegacyAccessReview } from '@/app-layer/usecases/access-review-legacy';
import { createAgentAccessReview } from '@/app-layer/usecases/access-review-agent';
import { processAccessReviewReminders } from '@/app-layer/jobs/access-review-reminder';
import { ensureTenantDek } from '@/lib/security/tenant-key-manager';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `arrm-${randomUUID().slice(0, 8)}`;
const T = `t-${SUITE}`;
const OTHER = `t-${SUITE}-other`;
const ADMIN = `u-adm-${SUITE}`;
/** An ACTIVE member of T — the reviewer every path must accept. */
const MEMBER = `u-mem-${SUITE}`;
/** A member of T whose membership was DEACTIVATED. */
const DEACTIVATED = `u-deac-${SUITE}`;
/** An ACTIVE member of OTHER, with no row in T at all. */
const OUTSIDER = `u-out-${SUITE}`;
const USERS = [ADMIN, MEMBER, DEACTIVATED, OUTSIDER];

let oktaConnectionId = '';
let legacyConnectionId = '';

const ctx = () => makeRequestContext('ADMIN', { tenantId: T, tenantSlug: T, userId: ADMIN });

/** Everything a create could have written in T. */
async function writtenInT() {
    const where = { tenantId: T };
    return {
        campaigns: await prisma.accessReview.count({ where }),
        memberSubjects: await prisma.accessReviewDecision.count({ where }),
        connectedSubjects: await prisma.accessReviewConnectedDecision.count({ where }),
        // Every audit row in T, not a list of actions a create might use: a
        // refusal that wrote any row at all is a refusal that wrote something.
        audits: await prisma.auditLog.count({ where }),
    };
}

async function clearCampaigns(): Promise<void> {
    const where = { tenantId: T };
    await prisma.accessReviewDecision.deleteMany({ where });
    await prisma.accessReviewConnectedDecision.deleteMany({ where });
    await prisma.accessReview.deleteMany({ where });
    await prisma.notificationOutbox.deleteMany({ where });
}

/** A COMPLETE, fresh, reconciled legacy snapshot with one account. */
async function seedLegacySnapshot(): Promise<void> {
    const snap = await prisma.legacyAccessSnapshot.create({
        data: {
            tenantId: T, connectionId: legacyConnectionId, remoteSnapshotId: `snap-${SUITE}`,
            mappingVersion: 1, columnSetFingerprint: 'f'.repeat(64),
            payloadHash: 'c'.repeat(64), rowCount: 1, rowsReceived: 1,
            status: 'COMPLETE', completedAt: new Date(),
        },
    });
    await prisma.legacyAccount.create({
        data: {
            tenantId: T, snapshotId: snap.id, accountKey: 'kpatel',
            displayName: 'K Patel', email: `kpatel@${SUITE}.test`,
            status: 'ACTIVE', accountType: 'HUMAN', isPrivileged: false,
            entitlements: ['ledger.read'], lastLoginAt: new Date(),
        },
    });
    const exec = await prisma.integrationExecution.create({
        data: {
            tenantId: T, connectionId: legacyConnectionId, status: 'PASSED',
            provider: 'legacy-mcp', automationKey: 'legacy-mcp.reconcile',
            executedAt: new Date(), completedAt: new Date(),
        },
    });
    await prisma.legacyAccountResolution.create({
        data: {
            tenantId: T, executionId: exec.id, snapshotId: snap.id,
            accountKey: 'kpatel', outcome: 'UNMATCHED', method: 'NO_CANDIDATES',
            signalsJson: [], candidatesJson: [], vetoesJson: [],
        },
    });
}

type Create = (reviewerUserId: string) => Promise<{ accessReviewId: string }>;

/** The three creates this rule is new to, each with a population to cover. */
const CREATES: ReadonlyArray<[string, Create]> = [
    ['createAccessReview (ALL_USERS)', (reviewerUserId) =>
        createAccessReview(ctx(), { name: `members ${SUITE}`, reviewerUserId })],
    ['createConnectedAccessReview', (reviewerUserId) =>
        createConnectedAccessReview(ctx(), { name: `connected ${SUITE}`, reviewerUserId })],
    ['createLegacyAccessReview', (reviewerUserId) =>
        createLegacyAccessReview(ctx(), { name: `legacy ${SUITE}`, connectionId: legacyConnectionId, reviewerUserId })],
];

describeFn('a campaign\'s reviewer must be an ACTIVE member of the tenant (real DB)', () => {
    beforeAll(async () => {
        for (const id of [T, OTHER]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        // The tenant's DEK, provisioned now rather than lazily on the first
        // usecase call: that provisioning writes an audit row of its own, which
        // the "writes nothing" assertions below would otherwise count.
        await ensureTenantDek(T);
        for (const id of USERS) {
            await prisma.user.upsert({
                where: { id }, update: {},
                create: { id, email: `${id}@example.test`, name: id },
            });
        }
        const memberships: ReadonlyArray<[string, string, 'ADMIN' | 'READER', 'ACTIVE' | 'DEACTIVATED']> = [
            [T, ADMIN, 'ADMIN', 'ACTIVE'],
            [T, MEMBER, 'READER', 'ACTIVE'],
            [T, DEACTIVATED, 'READER', 'DEACTIVATED'],
            [OTHER, OUTSIDER, 'ADMIN', 'ACTIVE'],
        ];
        for (const [tenantId, userId, role, status] of memberships) {
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId, userId } },
                update: { role, status },
                create: { tenantId, userId, role, status },
            });
        }
        oktaConnectionId = (await prisma.integrationConnection.create({
            data: { tenantId: T, provider: 'okta', name: `okta-${SUITE}` },
        })).id;
        await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: T, provider: 'okta', externalUserId: `okta-${SUITE}`, email: `okta@${SUITE}.test`,
                connectionId: oktaConnectionId, syncedAt: new Date(),
            },
        });
        legacyConnectionId = (await prisma.integrationConnection.create({
            data: { tenantId: T, provider: 'legacy-mcp', name: `legacy-${SUITE}`, configJson: {} },
        })).id;
        await seedLegacySnapshot();
    });

    beforeEach(clearCampaigns);

    afterAll(async () => {
        await clearCampaigns();
        const where = { tenantId: T };
        await prisma.legacyAccountResolution.deleteMany({ where });
        await prisma.legacyAccount.deleteMany({ where });
        await prisma.legacyAccessSnapshot.deleteMany({ where });
        await prisma.integrationExecution.deleteMany({ where });
        await prisma.connectedIdentityAccount.deleteMany({ where });
        await prisma.integrationConnection.deleteMany({ where });
        // Audit rows BEFORE the parents: `AuditLog` has real FKs to Tenant and User.
        await deleteAuditRowsForTenants(prisma, [T, OTHER]);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T, OTHER]);
        });
        await prisma.tenant.deleteMany({ where: { id: { in: [T, OTHER] } } });
        await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    });

    describe.each(CREATES)('%s', (_name, create) => {
        it('refuses a user from another tenant, and writes nothing', async () => {
            const before = await writtenInT();
            await expect(create(OUTSIDER)).rejects.toThrow(/^REVIEWER_NOT_A_MEMBER: /);
            expect(await writtenInT()).toEqual(before);
        });

        it('refuses a DEACTIVATED member of this tenant, and writes nothing', async () => {
            const before = await writtenInT();
            await expect(create(DEACTIVATED)).rejects.toThrow(/^REVIEWER_NOT_A_MEMBER: /);
            expect(await writtenInT()).toEqual(before);
        });

        it('accepts an ACTIVE member, and the campaign names them', async () => {
            const before = await writtenInT();
            const { accessReviewId } = await create(MEMBER);
            // The positive control for "writes nothing" above: the same
            // measure moves when a create is admitted.
            const after = await writtenInT();
            expect(after.campaigns).toBe(before.campaigns + 1);
            expect(after.memberSubjects + after.connectedSubjects).toBeGreaterThan(before.memberSubjects + before.connectedSubjects);
            expect(after.audits).toBeGreaterThan(before.audits);
            const row = await prisma.accessReview.findUniqueOrThrow({ where: { id: accessReviewId } });
            expect(row.tenantId).toBe(T);
            expect(row.reviewerUserId).toBe(MEMBER);
        });
    });

    describe('createAgentAccessReview — the refusal is the same one, asked first', () => {
        it.each([['a user from another tenant', OUTSIDER], ['a DEACTIVATED member', DEACTIVATED]])(
            'refuses %s, and writes nothing',
            async (_label, reviewerUserId) => {
                const before = await writtenInT();
                await expect(
                    createAgentAccessReview(ctx(), {
                        name: `agents ${SUITE}`, reviewerUserId, preparerAgentId: 'agent-not-looked-at',
                    }),
                ).rejects.toThrow(/^REVIEWER_NOT_A_MEMBER: /);
                expect(await writtenInT()).toEqual(before);
            },
        );
    });

    describe('updateAccessReviewSettings — the one path that changes a reviewer', () => {
        it('refuses moving an open campaign to a DEACTIVATED member or an outsider, and accepts an ACTIVE one', async () => {
            const { accessReviewId } = await createAccessReview(ctx(), { name: `settings ${SUITE}`, reviewerUserId: ADMIN });
            for (const stranger of [DEACTIVATED, OUTSIDER]) {
                await expect(
                    updateAccessReviewSettings(ctx(), accessReviewId, { reviewerUserId: stranger }),
                ).rejects.toThrow(/^REVIEWER_NOT_A_MEMBER: /);
            }
            expect((await prisma.accessReview.findUniqueOrThrow({ where: { id: accessReviewId } })).reviewerUserId).toBe(ADMIN);

            await updateAccessReviewSettings(ctx(), accessReviewId, { reviewerUserId: MEMBER });
            expect((await prisma.accessReview.findUniqueOrThrow({ where: { id: accessReviewId } })).reviewerUserId).toBe(MEMBER);
        });
    });

    describe('the reminder does not email a reviewer who is not an ACTIVE member', () => {
        // A campaign written before the rule, or whose reviewer was
        // deactivated since, can still name one. Written directly, because no
        // create path can produce it any more.
        async function campaignNaming(reviewerUserId: string) {
            const review = await prisma.accessReview.create({
                data: {
                    tenantId: T, name: `reminder ${reviewerUserId}`, scope: 'ALL_USERS',
                    reviewerUserId, createdByUserId: ADMIN, dueAt: new Date(Date.now() + 2 * 86_400_000),
                },
            });
            await prisma.accessReviewDecision.create({
                data: {
                    tenantId: T, accessReviewId: review.id, subjectUserId: ADMIN,
                    snapshotRole: 'ADMIN', snapshotMembershipStatus: 'ACTIVE',
                },
            });
            return review.id;
        }
        const reminded = () => prisma.notificationOutbox.findMany({
            where: { tenantId: T, type: 'ACCESS_REVIEW_REMINDER' },
            select: { dedupeKey: true },
        });

        it('skips and counts an outsider and a DEACTIVATED member, and still reminds an ACTIVE one', async () => {
            const outsiderCampaign = await campaignNaming(OUTSIDER);
            const deactivatedCampaign = await campaignNaming(DEACTIVATED);
            const memberCampaign = await campaignNaming(MEMBER);

            const r = await processAccessReviewReminders(prisma, { tenantId: T });

            expect(r).toMatchObject({ scanned: 3, enqueued: 1, skippedReviewerNotMember: 2 });
            const outbox = await reminded();
            // The dedupe key carries the campaign id (tenant:type:email:campaign:day),
            // so it says which campaign each reminder was for.
            expect(outbox).toHaveLength(1);
            expect(outbox[0].dedupeKey).toContain(memberCampaign);
            const keys = outbox.map((o) => o.dedupeKey).join(' ');
            expect(keys).not.toContain(outsiderCampaign);
            expect(keys).not.toContain(deactivatedCampaign);
        });
    });
});
