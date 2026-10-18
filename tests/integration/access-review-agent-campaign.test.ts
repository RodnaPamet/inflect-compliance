/**
 * #3674 — an AGENT recertification campaign against a real database, end to
 * end: creation over a frozen, non-empty population; reviewer packs prepared by
 * a read-only workflow run; narrowings that only delete; the owner rule;
 * one-way stamps held by the database; the zero-is-not-complete close; the
 * evidence hash that recomputes from stored rows; the sample for a second
 * human; and the new tables' tenant isolation.
 */
import { PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';
import {
    closeAgentAccessReview,
    createAgentAccessReview,
    decideAgentNarrowing,
    getAgentReviewPacks,
    prepareAgentReviewPacks,
    recomputeAgentCampaignEvidence,
    recordAgentDecisionSampleOutcome,
    submitAgentDecision,
} from '@/app-layer/usecases/access-review-agent';
import { readAgentRecertificationEvidence } from '@/app-layer/usecases/agent-recertification-evidence';
import {
    AGENT_RECERTIFICATION_EVIDENCE_TOOL,
    AGENT_RECERTIFICATION_PACK_WORKFLOW,
    NARROWING_BASIS,
    sha256Of,
} from '@/lib/agentic/agent-recertification';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'arc-agent-one';
const T2 = 'arc-agent-two';
const TENANTS = [T1, T2];
const DAY = 86_400_000;

type Person = 'owner' | 'admin2' | 'reviewer' | 'agentOwner' | 'reader';
const PEOPLE: Person[] = ['owner', 'admin2', 'reviewer', 'agentOwner', 'reader'];
const ROLE: Record<Person, Role> = {
    owner: Role.OWNER,
    admin2: Role.ADMIN,
    reviewer: Role.EDITOR,
    // An ADMIN, so the owner rule is the ONLY thing between them and a verdict
    // on their own agent: canAdmin alone would let them decide any subject.
    agentOwner: Role.ADMIN,
    reader: Role.READER,
};
const users: Record<string, Record<Person, string>> = {};
const contexts: Record<string, Record<Person, RequestContext>> = {};
const as = (tenantId: string, who: Person) => contexts[tenantId][who];
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
let seq = 0;

async function clearCampaigns(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.accessReviewDecisionSampleAudit.deleteMany({ where: t });
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.fileRecord.deleteMany({ where: t });
    await prisma.task.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await clearCampaigns();
    await prisma.agentBehaviourWindow.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
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

async function makeAgent(tenantId: string, owner: Person, status: 'ACTIVE' | 'SUSPENDED' | 'DRAFT' | 'RETIRED' = 'ACTIVE') {
    seq += 1;
    const sys = await prisma.aiSystem.create({
        data: { tenantId, name: `recert host ${seq}`, ownerUserId: users[tenantId][owner] },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `recert agent ${seq}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users[tenantId][owner],
            status,
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

async function grant(tenantId: string, agentId: string, toolName: string, createdAt: Date) {
    return prisma.registeredAgentTool.create({
        data: { tenantId, agentId, toolName, grantedByUserId: users[tenantId].owner, createdAt },
    });
}

/** Seeded once: the population every campaign in T1 freezes. */
const A: Record<string, string> = {};

beforeAll(async () => {
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        users[tenantId] = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[tenantId][who] = user.id;
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: 'ACTIVE' },
            });
        }
        contexts[tenantId] = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[tenantId][who]);
            contexts[tenantId][who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[tenantId][who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
    }

    const now = Date.now();
    const old = new Date(now - 200 * DAY);
    // agentA (owned by agentOwner): one grant never called, one called, one too young.
    const agentA = await makeAgent(T1, 'agentOwner');
    A.agentA = agentA.id;
    A.gUnused = (await grant(T1, agentA.id, 'list_risks', old)).id;
    A.gUsed = (await grant(T1, agentA.id, 'list_controls', old)).id;
    A.gRecent = (await grant(T1, agentA.id, 'list_tasks', new Date(now - 10 * DAY))).id;
    await prisma.agentBehaviourWindow.create({
        data: {
            tenantId: T1, agentId: agentA.id, readCalls: 3,
            windowStart: new Date(Math.floor((now - 5 * DAY) / 3_600_000) * 3_600_000),
            toolNames: ['list_controls'],
        },
    });
    // agentB is owned by the campaign's REVIEWER.
    const agentB = await makeAgent(T1, 'reviewer');
    A.agentB = agentB.id;
    A.gB = (await grant(T1, agentB.id, 'get_compliance_posture', old)).id;
    await prisma.agentBehaviourWindow.create({
        data: {
            tenantId: T1, agentId: agentB.id, readCalls: 1,
            windowStart: new Date(Math.floor((now - 2 * DAY) / 3_600_000) * 3_600_000),
            toolNames: ['get_compliance_posture'],
        },
    });
    // Outside the population: a RETIRED agent holds no authority, a deleted one is gone.
    A.retired = (await makeAgent(T1, 'agentOwner', 'RETIRED')).id;
    const deleted = await makeAgent(T1, 'agentOwner');
    await prisma.registeredAgent.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    A.deleted = deleted.id;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

afterEach(async () => {
    await clearCampaigns();
});

const create = (tenantId = T1, reviewer: Person = 'reviewer') =>
    createAgentAccessReview(as(tenantId, 'owner'), {
        name: 'Q4 agent recertification',
        reviewerUserId: users[tenantId][reviewer],
    });

async function decisionFor(accessReviewId: string, agentId: string) {
    return prisma.accessReviewConnectedDecision.findFirstOrThrow({ where: { accessReviewId, subjectAgentId: agentId } });
}

/** Run as `app_user` in a tenant's context — the RLS path the application takes. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

// ─── Creation ──────────────────────────────────────────────────────────

describe('a campaign over zero agents is refused at creation', () => {
    it('refuses NO_SUBJECTS in a tenant with no registered agent, and writes no campaign', async () => {
        await expect(create(T2)).rejects.toThrow(/^NO_SUBJECTS:/);
        expect(await prisma.accessReview.count({ where: { tenantId: T2 } })).toBe(0);
    });
});

describe('creation freezes the population of agents that can hold authority', () => {
    it('one subject per DRAFT/ACTIVE/SUSPENDED agent, none for a retired or deleted one', async () => {
        const r = await create();
        expect(r.subjectCount).toBe(2);
        expect(r.snapshotTruncated).toBe(false);
        expect(r.ownedByReviewer).toBe(1);
        const review = await prisma.accessReview.findUniqueOrThrow({ where: { id: r.accessReviewId } });
        expect(review.scope).toBe('AGENT');
        const rows = await prisma.accessReviewConnectedDecision.findMany({ where: { accessReviewId: r.accessReviewId } });
        expect(rows.map((d) => d.subjectAgentId).sort()).toEqual([A.agentA, A.agentB].sort());
        for (const d of rows) {
            expect(d.subjectRef).toBe(`agent:${d.subjectAgentId}`);
            expect(d.connectedAccountId).toBeNull();
            expect(d.snapshotJson).toMatchObject({ kind: 'AGENT', agentId: d.subjectAgentId });
        }
        expect((await decisionFor(r.accessReviewId, A.agentA)).subjectOwnerUserId).toBe(users[T1].agentOwner);
    });

    it('an agent registered after creation does not join the campaign', async () => {
        const r = await create();
        const late = await makeAgent(T1, 'agentOwner');
        try {
            expect(await prisma.accessReviewConnectedDecision.count({ where: { accessReviewId: r.accessReviewId } })).toBe(2);
        } finally {
            await prisma.registeredAgent.update({ where: { id: late.id }, data: { deletedAt: new Date() } });
        }
    });

    it('the reviewer must be an active member', async () => {
        await expect(
            createAgentAccessReview(as(T1, 'owner'), { name: 'x', reviewerUserId: users[T2].reviewer }),
        ).rejects.toThrow(/REVIEWER_NOT_A_MEMBER/);
    });

    it('only OWNER and ADMIN create one', async () => {
        await expect(
            createAgentAccessReview(as(T1, 'reviewer'), { name: 'x', reviewerUserId: users[T1].reviewer }),
        ).rejects.toThrow();
        expect(await prisma.accessReview.count({ where: { tenantId: T1 } })).toBe(0);
    });
});

// ─── Packs ─────────────────────────────────────────────────────────────

describe('every pack section reads stored rows only, through read tools', () => {
    it('prepares one pack per subject from a workflow run of one READ and one SYNTHESIS', async () => {
        const r = await create();
        const prepared = await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        expect(prepared.packs).toBe(2);
        expect(prepared.runIds).toHaveLength(1);

        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: prepared.runIds[0] } });
        expect(run.workflowKey).toBe(AGENT_RECERTIFICATION_PACK_WORKFLOW);
        expect(run.status).toBe('COMPLETED');
        const steps = await prisma.workflowStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
        expect(steps.map((s) => [s.kind, s.toolCalled])).toEqual([
            ['READ', AGENT_RECERTIFICATION_EVIDENCE_TOOL],
            ['SYNTHESIS', null],
        ]);
        // The run proposed nothing: no proposal row exists for the tenant.
        expect(await prisma.agentProposal.count({ where: { tenantId: T1 } })).toBe(0);

        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: r.accessReviewId } });
        for (const p of packs) {
            expect(p.preparedByRunId).toBe(run.id);
            // The stored hash is the hash of the stored sections.
            expect(p.contentHash).toBe(sha256Of(p.sectionsJson));
        }
        const packA = packs.find((p) => p.agentId === A.agentA)!;
        const sections = packA.sectionsJson as { grants: Array<{ grantId: string; lastCalledAt: string | null; heldForWholeWindow: boolean }> };
        const byId = new Map(sections.grants.map((g) => [g.grantId, g]));
        expect(byId.get(A.gUnused)).toMatchObject({ lastCalledAt: null, heldForWholeWindow: true });
        expect(byId.get(A.gUsed)?.lastCalledAt).not.toBeNull();
        expect(byId.get(A.gRecent)).toMatchObject({ heldForWholeWindow: false });
    });

    it('proposes exactly the narrowing the evidence supports — the grant held all window and never called', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const narrowings = await prisma.accessReviewAgentNarrowing.findMany({ where: { accessReviewId: r.accessReviewId } });
        expect(narrowings.map((n) => [n.agentId, n.grantId, n.toolName, n.basis, n.outcome])).toEqual([
            [A.agentA, A.gUnused, 'list_risks', NARROWING_BASIS, 'PENDING'],
        ]);
        expect(narrowings[0].subjectOwnerUserId).toBe(users[T1].agentOwner);
    });

    it('packs are written once', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await expect(prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId)).rejects.toThrow(/PACKS_ALREADY_PREPARED/);
        expect(await prisma.accessReviewAgentPack.count({ where: { accessReviewId: r.accessReviewId } })).toBe(2);
    });

    it('a pack is readable by the reviewer and a register reader, and by nobody else', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await expect(getAgentReviewPacks(as(T1, 'reader'), r.accessReviewId)).rejects.toThrow(/admin\.agent_registry/);
        await expect(readAgentRecertificationEvidence(as(T1, 'reader'), r.accessReviewId)).rejects.toThrow(/admin\.agent_registry/);
        expect((await getAgentReviewPacks(as(T1, 'reviewer'), r.accessReviewId)).packs).toHaveLength(2);
        expect((await getAgentReviewPacks(as(T1, 'admin2'), r.accessReviewId)).packs).toHaveLength(2);
    });
});

// ─── The owner rule ────────────────────────────────────────────────────

describe('an agent’s owner cannot decide a subject for their own agent', () => {
    it('refuses the owner — an ADMIN — with a 403 and an AUTHZ_DENIED row, and records nothing', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const subject = await decisionFor(r.accessReviewId, A.agentA);
        const narrowing = await prisma.accessReviewAgentNarrowing.findFirstOrThrow({ where: { decisionId: subject.id } });

        await expect(
            decideAgentNarrowing(as(T1, 'agentOwner'), r.accessReviewId, narrowing.id, { outcome: 'REJECT' }),
        ).rejects.toThrow(/agent_owner_cannot_decide/);
        await expect(
            submitAgentDecision(as(T1, 'agentOwner'), subject.id, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/agent_owner_cannot_decide/);

        expect((await prisma.accessReviewAgentNarrowing.findUniqueOrThrow({ where: { id: narrowing.id } })).outcome).toBe('PENDING');
        expect((await prisma.accessReviewConnectedDecision.findUniqueOrThrow({ where: { id: subject.id } })).decision).toBeNull();
        const denied = await prisma.auditLog.count({
            where: { tenantId: T1, userId: users[T1].agentOwner, action: 'AUTHZ_DENIED' },
        });
        expect(denied).toBeGreaterThanOrEqual(2);
    });

    it('refuses the assigned reviewer on the agent THEY own, and lets another admin decide it', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const subjectB = await decisionFor(r.accessReviewId, A.agentB);
        await expect(
            submitAgentDecision(as(T1, 'reviewer'), subjectB.id, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/agent_owner_cannot_decide/);
        await expect(
            submitAgentDecision(as(T1, 'admin2'), subjectB.id, { decision: 'CONFIRM' }),
        ).resolves.toMatchObject({ decision: 'CONFIRM' });
    });

    it('refuses the CURRENT owner too, after the agent changed hands', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const subjectA = await decisionFor(r.accessReviewId, A.agentA);
        await prisma.registeredAgent.update({ where: { id: A.agentA }, data: { ownerUserId: users[T1].admin2 } });
        try {
            await expect(
                submitAgentDecision(as(T1, 'admin2'), subjectA.id, { decision: 'CONFIRM' }),
            ).rejects.toThrow(/agent_owner_cannot_decide/);
        } finally {
            await prisma.registeredAgent.update({ where: { id: A.agentA }, data: { ownerUserId: users[T1].agentOwner } });
        }
    });

    it('the database refuses the frozen owner as decider, for any writer', async () => {
        const r = await create();
        const subjectA = await decisionFor(r.accessReviewId, A.agentA);
        await expect(
            prisma.accessReviewConnectedDecision.update({
                where: { id: subjectA.id },
                data: { decision: 'CONFIRM', decidedAt: new Date(), decidedByUserId: users[T1].agentOwner },
            }),
        ).rejects.toThrow(/owner_not_decider/);
    });
});

// ─── Narrowings ────────────────────────────────────────────────────────

describe('accepting a narrowing deletes the grant; no campaign path can add a grant or raise a card', () => {
    it('a subject waits for its narrowings', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const subjectA = await decisionFor(r.accessReviewId, A.agentA);
        await expect(
            submitAgentDecision(as(T1, 'reviewer'), subjectA.id, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/NARROWINGS_PENDING/);
    });

    it('a subject waits for its pack', async () => {
        const r = await create();
        const subjectA = await decisionFor(r.accessReviewId, A.agentA);
        await expect(
            submitAgentDecision(as(T1, 'reviewer'), subjectA.id, { decision: 'CONFIRM' }),
        ).rejects.toThrow(/PACKS_NOT_PREPARED/);
    });

    it('ACCEPT deletes exactly the named grant, stamps the result and audits the revoke; nothing else moves', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const subjectA = await decisionFor(r.accessReviewId, A.agentA);
        const narrowing = await prisma.accessReviewAgentNarrowing.findFirstOrThrow({ where: { decisionId: subjectA.id } });
        const grantsBefore = await prisma.registeredAgentTool.findMany({ where: { tenantId: T1 }, select: { id: true }, orderBy: { id: 'asc' } });
        const cardsBefore = await prisma.agentPolicyCardVersion.count({ where: { tenantId: T1 } });

        try {
            const out = await decideAgentNarrowing(as(T1, 'reviewer'), r.accessReviewId, narrowing.id, { outcome: 'ACCEPT' });
            expect(out).toMatchObject({ outcome: 'ACCEPTED', executionResult: 'GRANT_DELETED' });

            const grantsAfter = await prisma.registeredAgentTool.findMany({ where: { tenantId: T1 }, select: { id: true }, orderBy: { id: 'asc' } });
            expect(grantsAfter.map((g) => g.id)).toEqual(grantsBefore.map((g) => g.id).filter((id) => id !== A.gUnused));
            expect(await prisma.agentPolicyCardVersion.count({ where: { tenantId: T1 } })).toBe(cardsBefore);

            const row = await prisma.accessReviewAgentNarrowing.findUniqueOrThrow({ where: { id: narrowing.id } });
            expect(row).toMatchObject({ outcome: 'ACCEPTED', decidedByUserId: users[T1].reviewer, executionResult: 'GRANT_DELETED' });
            expect(row.executedAt).not.toBeNull();
            expect(await prisma.auditLog.count({
                where: { tenantId: T1, action: 'AGENT_TOOL_REVOKED', entityId: A.agentA },
            })).toBe(1);

            // A second answer is refused, by the usecase and by the database.
            await expect(
                decideAgentNarrowing(as(T1, 'reviewer'), r.accessReviewId, narrowing.id, { outcome: 'REJECT' }),
            ).rejects.toThrow(/ALREADY_DECIDED/);
            await expect(
                prisma.accessReviewAgentNarrowing.update({ where: { id: narrowing.id }, data: { outcome: 'REJECTED' } }),
            ).rejects.toThrow(/ACCESS_REVIEW_NARROWING_STAMPED/);
        } finally {
            await grant(T1, A.agentA, 'list_risks', new Date(Date.now() - 200 * DAY)).then((g) => { A.gUnused = g.id; });
        }
    });

    it('REJECT keeps the grant', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const narrowing = await prisma.accessReviewAgentNarrowing.findFirstOrThrow({ where: { accessReviewId: r.accessReviewId } });
        const out = await decideAgentNarrowing(as(T1, 'reviewer'), r.accessReviewId, narrowing.id, { outcome: 'REJECT' });
        expect(out).toMatchObject({ outcome: 'REJECTED', executionResult: null });
        expect(await prisma.registeredAgentTool.count({ where: { id: narrowing.grantId } })).toBe(1);
    });

    it('a narrowing is answered only inside its own campaign', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const narrowing = await prisma.accessReviewAgentNarrowing.findFirstOrThrow({ where: { accessReviewId: r.accessReviewId } });
        await expect(
            decideAgentNarrowing(as(T1, 'reviewer'), 'another-campaign', narrowing.id, { outcome: 'ACCEPT' }),
        ).rejects.toThrow(/not found/i);
    });
});

// ─── One-way stamps ────────────────────────────────────────────────────

describe('decisions are one-way stamps, refused on change by the database', () => {
    it('a recorded verdict cannot be changed, and a subject cannot be re-pointed', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const subjectB = await decisionFor(r.accessReviewId, A.agentB);
        await submitAgentDecision(as(T1, 'admin2'), subjectB.id, { decision: 'CONFIRM' });

        await expect(
            prisma.accessReviewConnectedDecision.update({ where: { id: subjectB.id }, data: { decision: 'REVOKE' } }),
        ).rejects.toThrow(/ACCESS_REVIEW_DECISION_STAMPED/);
        await expect(
            prisma.accessReviewConnectedDecision.update({ where: { id: subjectB.id }, data: { subjectAgentId: A.agentA } }),
        ).rejects.toThrow(/ACCESS_REVIEW_SUBJECT_FROZEN/);
        await expect(
            submitAgentDecision(as(T1, 'owner'), subjectB.id, { decision: 'REVOKE' }),
        ).rejects.toThrow(/ALREADY_DECIDED/);
    });

    it('a pack is never edited', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const pack = await prisma.accessReviewAgentPack.findFirstOrThrow({ where: { accessReviewId: r.accessReviewId } });
        await expect(
            prisma.accessReviewAgentPack.update({ where: { id: pack.id }, data: { contentHash: 'sha256:' + '0'.repeat(64) } }),
        ).rejects.toThrow(/ACCESS_REVIEW_PACK_IMMUTABLE/);
    });

    it('app_user may not delete a pack, a narrowing or a sample', async () => {
        for (const table of ['AccessReviewAgentPack', 'AccessReviewAgentNarrowing', 'AccessReviewDecisionSampleAudit']) {
            await expect(
                asTenant(T1, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = '${T1}'`)),
            ).rejects.toThrow(/permission denied/);
        }
    });
});

// ─── The close ─────────────────────────────────────────────────────────

async function decideEverything(accessReviewId: string): Promise<void> {
    for (const n of await prisma.accessReviewAgentNarrowing.findMany({ where: { accessReviewId, outcome: 'PENDING' } })) {
        await decideAgentNarrowing(as(T1, 'reviewer'), accessReviewId, n.id, { outcome: 'REJECT' });
    }
    await submitAgentDecision(as(T1, 'reviewer'), (await decisionFor(accessReviewId, A.agentA)).id, { decision: 'REVOKE', notes: 'unused' });
    await submitAgentDecision(as(T1, 'admin2'), (await decisionFor(accessReviewId, A.agentB)).id, { decision: 'CONFIRM' });
}

describe('the close requires subjectCount > 0 && decided === subjectCount', () => {
    it('refuses while any subject is undecided, and leaves the campaign open', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await submitAgentDecision(as(T1, 'admin2'), (await decisionFor(r.accessReviewId, A.agentB)).id, { decision: 'CONFIRM' });
        await expect(closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId)).rejects.toThrow(/SUBJECTS_PENDING: 1 of 2/);
        expect((await prisma.accessReview.findUniqueOrThrow({ where: { id: r.accessReviewId } })).status).not.toBe('CLOSED');
    });

    it('refuses a campaign whose population is empty — zero decided of zero is not complete', async () => {
        const r = await create();
        // Creation refuses an empty population, so empty it behind the
        // application's back: the close must not trust that it never happens.
        await prisma.accessReviewConnectedDecision.deleteMany({ where: { accessReviewId: r.accessReviewId } });
        await expect(closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId)).rejects.toThrow(/^NO_SUBJECTS:/);
        const review = await prisma.accessReview.findUniqueOrThrow({ where: { id: r.accessReviewId } });
        expect(review.status).toBe('OPEN');
        expect(review.evidenceFileRecordId).toBeNull();
    });

    it('closes a fully decided campaign: remediation for REVOKE, a sample, and evidence whose hash recomputes', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await decideEverything(r.accessReviewId);

        const closed = await closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId, new Date(), { seed: 'test-seed' });
        expect(closed.subjectCount).toBe(2);
        expect(closed.remediationTasks).toBe(1);
        expect(closed.sampled).toBeGreaterThanOrEqual(1);
        expect(closed.contentHash).toMatch(/^[0-9a-f]{64}$/);

        const review = await prisma.accessReview.findUniqueOrThrow({ where: { id: r.accessReviewId } });
        expect(review.status).toBe('CLOSED');
        expect(review.evidenceFileRecordId).toBe(closed.evidenceFileRecordId);
        const file = await prisma.fileRecord.findUniqueOrThrow({ where: { id: closed.evidenceFileRecordId! } });
        expect(file.sha256).toBe(closed.contentHash);

        // One task, for the REVOKE; its wording (act in the agent register) is
        // `remediationDescription`'s and is unit-tested there — the column is
        // encrypted at rest, so the raw test client reads ciphertext.
        const tasks = await prisma.task.findMany({ where: { tenantId: T1 }, select: { title: true } });
        expect(tasks.map((x) => x.title)).toEqual([`Recertification: REVOKE agent:${A.agentA}`]);

        const recomputed = await recomputeAgentCampaignEvidence(as(T1, 'reviewer'), r.accessReviewId);
        expect(recomputed.contentHash).toBe(closed.contentHash);
        expect(recomputed.document.subjectCount).toBe(2);
        const read = await getAgentReviewPacks(as(T1, 'admin2'), r.accessReviewId);
        expect(read.evidence).toMatchObject({ storedSha256: closed.contentHash, recomputedSha256: closed.contentHash, matches: true });
    });

    it('a stored row edited behind the stamps no longer recomputes to the stored hash', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await decideEverything(r.accessReviewId);
        const closed = await closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId, new Date(), { seed: 'test-seed' });

        // Only a writer that switches the triggers off can do this — which is
        // the point: the hash is what tells an auditor it happened.
        const subjectA = await decisionFor(r.accessReviewId, A.agentA);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`UPDATE "AccessReviewConnectedDecision" SET "decision" = 'CONFIRM' WHERE "id" = $1`, subjectA.id);
        });
        const read = await getAgentReviewPacks(as(T1, 'admin2'), r.accessReviewId);
        expect(read.evidence?.storedSha256).toBe(closed.contentHash);
        expect(read.evidence?.matches).toBe(false);
    });
});

// ─── The second human ──────────────────────────────────────────────────

describe('a sample of decisions is drawn for a second human', () => {
    it('refuses the first decider and the agent’s owner; another reader answers once', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await decideEverything(r.accessReviewId);
        await closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId, new Date(), { seed: 'test-seed' });

        const samples = await prisma.accessReviewDecisionSampleAudit.findMany({ where: { accessReviewId: r.accessReviewId } });
        expect(samples.length).toBeGreaterThanOrEqual(1);
        const sample = samples[0];
        expect(sample.samplingEpoch).toMatch(new RegExp(`^${r.accessReviewId}@\\d{4}-\\d{2}-\\d{2}$`));
        const decision = await prisma.accessReviewConnectedDecision.findUniqueOrThrow({ where: { id: sample.decisionId } });

        const decider = PEOPLE.find((p) => users[T1][p] === decision.decidedByUserId)!;
        await expect(
            recordAgentDecisionSampleOutcome(as(T1, decider), r.accessReviewId, sample.id, { outcome: 'CONCURRED' }),
        ).rejects.toThrow(/sample_audit_self_review/);
        const owner = PEOPLE.find((p) => users[T1][p] === decision.subjectOwnerUserId)!;
        if (owner !== decider) {
            await expect(
                recordAgentDecisionSampleOutcome(as(T1, owner), r.accessReviewId, sample.id, { outcome: 'CONCURRED' }),
            ).rejects.toThrow(/agent_owner_cannot_review|sample_audit_self_review/);
        }
        await expect(
            recordAgentDecisionSampleOutcome(as(T1, 'reader'), r.accessReviewId, sample.id, { outcome: 'CONCURRED' }),
        ).rejects.toThrow(/admin\.agent_registry/);

        await expect(
            recordAgentDecisionSampleOutcome(as(T1, 'owner'), r.accessReviewId, sample.id, {
                outcome: 'DISSENTED', dissentCodes: ['DECISION_NOT_SUPPORTED_BY_PACK'],
            }),
        ).resolves.toMatchObject({ outcome: 'DISSENTED' });
        await expect(
            prisma.accessReviewDecisionSampleAudit.update({ where: { id: sample.id }, data: { outcome: 'CONCURRED' } }),
        ).rejects.toThrow(/ACCESS_REVIEW_SAMPLE_STAMPED/);
    });

    it('the same seed and campaign draw the same sample — the sampler is keyed, not random', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await decideEverything(r.accessReviewId);
        const at = new Date();
        await closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId, at, { seed: 'test-seed' });
        const drawn = (await prisma.accessReviewDecisionSampleAudit.findMany({ where: { accessReviewId: r.accessReviewId } }))
            .map((s) => s.decisionId).sort();
        const { selectSample, sampleSizeFor, samplingEpochFor } = await import('@/lib/agentic/proposal-sampling');
        const decisions = await prisma.accessReviewConnectedDecision.findMany({ where: { accessReviewId: r.accessReviewId }, orderBy: { subjectRef: 'asc' } });
        const expected = selectSample(decisions.map((d) => ({ id: d.id })), {
            seed: 'test-seed', epoch: `${r.accessReviewId}@${samplingEpochFor(at)}`, count: sampleSizeFor(decisions.length),
        }).map((d) => d.id).sort();
        expect(drawn).toEqual(expected);
    });
});

// ─── Tenant isolation ──────────────────────────────────────────────────

describe('the new tables are tenant-isolated by row-level security', () => {
    it('another tenant’s context reads none of a campaign’s packs, narrowings or samples, and cannot insert into them', async () => {
        const r = await create();
        await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        await decideEverything(r.accessReviewId);
        await closeAgentAccessReview(as(T1, 'owner'), r.accessReviewId, new Date(), { seed: 'test-seed' });

        const counts = (tx: PrismaClient) => Promise.all([
            tx.accessReviewAgentPack.count({ where: { accessReviewId: r.accessReviewId } }),
            tx.accessReviewAgentNarrowing.count({ where: { accessReviewId: r.accessReviewId } }),
            tx.accessReviewDecisionSampleAudit.count({ where: { accessReviewId: r.accessReviewId } }),
        ]);
        const own = await asTenant(T1, counts);
        expect(own[0]).toBe(2);
        expect(own[1]).toBe(1);
        expect(own[2]).toBeGreaterThanOrEqual(1);
        expect(await asTenant(T2, counts)).toEqual([0, 0, 0]);

        const pack = await prisma.accessReviewAgentPack.findFirstOrThrow({ where: { accessReviewId: r.accessReviewId } });
        await expect(
            asTenant(T2, (tx) => tx.accessReviewDecisionSampleAudit.create({
                data: {
                    tenantId: T1, accessReviewId: r.accessReviewId, decisionId: pack.decisionId,
                    samplingEpoch: 'forged', sampledAt: new Date(),
                },
            })),
        ).rejects.toThrow();
    });

    it('a T2 caller cannot read a T1 campaign through the usecases', async () => {
        const r = await create();
        await expect(getAgentReviewPacks(as(T2, 'owner'), r.accessReviewId)).rejects.toThrow(/not found/i);
        await expect(prepareAgentReviewPacks(as(T2, 'owner'), r.accessReviewId)).rejects.toThrow(/not found/i);
    });
});
