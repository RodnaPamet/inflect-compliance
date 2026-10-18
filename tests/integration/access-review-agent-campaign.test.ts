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
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
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
/** A tenant with exactly one registered agent: its preparer, and its only subject. */
const T3 = 'arc-agent-three';
const TENANTS = [T1, T2, T3];
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
    await prisma.agentKillSwitch.deleteMany({ where: t });
    await prisma.agentCircuitBreaker.deleteMany({ where: t });
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
    // The two preparing agents' read grant, given TODAY: younger than the window,
    // so it is never itself proposed for deletion.
    A.gEvA = (await grant(T1, agentA.id, AGENT_RECERTIFICATION_EVIDENCE_TOOL, new Date())).id;
    A.gEvB = (await grant(T1, agentB.id, AGENT_RECERTIFICATION_EVIDENCE_TOOL, new Date())).id;
    // Outside the population: a RETIRED agent holds no authority, a deleted one is gone.
    A.retired = (await makeAgent(T1, 'agentOwner', 'RETIRED')).id;
    const deleted = await makeAgent(T1, 'agentOwner');
    await prisma.registeredAgent.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    A.deleted = deleted.id;

    // T3: ONE agent, ACTIVE, scored and granted the read tool.
    const solo = await makeAgent(T3, 'agentOwner');
    A.solo = solo.id;
    await grant(T3, solo.id, 'list_risks', old);
    await grant(T3, solo.id, AGENT_RECERTIFICATION_EVIDENCE_TOOL, new Date());
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

afterEach(async () => {
    await clearCampaigns();
});

/** agentA prepares every pack but its own; agentB prepares agentA's. */
const create = (tenantId = T1, reviewer: Person = 'reviewer', preparers: { p?: string; c?: string } = {}) =>
    createAgentAccessReview(as(tenantId, 'owner'), {
        name: 'Q4 agent recertification',
        reviewerUserId: users[tenantId][reviewer],
        preparerAgentId: preparers.p ?? A.agentA,
        // '' leaves the cross-preparer out: a person prepares the preparer's own pack.
        crossPreparerAgentId: preparers.c === '' ? undefined : (preparers.c ?? A.agentB),
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
        // Asked BEFORE the preparers: an empty population is the first refusal,
        // whatever agents the request names.
        await expect(create(T2, 'reviewer', { p: 'none-1', c: 'none-2' })).rejects.toThrow(/^NO_SUBJECTS:/);
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
            createAgentAccessReview(as(T1, 'owner'), {
                name: 'x', reviewerUserId: users[T2].reviewer, preparerAgentId: A.agentA, crossPreparerAgentId: A.agentB,
            }),
        ).rejects.toThrow(/REVIEWER_NOT_A_MEMBER/);
    });

    it('only OWNER and ADMIN create one', async () => {
        await expect(
            createAgentAccessReview(as(T1, 'reviewer'), {
                name: 'x', reviewerUserId: users[T1].reviewer, preparerAgentId: A.agentA, crossPreparerAgentId: A.agentB,
            }),
        ).rejects.toThrow();
        expect(await prisma.accessReview.count({ where: { tenantId: T1 } })).toBe(0);
    });
});

// ─── Packs ─────────────────────────────────────────────────────────────

describe('every pack section reads stored rows only, through read tools', () => {
    it('prepares one pack per subject from agent runs of one READ and one SYNTHESIS each', async () => {
        const r = await create();
        const prepared = await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        expect(prepared.packs).toBe(2);
        // One page by the preparer (every subject but its own), one run by the
        // cross-preparer (the preparer's own pack).
        expect(prepared.runIds).toHaveLength(2);

        const runs = await prisma.workflowRun.findMany({ where: { id: { in: [...prepared.runIds] } } });
        for (const run of runs) {
            expect(run.workflowKey).toBe(AGENT_RECERTIFICATION_PACK_WORKFLOW);
            expect(run.status).toBe('COMPLETED');
            const steps = await prisma.workflowStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
            expect(steps.map((s) => [s.kind, s.toolCalled])).toEqual([
                ['READ', AGENT_RECERTIFICATION_EVIDENCE_TOOL],
                ['SYNTHESIS', null],
            ]);
        }
        // The runs proposed nothing: no proposal row exists for the tenant.
        expect(await prisma.agentProposal.count({ where: { tenantId: T1 } })).toBe(0);

        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: r.accessReviewId } });
        for (const p of packs) {
            expect(prepared.runIds).toContain(p.preparedByRunId);
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

// ─── A registered agent prepares every pack ────────────────────────────

/** A throwaway agent for a refusal, removed from the population afterwards. */
async function withAgent<T>(
    status: 'ACTIVE' | 'SUSPENDED',
    setup: (agentId: string) => Promise<void>,
    fn: (agentId: string) => Promise<T>,
): Promise<T> {
    const agent = await makeAgent(T1, 'admin2', status);
    try {
        await setup(agent.id);
        return await fn(agent.id);
    } finally {
        await prisma.agentKillSwitch.deleteMany({ where: { tenantId: T1, agentId: agent.id } });
        await prisma.agentCircuitBreaker.deleteMany({ where: { tenantId: T1, agentId: agent.id } });
        await prisma.registeredAgent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    }
}

const grantRead = (agentId: string) => grant(T1, agentId, AGENT_RECERTIFICATION_EVIDENCE_TOOL, new Date()).then(() => undefined);

/** A pack row written straight to the table, to put the database's own rules to the test. */
function forgedPack(
    accessReviewId: string,
    decisionId: string,
    agentId: string,
    over: { preparedByAgentId?: string | null; preparationBasis?: string; campaignPreparerAgentId?: string } = {},
) {
    return {
        tenantId: T1, accessReviewId, decisionId, agentId,
        preparedByRunId: 'run-x',
        preparedByAgentId: over.preparedByAgentId === undefined ? A.agentB : over.preparedByAgentId,
        preparationBasis: over.preparationBasis ?? 'AGENT_RUN',
        campaignPreparerAgentId: over.campaignPreparerAgentId ?? A.agentA,
        preparedByUserId: users[T1].owner,
        windowStart: new Date(Date.now() - 90 * DAY), windowEnd: new Date(), sectionsJson: {},
        contentHash: 'sha256:' + '0'.repeat(64),
    };
}

describe('a registered agent prepares each pack, and never its own', () => {
    it('each pack is prepared by a named agent’s run, and the run row carries that agent', async () => {
        const r = await create();
        const prepared = await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        const runs = await prisma.workflowRun.findMany({ where: { id: { in: [...prepared.runIds] } }, select: { id: true, agentId: true } });
        expect(runs.map((x) => x.agentId).sort()).toEqual([A.agentA, A.agentB].sort());

        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: r.accessReviewId } });
        const byAgent = new Map(packs.map((p) => [p.agentId, p]));
        // agentB's pack by the preparer, agentA's own by the cross-preparer.
        expect(byAgent.get(A.agentB)?.preparedByAgentId).toBe(A.agentA);
        expect(byAgent.get(A.agentA)?.preparedByAgentId).toBe(A.agentB);
        for (const p of packs) {
            expect(p.preparedByAgentId).not.toBe(p.agentId);
            const run = runs.find((x) => x.id === p.preparedByRunId);
            expect(run?.agentId).toBe(p.preparedByAgentId);
            expect(p.preparedByUserId).toBe(users[T1].owner);
        }
        const started = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'WORKFLOW_RUN_STARTED', entityId: { in: [...prepared.runIds] } },
            select: { userId: true, metadataJson: true },
        });
        expect(started).toHaveLength(2);
        for (const row of started) {
            // The person STARTED it; the run is the agent's.
            expect(row.userId).toBe(users[T1].owner);
            expect([A.agentA, A.agentB]).toContain((row.metadataJson as { agentId?: string }).agentId);
        }
    });

    it('creation refuses, by name, a missing or repeated preparer', async () => {
        const base = { name: 'x', reviewerUserId: users[T1].reviewer };
        await expect(createAgentAccessReview(as(T1, 'owner'), base)).rejects.toThrow(/^PREPARER_REQUIRED:/);
        await expect(
            createAgentAccessReview(as(T1, 'owner'), { ...base, crossPreparerAgentId: A.agentB }),
        ).rejects.toThrow(/^PREPARER_REQUIRED:/);
        await expect(
            createAgentAccessReview(as(T1, 'owner'), { ...base, preparerAgentId: A.agentA, crossPreparerAgentId: A.agentA }),
        ).rejects.toThrow(/^PREPARERS_MUST_DIFFER:/);
        await expect(create(T1, 'reviewer', { p: 'no-such-agent' })).rejects.toThrow(/^PREPARER_NOT_FOUND:/);
        await expect(create(T1, 'reviewer', { c: A.retired })).rejects.toThrow(/^PREPARER_NOT_FOUND:|^PREPARER_NOT_ACTIVE:/);
        expect(await prisma.accessReview.count({ where: { tenantId: T1 } })).toBe(0);
    });

    it('creation refuses a preparer that is not ACTIVE, unscored, killed, latched, or lacks the read grant', async () => {
        await withAgent('SUSPENDED', grantRead, (id) =>
            expect(create(T1, 'reviewer', { p: id })).rejects.toThrow(/^PREPARER_NOT_ACTIVE:/));
        await withAgent('ACTIVE', async (id) => {
            await grantRead(id);
            await prisma.registeredAgent.update({ where: { id }, data: { riskTier: null, riskTierScoredAt: null } });
        }, (id) => expect(create(T1, 'reviewer', { p: id })).rejects.toThrow(/^PREPARER_UNSCORED:/));
        await withAgent('ACTIVE', async (id) => {
            await grantRead(id);
            await prisma.agentKillSwitch.create({
                data: { tenantId: T1, agentId: id, reason: 'test', engagedByUserId: users[T1].owner },
            });
        }, (id) => expect(create(T1, 'reviewer', { c: id })).rejects.toThrow(/^PREPARER_KILL_SWITCHED:/));
        await withAgent('ACTIVE', async (id) => {
            await grantRead(id);
            await prisma.agentCircuitBreaker.create({
                data: {
                    tenantId: T1, agentId: id, state: 'OPEN',
                    trippedAt: new Date(), trippedWindow: '2026-10-18T00', trippedSignals: ['GUARD_BLOCK'],
                },
            });
        }, (id) => expect(create(T1, 'reviewer', { c: id })).rejects.toThrow(/^PREPARER_BREAKER_LATCHED:/));
        await withAgent('ACTIVE', async () => undefined, (id) =>
            expect(create(T1, 'reviewer', { p: id })).rejects.toThrow(/^PREPARER_LACKS_READ_GRANT:/));
        expect(await prisma.accessReview.count({ where: { tenantId: T1 } })).toBe(0);
    });

    it('preparation asks again: a preparer that lost its grant since creation is refused, and nothing is run', async () => {
        const r = await create();
        await prisma.registeredAgentTool.delete({ where: { id: A.gEvB } });
        try {
            await expect(prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId)).rejects.toThrow(/^PREPARER_LACKS_READ_GRANT:/);
            expect(await prisma.workflowRun.count({ where: { tenantId: T1 } })).toBe(0);
            expect(await prisma.accessReviewAgentPack.count({ where: { accessReviewId: r.accessReviewId } })).toBe(0);
        } finally {
            A.gEvB = (await grant(T1, A.agentB, AGENT_RECERTIFICATION_EVIDENCE_TOOL, new Date())).id;
        }
    });

    it('preparation is started by a person, never by a credential or an agent', async () => {
        const r = await create();
        await expect(
            prepareAgentReviewPacks({ ...as(T1, 'owner'), apiKeyId: 'key-1' }, r.accessReviewId),
        ).rejects.toThrow(/^PREPARE_REQUIRES_PERSON:/);
        await expect(
            prepareAgentReviewPacks({ ...as(T1, 'owner'), agentId: A.agentA }, r.accessReviewId),
        ).rejects.toThrow(/^PREPARE_REQUIRES_PERSON:/);
    });

    it('an agent never reads its own subject: excluded from its pages, refused when asked for', async () => {
        const r = await create();
        const asAgentA = { ...as(T1, 'owner'), agentId: A.agentA };
        const page = await readAgentRecertificationEvidence(asAgentA, r.accessReviewId, 0);
        expect(page.subjects.map((x) => x.agentId)).toEqual([A.agentB]);
        expect(page.total).toBe(1);
        await expect(
            readAgentRecertificationEvidence(asAgentA, r.accessReviewId, 0, A.agentA),
        ).rejects.toThrow(/SELF_PACK_REFUSED/);
        const cross = await readAgentRecertificationEvidence({ ...as(T1, 'owner'), agentId: A.agentB }, r.accessReviewId, 0, A.agentA);
        expect(cross.subjects.map((x) => x.agentId)).toEqual([A.agentA]);
    });

    it('the database refuses a pack prepared by the agent it describes', async () => {
        const r = await create();
        const subject = await decisionFor(r.accessReviewId, A.agentA);
        await expect(
            prisma.accessReviewAgentPack.create({
                data: forgedPack(r.accessReviewId, subject.id, A.agentA, { preparedByAgentId: A.agentA }),
            }),
        ).rejects.toThrow(/not_self_prepared/);
        await expect(
            prisma.accessReview.update({ where: { id: r.accessReviewId }, data: { crossPreparerAgentId: A.agentA } }),
        ).rejects.toThrow(/agent_preparers/);
    });

    it('the database lets a person prepare the preparer’s own pack and no other', async () => {
        const r = await create(T1, 'reviewer', { c: '' });
        const ofB = await decisionFor(r.accessReviewId, A.agentB);
        const ofA = await decisionFor(r.accessReviewId, A.agentA);
        // agentB is not the preparer: no agent-free pack for it.
        await expect(
            prisma.accessReviewAgentPack.create({
                data: forgedPack(r.accessReviewId, ofB.id, A.agentB, { preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' }),
            }),
        ).rejects.toThrow(/person_prepares_only_preparers_own/);
        // The provenance is paired: an agent-free pack cannot claim an agent run, nor the reverse.
        await expect(
            prisma.accessReviewAgentPack.create({
                data: forgedPack(r.accessReviewId, ofA.id, A.agentA, { preparedByAgentId: null, preparationBasis: 'AGENT_RUN' }),
            }),
        ).rejects.toThrow(/preparation_basis/);
        await expect(
            prisma.accessReviewAgentPack.create({
                data: forgedPack(r.accessReviewId, ofB.id, A.agentB, { preparedByAgentId: A.agentA, preparationBasis: 'PERSON_STATIC_SELF_PACK' }),
            }),
        ).rejects.toThrow(/preparation_basis/);
        // The campaign's preparer is bound by FK: a pack cannot name another one.
        await expect(
            prisma.accessReviewAgentPack.create({
                data: forgedPack(r.accessReviewId, ofB.id, A.agentB, { preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK', campaignPreparerAgentId: A.agentB }),
            }),
        ).rejects.toThrow(/campaignPreparerAgent_fkey|Foreign key/i);
        // The one exception holds.
        await expect(
            prisma.accessReviewAgentPack.create({
                data: forgedPack(r.accessReviewId, ofA.id, A.agentA, { preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' }),
            }),
        ).resolves.toBeTruthy();
    });

    it('without a cross-preparer, a person prepares the preparer’s own pack on the static path, and only that one', async () => {
        const r = await create(T1, 'reviewer', { c: '' });
        expect((await prisma.accessReview.findUniqueOrThrow({ where: { id: r.accessReviewId } })).crossPreparerAgentId).toBeNull();
        const prepared = await prepareAgentReviewPacks(as(T1, 'owner'), r.accessReviewId);
        expect(prepared.packs).toBe(2);
        const runs = await prisma.workflowRun.findMany({ where: { id: { in: [...prepared.runIds] } }, select: { id: true, agentId: true } });
        // One agent run (the preparer's page) and one person-started run with no agent.
        expect(runs.map((x) => x.agentId).sort()).toEqual([A.agentA, null].sort());

        const packs = await prisma.accessReviewAgentPack.findMany({ where: { accessReviewId: r.accessReviewId } });
        const byAgent = new Map(packs.map((p) => [p.agentId, p]));
        expect(byAgent.get(A.agentB)).toMatchObject({ preparedByAgentId: A.agentA, preparationBasis: 'AGENT_RUN' });
        expect(byAgent.get(A.agentA)).toMatchObject({ preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK', preparedByUserId: users[T1].owner });
        const ownRun = runs.find((x) => x.id === byAgent.get(A.agentA)!.preparedByRunId);
        expect(ownRun?.agentId).toBeNull();
        // The static run read through the same tool, as a step of the same workflow.
        const steps = await prisma.workflowStep.findMany({ where: { runId: ownRun!.id }, orderBy: { seq: 'asc' } });
        expect(steps.map((x) => [x.kind, x.toolCalled])).toEqual([['READ', AGENT_RECERTIFICATION_EVIDENCE_TOOL], ['SYNTHESIS', null]]);
    });

    it('the requester’s own permissions never widen what the run can read', async () => {
        // The OWNER can read every pack's evidence directly…
        const r = await create();
        expect((await readAgentRecertificationEvidence(as(T1, 'owner'), r.accessReviewId)).subjects).toHaveLength(2);
        // …but the same OWNER starting the pack run for an agent NOT granted the
        // read tool gets nothing: the call is the agent's, and its grants are
        // deny-by-default.
        await withAgent('ACTIVE', async () => undefined, async (id) => {
            const run = await startWorkflowRun({ ...as(T1, 'owner'), agentId: id }, AGENT_RECERTIFICATION_PACK_WORKFLOW, {
                accessReviewId: r.accessReviewId, page: '0', subject: '*',
            });
            expect(run.status === 'COMPLETED' && run.stepFailures === 0).toBe(false);
            const read = await prisma.workflowStep.findFirst({ where: { runId: run.runId, kind: 'READ' } });
            expect(read?.status).not.toBe('DONE');
            expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.runId } })).agentId).toBe(id);
            // The funnel's own refusal, attributed to the agent, with the OWNER's
            // role beside it: the person's authority was there and did not help.
            const denials = await prisma.auditLog.findMany({
                where: { tenantId: T1, action: 'AUTHZ_DENIED', entity: 'McpTool' },
                select: { detailsJson: true },
            });
            expect(denials.map((d) => d.detailsJson)).toContainEqual(expect.objectContaining({
                tool: AGENT_RECERTIFICATION_EVIDENCE_TOOL,
                reason: 'tool_not_granted',
                agentId: id,
                role: 'OWNER',
            }));
        });
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

// ─── A single-agent tenant ─────────────────────────────────────────────

describe('a single-agent tenant runs a campaign: its only pack is prepared by a person', () => {
    it('creates, prepares statically, decides, closes, and files evidence that says how the pack was prepared', async () => {
        const r = await createAgentAccessReview(as(T3, 'owner'), {
            name: 'Solo recertification',
            reviewerUserId: users[T3].reviewer,
            preparerAgentId: A.solo,
        });
        expect(r.subjectCount).toBe(1);

        const prepared = await prepareAgentReviewPacks(as(T3, 'owner'), r.accessReviewId);
        expect(prepared.packs).toBe(1);
        expect(prepared.runIds).toHaveLength(1);
        const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: prepared.runIds[0] } });
        expect(run.agentId).toBeNull();
        const pack = await prisma.accessReviewAgentPack.findFirstOrThrow({ where: { accessReviewId: r.accessReviewId } });
        expect(pack).toMatchObject({ agentId: A.solo, preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' });

        // The narrowing the pack proposes is decided as any other.
        for (const n of await prisma.accessReviewAgentNarrowing.findMany({ where: { accessReviewId: r.accessReviewId } })) {
            await decideAgentNarrowing(as(T3, 'reviewer'), r.accessReviewId, n.id, { outcome: 'REJECT' });
        }
        const subject = await prisma.accessReviewConnectedDecision.findFirstOrThrow({ where: { accessReviewId: r.accessReviewId } });
        await submitAgentDecision(as(T3, 'reviewer'), subject.id, { decision: 'CONFIRM' });
        const closed = await closeAgentAccessReview(as(T3, 'owner'), r.accessReviewId, new Date(), { seed: 'test-seed' });
        expect(closed.contentHash).toMatch(/^[0-9a-f]{64}$/);

        const { document, contentHash } = await recomputeAgentCampaignEvidence(as(T3, 'reviewer'), r.accessReviewId);
        expect(contentHash).toBe(closed.contentHash);
        expect(document.campaign).toMatchObject({ preparerAgentId: A.solo, crossPreparerAgentId: null });
        expect(document.subjects[0].pack).toMatchObject({ preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK' });
    });

    it('a tenant with no agent at all is still refused NO_SUBJECTS first', async () => {
        await expect(
            createAgentAccessReview(as(T2, 'owner'), { name: 'x', reviewerUserId: users[T2].reviewer, preparerAgentId: 'nobody' }),
        ).rejects.toThrow(/^NO_SUBJECTS:/);
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
