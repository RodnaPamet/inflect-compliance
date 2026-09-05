/**
 * TIERED REVIEW on the agent proposal queue — the four-eyes control, against a
 * real database (OWASP ASI09, human-agent trust exploitation).
 *
 * The propose-not-commit queue's entire safety claim is "a human approved it".
 * Everything below is about the gap between that sentence and what the database
 * can actually prove, because a queue that is rubber-stamped under volume is
 * WORSE than no queue: it manufactures an auditable record of consent nobody
 * gave.
 *
 * Nothing here can be established by a unit test, and that is the point of the
 * file rather than an inconvenience:
 *
 *   1. THE COUNT IS ENFORCED, not merely computed. A high-tier proposal
 *      approved by one reviewer must create NOTHING and stay PENDING.
 *   2. THE SECOND APPROVER IS NOT THE AGENT'S REGISTERED OWNER — a database
 *      trigger joining `AgentProposal.agentId` to `RegisteredAgent.ownerUserId`,
 *      which no application-layer check can be a substitute for.
 *   3. THE SECOND APPROVER IS NOT THE FIRST APPROVER. The classic four-eyes
 *      bypass, and the single most likely thing to be wrong. It is a UNIQUE
 *      INDEX, so it holds under concurrency; the concurrency case is asserted
 *      explicitly rather than assumed from the index's existence.
 *   4. THE TIER ACTUALLY TIERS. A low-tier proposal completes with ONE
 *      reviewer — otherwise "requires two" would be indistinguishable from
 *      "requires two, always", which is a different (and unshipped) product.
 *   5. ISOLATION. A signature is a record of who authorised a change inside one
 *      customer. Driven through the real usecases under two tenant contexts,
 *      plus raw reads under `app_user`.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { createAgentPolicyCard } from '@/app-layer/usecases/agent-policy-card';
import {
    approveAgentProposal,
    createAgentProposal,
    type ApproveOutcome,
} from '@/app-layer/usecases/agent-proposals';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'proposaltier-tenant-one';
const T2 = 'proposaltier-tenant-two';

/** The three humans in tenant one, by role in this story. */
const PEOPLE = ['owner', 'alice', 'bob'] as const;
type Person = (typeof PEOPLE)[number];

interface Seeded {
    users: Record<string, string>;
    aiSystemId: string;
    /** Scored HIGH — its card seeds to SECOND_APPROVER. */
    highAgentId: string;
    /** Scored LOW — its card seeds to AUTO_APPROVAL. */
    lowAgentId: string;
}
const seeded: Record<string, Seeded> = {};

/** A reviewer's context: a human with write permission and no agent binding. */
function reviewerCtx(tenantId: string, person: Person | string): RequestContext {
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].users[person],
    });
}

/** The proposing agent's context: an API-key principal bound to one agent. */
function agentCtx(tenantId: string, agentId: string): RequestContext {
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].users.owner,
        agentId,
        apiKeyId: `key-${tenantId}`,
    });
}

async function propose(tenantId: string, agentId: string, title: string): Promise<string> {
    const result = await createAgentProposal(agentCtx(tenantId, agentId), {
        kind: 'RISK',
        payload: { title },
        rationale: 'Observed during the nightly control sweep.',
        // Version 1 — every card below is freshly seeded and never edited.
        policyCardVersion: 1,
    });
    return result.id;
}

const signaturesOn = (proposalId: string) =>
    prisma.agentProposalApproval.findMany({
        where: { proposalId },
        orderBy: { createdAt: 'asc' },
    });

const risksTitled = (tenantId: string, title: string) =>
    prisma.risk.count({ where: { tenantId, title } });

const proposalStatus = async (proposalId: string) =>
    (await prisma.agentProposal.findUnique({
        where: { id: proposalId },
        select: { status: true },
    }))?.status;

/**
 * `resetDatabase` truncates a fixed table list that includes none of the agentic
 * tables, so this suite clears its own rows — otherwise it passes exactly once
 * on a fresh database and fails every re-run, and CI always starts clean, which
 * is what would hide it.
 *
 * The AuditLog / TenantMembership deletes go through `session_replication_role =
 * 'replica'`: the immutable-audit-log trigger and the last-OWNER guard both fire
 * on an ordinary DELETE and would take the teardown — and therefore the whole
 * suite — down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentProposalApproval.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.agentPolicyCardVersion.deleteMany({ where: t });
    await prisma.agentPolicyCard.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.risk.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.user.deleteMany({
        where: {
            emailHash: {
                in: [T1, T2].flatMap((t2) => PEOPLE.map((p) => hashForLookup(`${p}@${t2}.test`))),
            },
        },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: `Tenant ${id}`, slug: id } });
        const users: Record<string, string> = {};
        for (const person of PEOPLE) {
            const email = `${person}@${id}.test`;
            const user = await prisma.user.create({
                data: { email, emailHash: hashForLookup(email) },
            });
            users[person] = user.id;
            await prisma.tenantMembership.create({
                data: {
                    tenantId: id,
                    userId: user.id,
                    role: person === 'owner' ? Role.OWNER : Role.ADMIN,
                    status: MembershipStatus.ACTIVE,
                },
            });
        }
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Agent host ${id}`, ownerUserId: users.owner },
        });
        seeded[id] = { users, aiSystemId: aiSystem.id, highAgentId: '', lowAgentId: '' };
    }

    for (const id of [T1, T2]) {
        // Two agents per tenant, identical in every respect EXCEPT the scored
        // tier — so a difference in how many humans have to sign can only be
        // the tier, not some other property that happened to travel with it.
        for (const [tier, key] of [
            ['HIGH', 'highAgentId'],
            ['LOW', 'lowAgentId'],
        ] as const) {
            // ONE AiSystem PER AGENT: `RegisteredAgent.aiSystemId` is UNIQUE
            // (the register is 1:1 with the EU AI Act entry), so two agents
            // cannot share a host row.
            const host = await prisma.aiSystem.create({
                data: {
                    tenantId: id,
                    name: `${tier} agent host ${id}`,
                    ownerUserId: seeded[id].users.owner,
                },
            });
            const agent = await createRegisteredAgent(reviewerCtx(id, 'owner'), {
                aiSystemId: host.id,
                name: `${tier} agent ${id}`,
                // Below UNATTENDED_AUTONOMY (5), so the autonomy term contributes
                // no narrowing and the tier is the only thing that varies.
                autonomyLevel: 3,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: seeded[id].users.owner,
            });
            // A card is refused for an UNSCORED agent — the tier is where its
            // approval rung comes from. The scorer is exercised elsewhere; here
            // the tier is set directly so this suite is about the review.
            await prisma.registeredAgent.update({
                where: { id: agent.id },
                data: { riskTier: tier, riskTierScoredAt: new Date() },
            });
            await createAgentPolicyCard(reviewerCtx(id, 'owner'), agent.id);
            seeded[id][key] = agent.id;
        }
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the tier decides how many humans sign', () => {
    it('seeds a HIGH card at SECOND_APPROVER and a LOW card at AUTO_APPROVAL', async () => {
        // The premise every assertion below rests on. If the seeded rungs were
        // the same, "two approvers for HIGH, one for LOW" would still pass while
        // proving nothing about the tier.
        const versions = await prisma.agentPolicyCardVersion.findMany({
            where: { tenantId: T1 },
            select: { approvalRung: true, seededFromTier: true },
        });
        expect(versions).toHaveLength(2);
        expect(
            Object.fromEntries(versions.map((v) => [v.seededFromTier, v.approvalRung])),
        ).toEqual({ HIGH: 'SECOND_APPROVER', LOW: 'AUTO_APPROVAL' });
    });

    it('pins requiredApprovals onto the row: 2 for the HIGH agent, 1 for the LOW one', async () => {
        const high = await propose(T1, seeded[T1].highAgentId, 'tier-pin-high');
        const low = await propose(T1, seeded[T1].lowAgentId, 'tier-pin-low');
        const rows = await prisma.agentProposal.findMany({
            where: { id: { in: [high, low] } },
            select: { id: true, requiredApprovals: true },
        });
        expect(
            Object.fromEntries(rows.map((r) => [r.id === high ? 'high' : 'low', r.requiredApprovals])),
        ).toEqual({ high: 2, low: 1 });
    });
});

describe('a HIGH-tier proposal cannot be approved by a single reviewer', () => {
    let proposalId = '';

    beforeAll(async () => {
        proposalId = await propose(T1, seeded[T1].highAgentId, 'single-reviewer-high');
    });

    it('records the first signature and creates NOTHING', async () => {
        const outcome: ApproveOutcome = await approveAgentProposal(
            reviewerCtx(T1, 'alice'),
            proposalId,
        );
        expect(outcome.status).toBe('AWAITING_APPROVAL');
        expect(outcome.createdEntityId).toBeNull();

        // The three independent facts. The status alone would pass if the
        // usecase returned early AFTER creating the record, and the entity count
        // alone would pass if it silently swallowed the approval.
        expect(await proposalStatus(proposalId)).toBe('PENDING');
        expect(await risksTitled(T1, 'single-reviewer-high')).toBe(0);
        expect((await signaturesOn(proposalId)).map((s) => s.outcome)).toEqual(['ACCEPTED']);
    });

    it('THE SECOND APPROVER CANNOT BE THE FIRST APPROVER', async () => {
        // The classic four-eyes bypass. Enforced by the UNIQUE INDEX on
        // (tenantId, proposalId, approverUserId), which is the only place it can
        // be enforced without a read-then-write window.
        await expect(
            approveAgentProposal(reviewerCtx(T1, 'alice'), proposalId),
        ).rejects.toThrow(/agent_proposal_four_eyes/);

        expect(await signaturesOn(proposalId)).toHaveLength(1);
        expect(await proposalStatus(proposalId)).toBe('PENDING');
        expect(await risksTitled(T1, 'single-reviewer-high')).toBe(0);
    });

    it('and the refusal leaves an AUTHZ_DENIED row naming which rule refused', async () => {
        const denials = await prisma.auditLog.findMany({
            where: { tenantId: T1, entityId: proposalId, action: 'AUTHZ_DENIED' },
        });
        expect(denials).toHaveLength(1);
        expect(denials[0].detailsJson).toMatchObject({
            reason: 'agent_proposal_four_eyes',
            fourEyesRule: 'approver_already_signed',
        });
    });

    it('THE SECOND APPROVER CANNOT BE THE AGENT’S REGISTERED OWNER', async () => {
        await expect(
            approveAgentProposal(reviewerCtx(T1, 'owner'), proposalId),
        ).rejects.toThrow(/agent_proposal_four_eyes/);

        expect(await signaturesOn(proposalId)).toHaveLength(1);
        expect(await risksTitled(T1, 'single-reviewer-high')).toBe(0);
    });

    it('completes on a SECOND, DISTINCT, non-owner approver', async () => {
        // The paired positive. Without it every assertion above is satisfied by
        // a queue that simply never approves anything.
        const outcome = await approveAgentProposal(reviewerCtx(T1, 'bob'), proposalId);
        expect(outcome.status).toBe('ACCEPTED');
        expect(outcome.createdEntityId).toEqual(expect.any(String));

        expect(await proposalStatus(proposalId)).toBe('ACCEPTED');
        expect(await risksTitled(T1, 'single-reviewer-high')).toBe(1);
        const signatures = await signaturesOn(proposalId);
        expect(new Set(signatures.map((s) => s.approverUserId)).size).toBe(2);
    });
});

describe('the owner exclusion is scoped to proposals that need two', () => {
    it('refuses the owner as the FIRST approver too — it is a set property, not an ordinal one', async () => {
        // "The SECOND approver must not be the owner" is bypassed by approving
        // FIRST: insertion order is chosen by whoever clicks first. The rule is
        // therefore "the owner is not among the approvers", asserted here at the
        // position the ordinal reading would have allowed.
        const proposalId = await propose(T1, seeded[T1].highAgentId, 'owner-first-high');
        await expect(
            approveAgentProposal(reviewerCtx(T1, 'owner'), proposalId),
        ).rejects.toThrow(/agent_proposal_four_eyes/);
        expect(await signaturesOn(proposalId)).toHaveLength(0);
    });

    it('but the owner MAY be the single approver on a LOW-tier proposal', async () => {
        // A control shaped like an outage is a control people remove. The
        // register names one accountable human, and barring them everywhere
        // would leave a one-admin tenant unable to approve anything.
        const proposalId = await propose(T1, seeded[T1].lowAgentId, 'owner-single-low');
        const outcome = await approveAgentProposal(reviewerCtx(T1, 'owner'), proposalId);
        expect(outcome.status).toBe('ACCEPTED');
        expect(await risksTitled(T1, 'owner-single-low')).toBe(1);
    });
});

describe('a LOW-tier proposal approves with one reviewer', () => {
    it('creates the record on the first signature', async () => {
        const proposalId = await propose(T1, seeded[T1].lowAgentId, 'single-reviewer-low');
        const outcome = await approveAgentProposal(reviewerCtx(T1, 'alice'), proposalId);

        expect(outcome.status).toBe('ACCEPTED');
        expect(outcome.createdEntityId).toEqual(expect.any(String));
        expect(await proposalStatus(proposalId)).toBe('ACCEPTED');
        expect(await risksTitled(T1, 'single-reviewer-low')).toBe(1);
        expect(await signaturesOn(proposalId)).toHaveLength(1);
    });
});

describe('a two-approver proposal is signed as proposed', () => {
    it('refuses EDITS — two humans must sign the same content', async () => {
        // The subtle bypass: approver one signs what they read, approver two
        // approves WITH EDITS, and the record that commits is one no two people
        // ever agreed on.
        const proposalId = await propose(T1, seeded[T1].highAgentId, 'edits-refused-high');
        await expect(
            approveAgentProposal(reviewerCtx(T1, 'alice'), proposalId, { title: 'something else' }),
        ).rejects.toThrow(/approved exactly as proposed/);
        expect(await signaturesOn(proposalId)).toHaveLength(0);
    });
});

describe('the count holds under concurrency', () => {
    it('one reviewer firing two approvals at once records exactly one signature', async () => {
        // The read-then-write window this control cannot have. Both requests
        // read "no signatures yet"; the unique index is what decides.
        const proposalId = await propose(T1, seeded[T1].highAgentId, 'race-same-user');
        const ctx = reviewerCtx(T1, 'alice');
        const results = await Promise.allSettled([
            approveAgentProposal(ctx, proposalId),
            approveAgentProposal(ctx, proposalId),
        ]);

        expect(await signaturesOn(proposalId)).toHaveLength(1);
        expect(await proposalStatus(proposalId)).toBe('PENDING');
        expect(await risksTitled(T1, 'race-same-user')).toBe(0);
        // Exactly one of the two got through; the other was refused rather than
        // silently absorbed.
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('two distinct reviewers racing the DECISIVE approval create exactly one record', async () => {
        const proposalId = await propose(T1, seeded[T1].highAgentId, 'race-decisive');
        await approveAgentProposal(reviewerCtx(T1, 'alice'), proposalId);

        // `bob` and `owner` both try to complete it. The owner is refused by the
        // trigger; bob completes it. Whatever the interleaving, ONE risk.
        await Promise.allSettled([
            approveAgentProposal(reviewerCtx(T1, 'bob'), proposalId),
            approveAgentProposal(reviewerCtx(T1, 'owner'), proposalId),
        ]);

        expect(await risksTitled(T1, 'race-decisive')).toBe(1);
        expect(await proposalStatus(proposalId)).toBe('ACCEPTED');
        const signatures = await signaturesOn(proposalId);
        expect(signatures.map((s) => s.approverUserId).sort()).toEqual(
            [seeded[T1].users.alice, seeded[T1].users.bob].sort(),
        );
    });
});

describe('a signature belongs to exactly one tenant', () => {
    let t1Proposal = '';

    beforeAll(async () => {
        t1Proposal = await propose(T1, seeded[T1].highAgentId, 'isolation-high');
        await approveAgentProposal(reviewerCtx(T1, 'alice'), t1Proposal);
    });

    it("tenant B cannot approve tenant A's proposal", async () => {
        await expect(
            approveAgentProposal(reviewerCtx(T2, 'alice'), t1Proposal),
        ).rejects.toThrow(/not found/i);
        expect(await signaturesOn(t1Proposal)).toHaveLength(1);
    });

    it("tenant B's app_user session cannot READ tenant A's signatures", async () => {
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${T2}', true)`);
            return tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT "id" FROM "AgentProposalApproval"`,
            );
        });
        expect(rows).toEqual([]);
    });

    it('an app_user session with NO tenant bound reads nothing at all', async () => {
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            return tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT "id" FROM "AgentProposalApproval"`,
            );
        });
        expect(rows).toEqual([]);
    });

    it("tenant B cannot INSERT a signature carrying tenant A's id", async () => {
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
                await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${T2}', true)`);
                await tx.$executeRawUnsafe(
                    `INSERT INTO "AgentProposalApproval"
                     ("id","tenantId","proposalId","approverUserId","outcome","requiredApprovals")
                     VALUES ($1,$2,$3,$4,'ACCEPTED',2)`,
                    'forged-cross-tenant-approval',
                    T1,
                    t1Proposal,
                    seeded[T2].users.bob,
                );
            }),
        ).rejects.toThrow();
        expect(await signaturesOn(t1Proposal)).toHaveLength(1);
    });
});
