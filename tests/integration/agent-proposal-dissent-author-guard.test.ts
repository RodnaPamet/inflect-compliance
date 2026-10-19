/**
 * #3760 — the dissenter never decides their own dissent's proposal, held by the
 * DATABASE (migration `20261019100000_agent_proposal_dissent_author_guard`).
 *
 * The usecase bar (`assertNotDissentAuthor`, 3d) fires first and writes its
 * `AUTHZ_DENIED` row; 3d's own suite covers that. This suite goes round the
 * usecase on purpose: raw writes under `app_user`, the role every request runs
 * as, so what is proved is that no code path can decide such a proposal as its
 * dissenter, including one that forgot the call.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';
import { recordWorkpaperReview } from '@/app-layer/usecases/audit-workpaper-sample-review';
import { runAuditWorkpaperSampleReview } from '@/app-layer/jobs/audit-workpaper-sample-review';
import { rejectAgentProposal, approveAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { ForbiddenError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'dissent-guard-one';
const T2 = 'dissent-guard-two';
const TENANTS = [T1, T2];
const SEED = 'test-seed-for-dissent-guard';
const HEX = 'd'.repeat(64);

type Person = 'owner' | 'second' | 'thirdA' | 'thirdB';
const PEOPLE: Person[] = ['owner', 'second', 'thirdA', 'thirdB'];
const ROLE: Record<Person, Role> = { owner: Role.OWNER, second: Role.READER, thirdA: Role.ADMIN, thirdB: Role.ADMIN };
const LINES: Partial<Record<Person, 'SECOND' | 'THIRD'>> = { second: 'SECOND', thirdA: 'THIRD', thirdB: 'THIRD' };

interface TenantFixture {
    users: Record<Person, string>;
    contexts: Record<Person, RequestContext>;
    auditorId: string;
    runId: string;
}
const fx: Record<string, TenantFixture> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
let seq = 0;

/** Run `fn` as `app_user` in `tenantId`: the role and context every request has. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.controlTestRun.deleteMany({ where: t });
    await prisma.controlTestPlan.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

async function makeWorkpaper(tenantId: string, periodLabel: string) {
    seq += 1;
    return prisma.auditWorkpaper.create({
        data: {
            tenantId,
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel,
            populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
            populationCount: 4,
            populationDigest: HEX,
            sampleEpoch: `iam.leaver_timeliness@${periodLabel}`,
            seedFingerprint: HEX,
            sampleSize: 2,
            sampledUnitIds: ['emp_1', 'emp_2'],
            attributesTested: ['L1', 'L2'],
            itemOutcomesJson: [
                { unitId: 'emp_1', outcome: 'PASS', code: null },
                { unitId: 'emp_2', outcome: 'PASS', code: null },
            ],
            exceptionsJson: [],
            exceptionCount: 0,
            conclusion: 'PASS',
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
            auditorAgentId: fx[tenantId].auditorId,
            controlTestRunId: fx[tenantId].runId,
        },
        select: { id: true },
    });
}

/**
 * A real dissent: a workpaper, drawn by the sweep, answered DISSENTED by its
 * assignee through the usecase, which raises the FINDING proposal.
 */
async function dissent(tenantId: string, periodLabel: string) {
    const wp = await makeWorkpaper(tenantId, periodLabel);
    await runAuditWorkpaperSampleReview(prisma, { tenantId, now: new Date(), seed: SEED });
    const review = await prisma.auditWorkpaperSampleReview.findFirstOrThrow({ where: { tenantId, workpaperId: wp.id } });
    const who = (Object.entries(fx[tenantId].users).find(([, id]) => id === review.assignedToUserId)?.[0] as Person) ?? null;
    if (!who) throw new Error('the review was not assigned');
    await recordWorkpaperReview(fx[tenantId].contexts[who], review.id, {
        outcome: 'DISSENTED',
        dissentCodes: ['ATTRIBUTE_NOT_TESTED'],
    });
    const answered = await prisma.auditWorkpaperSampleReview.findUniqueOrThrow({ where: { id: review.id } });
    if (!answered.findingProposalId) throw new Error('the dissent raised no proposal');
    const other: Person = who === 'thirdA' ? 'thirdB' : 'thirdA';
    return { reviewId: review.id, proposalId: answered.findingProposalId, dissenter: who, other };
}

/** A FINDING proposal written straight to the table, with the origin ref given. */
async function bareProposal(tenantId: string, ref: string | null) {
    seq += 1;
    return prisma.agentProposal.create({
        data: { id: `dag-p-${seq}`, tenantId, kind: 'FINDING', payloadJson: '{}', proposedBySessionRef: ref },
        select: { id: true },
    });
}

const decideRaw = (tenantId: string, proposalId: string, status: string, userId: string) =>
    asTenant(tenantId, (tx) =>
        tx.$executeRawUnsafe(
            `UPDATE "AgentProposal" SET "status" = $1::"SuggestionItemStatus", "reviewedByUserId" = $2, "reviewedAt" = now()
              WHERE "id" = $3`,
            status,
            userId,
            proposalId,
        ),
    );

const signRaw = (tenantId: string, proposalId: string, userId: string) =>
    asTenant(tenantId, (tx) =>
        tx.$executeRawUnsafe(
            `INSERT INTO "AgentProposalApproval" ("id", "tenantId", "proposalId", "approverUserId", "requiredApprovals")
             VALUES ($1, $2, $3, $4, 1)`,
            `dag-a-${++seq}`,
            tenantId,
            proposalId,
            userId,
        ),
    );

const statusOf = async (id: string) =>
    (await prisma.agentProposal.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const users = {} as Record<Person, string>;
        const memberships = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[who] = user.id;
            const m = await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: MembershipStatus.ACTIVE },
            });
            memberships[who] = m.id;
        }
        const contexts = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[who]);
            contexts[who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
        for (const [who, line] of Object.entries(LINES) as [Person, 'SECOND' | 'THIRD'][]) {
            await setMembershipLineOfDefence(contexts.owner, memberships[who], { lineOfDefence: line });
        }
        seq += 1;
        const sys = await prisma.aiSystem.create({ data: { tenantId, name: `dag host ${seq}`, ownerUserId: users.second } });
        const auditor = await prisma.registeredAgent.create({
            data: {
                tenantId,
                aiSystemId: sys.id,
                name: `dag auditor ${seq}`,
                autonomyLevel: 1,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: users.second,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
                isAuditor: true,
            },
        });
        const control = await prisma.control.create({ data: { tenantId, name: `dag control ${tenantId}`, createdByUserId: users.owner } });
        const plan = await prisma.controlTestPlan.create({
            data: { tenantId, controlId: control.id, name: 'Leaver timeliness', createdByUserId: users.owner },
        });
        const run = await prisma.controlTestRun.create({
            data: { tenantId, controlId: control.id, testPlanId: plan.id, createdByUserId: users.owner },
        });
        fx[tenantId] = { users, contexts, auditorId: auditor.id, runId: run.id };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the database refuses the dissenter every decision on their dissent’s proposal', () => {
    it('refuses a rejection and an acceptance written as the dissenter, and the row stays PENDING', async () => {
        const d = await dissent(T1, '2026-07');
        const dissenter = fx[T1].users[d.dissenter];
        await expect(decideRaw(T1, d.proposalId, 'REJECTED', dissenter)).rejects.toThrow(/DISSENT_AUTHOR_MAY_NOT_DECIDE/);
        await expect(decideRaw(T1, d.proposalId, 'ACCEPTED', dissenter)).rejects.toThrow(/DISSENT_AUTHOR_MAY_NOT_DECIDE/);
        await expect(decideRaw(T1, d.proposalId, 'EDITED', dissenter)).rejects.toThrow(/DISSENT_AUTHOR_MAY_NOT_DECIDE/);
        expect(await statusOf(d.proposalId)).toBe('PENDING');
    });

    it('refuses the dissenter’s approval signature', async () => {
        const d = await dissent(T1, '2026-08');
        await expect(signRaw(T1, d.proposalId, fx[T1].users[d.dissenter])).rejects.toThrow(/DISSENT_AUTHOR_MAY_NOT_DECIDE/);
        expect(await prisma.agentProposalApproval.count({ where: { proposalId: d.proposalId } })).toBe(0);
    });

    it('lets another person decide it, and leaves an ordinary proposal alone', async () => {
        const d = await dissent(T1, '2026-09');
        await decideRaw(T1, d.proposalId, 'REJECTED', fx[T1].users[d.other]);
        expect(await statusOf(d.proposalId)).toBe('REJECTED');

        const ordinary = await bareProposal(T1, null);
        await decideRaw(T1, ordinary.id, 'REJECTED', fx[T1].users.thirdA);
        expect(await statusOf(ordinary.id)).toBe('REJECTED');
    });

    it('the usecase still refuses first, by name, and the ordinary approval still works', async () => {
        const d = await dissent(T1, '2026-10');
        await expect(rejectAgentProposal(fx[T1].contexts[d.dissenter], d.proposalId)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await statusOf(d.proposalId)).toBe('PENDING');
        await approveAgentProposal(fx[T1].contexts.owner, d.proposalId);
        expect(['ACCEPTED', 'EDITED']).toContain(await statusOf(d.proposalId));
    });
});

describe('the bar cannot be stepped round', () => {
    it('a dissent’s origin ref is written once: changed or cleared, it is refused', async () => {
        const d = await dissent(T1, '2026-11');
        await expect(
            asTenant(T1, (tx) =>
                tx.$executeRawUnsafe(`UPDATE "AgentProposal" SET "proposedBySessionRef" = NULL WHERE "id" = $1`, d.proposalId),
            ),
        ).rejects.toThrow(/DISSENT_ORIGIN_IMMUTABLE/);
        await expect(
            asTenant(T1, (tx) =>
                tx.$executeRawUnsafe(
                    `UPDATE "AgentProposal" SET "proposedBySessionRef" = 'manual', "status" = 'REJECTED',
                            "reviewedByUserId" = $2 WHERE "id" = $1`,
                    d.proposalId,
                    fx[T1].users[d.dissenter],
                ),
            ),
        ).rejects.toThrow(/DISSENT_ORIGIN_IMMUTABLE/);
        expect(await statusOf(d.proposalId)).toBe('PENDING');
    });

    it('a ref naming a review this tenant does not hold refuses everybody, another tenant’s included', async () => {
        const forged = await bareProposal(T1, 'audit-workpaper-review:no-such-review');
        await expect(decideRaw(T1, forged.id, 'REJECTED', fx[T1].users.owner)).rejects.toThrow(/DISSENT_AUTHOR_UNKNOWN/);
        await expect(signRaw(T1, forged.id, fx[T1].users.owner)).rejects.toThrow(/DISSENT_AUTHOR_UNKNOWN/);

        const t2 = await dissent(T2, '2026-07');
        const crossRef = await bareProposal(T1, `audit-workpaper-review:${t2.reviewId}`);
        await expect(decideRaw(T1, crossRef.id, 'REJECTED', fx[T1].users.owner)).rejects.toThrow(/DISSENT_AUTHOR_UNKNOWN/);
        expect(await statusOf(crossRef.id)).toBe('PENDING');
    });

    it('a bare prefix is not a dissent ref, as in the usecase', async () => {
        const bare = await bareProposal(T1, 'audit-workpaper-review:');
        await decideRaw(T1, bare.id, 'REJECTED', fx[T1].users.owner);
        expect(await statusOf(bare.id)).toBe('REJECTED');
    });
});
