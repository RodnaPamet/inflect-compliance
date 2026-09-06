/**
 * AN APPROVAL IS EVIDENCE, SO IT CANNOT BE EDITED (EU AI Act Art 14).
 *
 * `AgentProposalApproval` records which human signed off an agent's proposed
 * change. If that row can be rewritten afterwards then it is not a record of a
 * decision, it is a claim about the past that the present can revise — and the
 * whole propose-not-commit story rests on it. The discipline mirrored here is
 * `AiDecisionLog`'s, column for column: every column frozen, and ONE one-way
 * transition out of PENDING.
 *
 * ── WHY THE ASSERTIONS ARE RAW SQL AND NOT USECASE CALLS ─────────────
 *
 * A usecase-level check answers "does the usecase edit approvals?", which is not
 * the question. Any other write path — a script, a migration, a future bulk
 * action, a repository method somebody adds next month — walks straight past it.
 * So every refusal below is asserted against a direct write, and against the
 * PRIVILEGED session specifically: `app_user` holds no UPDATE privilege at all,
 * so a test that only drove `app_user` would pass identically whether the
 * trigger existed or not.
 *
 * BOTH HALVES ARE ASSERTED — the privilege and the trigger — for the reason
 * `policy-card-isolation.test.ts` states for the version table: either alone
 * would leave the other's absence invisible.
 *
 * ── AND ONE LEVEL UP ────────────────────────────────────────────────
 *
 * `AgentProposal.requiredApprovals` is the number the four-eyes trigger reads.
 * A requirement that can be lowered after the fact retires both halves of the
 * rule while the queue goes on looking tiered, so its write-once trigger is
 * asserted here too.
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
} from '@/app-layer/usecases/agent-proposals';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'proposalimmutable-tenant';
const PEOPLE = ['owner', 'alice', 'bob'] as const;

const users: Record<string, string> = {};
let highAgentId = '';
let lowAgentId = '';

const ctxFor = (person: string) =>
    makeRequestContext('ADMIN', { tenantId: T, tenantSlug: T, userId: users[person] });

const agentCtx = (agentId: string) =>
    makeRequestContext('ADMIN', {
        tenantId: T,
        tenantSlug: T,
        userId: users.owner,
        agentId,
        apiKeyId: `key-${T}`,
    });

async function propose(agentId: string, title: string): Promise<string> {
    const result = await createAgentProposal(agentCtx(agentId), {
        kind: 'RISK',
        payload: { title },
        rationale: 'Raised by the overnight sweep.',
        policyCardVersion: 1,
    });
    return result.id;
}

/** A raw statement as the PRIVILEGED (non-`app_user`) session — no RLS, full grants. */
const raw = (sql: string, ...args: unknown[]) => prisma.$executeRawUnsafe(sql, ...args);

/** The same, as `app_user` bound to this tenant — what a real request looks like. */
function asTenant<T2>(fn: (tx: PrismaClient) => Promise<T2>): Promise<T2> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${T}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
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
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, T);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: PEOPLE.map((p) => hashForLookup(`${p}@${T}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    await prisma.tenant.create({ data: { id: T, name: 'Immutability tenant', slug: T } });
    for (const person of PEOPLE) {
        const email = `${person}@${T}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[person] = user.id;
        await prisma.tenantMembership.create({
            data: {
                tenantId: T,
                userId: user.id,
                role: person === 'owner' ? Role.OWNER : Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
        });
    }
    for (const [tier, isHigh] of [
        ['HIGH', true],
        ['LOW', false],
    ] as const) {
        // ONE AiSystem PER AGENT — `RegisteredAgent.aiSystemId` is UNIQUE.
        const host = await prisma.aiSystem.create({
            data: { tenantId: T, name: `${tier} agent host`, ownerUserId: users.owner },
        });
        const agent = await createRegisteredAgent(ctxFor('owner'), {
            aiSystemId: host.id,
            name: `${tier} agent`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users.owner,
        });
        await prisma.registeredAgent.update({
            where: { id: agent.id },
            data: { riskTier: tier, riskTierScoredAt: new Date() },
        });
        await createAgentPolicyCard(ctxFor('owner'), agent.id);
        if (isHigh) highAgentId = agent.id;
        else lowAgentId = agent.id;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the everyday path cannot touch a recorded approval', () => {
    it('app_user holds neither UPDATE nor DELETE on AgentProposalApproval', async () => {
        // The privilege half. Without it the trigger is the only line of
        // defence, and a trigger can be dropped by a migration nobody reads.
        const [privs] = await prisma.$queryRawUnsafe<
            { canUpdate: boolean; canDelete: boolean; canInsert: boolean; canSelect: boolean }[]
        >(
            `SELECT has_table_privilege('app_user', '"AgentProposalApproval"', 'UPDATE') AS "canUpdate",
                    has_table_privilege('app_user', '"AgentProposalApproval"', 'DELETE') AS "canDelete",
                    has_table_privilege('app_user', '"AgentProposalApproval"', 'INSERT') AS "canInsert",
                    has_table_privilege('app_user', '"AgentProposalApproval"', 'SELECT') AS "canSelect"`,
        );
        // Stated as the whole grant, not just the two negatives: an assertion
        // that only checked UPDATE/DELETE would also pass on a table `app_user`
        // cannot write at all, which would be a broken product rather than a
        // hardened one.
        expect(privs).toEqual({
            canUpdate: false,
            canDelete: false,
            canInsert: true,
            canSelect: true,
        });
    });

    it('so an ordinary tenant session cannot even attempt the write', async () => {
        const proposalId = await propose(lowAgentId, 'privilege-probe');
        await approveAgentProposal(ctxFor('alice'), proposalId);
        const [signature] = await prisma.agentProposalApproval.findMany({ where: { proposalId } });

        await expect(
            asTenant((tx) =>
                tx.$executeRawUnsafe(
                    `UPDATE "AgentProposalApproval" SET "outcome" = 'REJECTED' WHERE "id" = $1`,
                    signature.id,
                ),
            ),
        ).rejects.toThrow(/permission denied/i);

        await expect(
            asTenant((tx) =>
                tx.$executeRawUnsafe(
                    `DELETE FROM "AgentProposalApproval" WHERE "id" = $1`,
                    signature.id,
                ),
            ),
        ).rejects.toThrow(/permission denied/i);
    });
});

describe('the TRIGGER refuses a raw write from a privileged session', () => {
    let signatureId = '';

    beforeAll(async () => {
        const proposalId = await propose(lowAgentId, 'trigger-probe');
        await approveAgentProposal(ctxFor('alice'), proposalId);
        const [signature] = await prisma.agentProposalApproval.findMany({ where: { proposalId } });
        signatureId = signature.id;
    });

    it('an approved outcome cannot be revised', async () => {
        await expect(
            raw(`UPDATE "AgentProposalApproval" SET "outcome" = 'REJECTED' WHERE "id" = $1`, signatureId),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROPOSAL_APPROVAL/);

        const after = await prisma.agentProposalApproval.findUnique({ where: { id: signatureId } });
        expect(after?.outcome).toBe('ACCEPTED');
    });

    it('and neither can WHO signed it', async () => {
        // The half a "one-way outcome" trigger is easiest to ship without. An
        // approval whose approver can be rewritten satisfies every count in the
        // product while naming the wrong human.
        await expect(
            raw(
                `UPDATE "AgentProposalApproval" SET "approverUserId" = $2 WHERE "id" = $1`,
                signatureId,
                users.bob,
            ),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROPOSAL_APPROVAL/);

        const after = await prisma.agentProposalApproval.findUnique({ where: { id: signatureId } });
        expect(after?.approverUserId).toBe(users.alice);
    });

    it('nor the requirement it was signed against, nor when it happened', async () => {
        // 2, not 1: this signature was recorded against a LOW-tier proposal that
        // required ONE approver, so writing 1 is a no-op and would pass a
        // trigger that did nothing at all. The first draft of this assertion did
        // exactly that and went green.
        await expect(
            raw(`UPDATE "AgentProposalApproval" SET "requiredApprovals" = 2 WHERE "id" = $1`, signatureId),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROPOSAL_APPROVAL/);
        await expect(
            raw(
                `UPDATE "AgentProposalApproval" SET "createdAt" = NOW() - INTERVAL '30 days' WHERE "id" = $1`,
                signatureId,
            ),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROPOSAL_APPROVAL/);
    });

    it('a NO-OP update is permitted — the trigger refuses CHANGE, not writes', async () => {
        // The paired positive. A trigger that raised on every UPDATE would pass
        // all three assertions above while making the one-way stamp below
        // impossible, so "it threw" is not on its own the property under test.
        await expect(
            raw(`UPDATE "AgentProposalApproval" SET "outcome" = 'ACCEPTED' WHERE "id" = $1`, signatureId),
        ).resolves.toBeDefined();
    });
});

describe('the ONE permitted transition is one-way and happens once', () => {
    const pendingId = 'immutability-pending-signature';
    let proposalId = '';

    beforeAll(async () => {
        proposalId = await propose(highAgentId, 'one-way-stamp');
        // Written directly at the DEFAULT outcome. Nothing in the product writes
        // a PENDING signature today — the default exists so that a writer which
        // never stated an outcome grants nothing, and this is the assertion that
        // the reserved state behaves as declared rather than as an accident.
        await raw(
            `INSERT INTO "AgentProposalApproval"
                 ("id","tenantId","proposalId","approverUserId","requiredApprovals")
             VALUES ($1,$2,$3,$4,2)`,
            pendingId,
            T,
            proposalId,
            users.alice,
        );
    });

    it('a PENDING signature counts for nothing', async () => {
        // The load-bearing half of the default. A HIGH proposal needs two
        // signatures; this row is not one of them, so `bob` approving must NOT
        // complete it.
        const outcome = await approveAgentProposal(ctxFor('bob'), proposalId);
        expect(outcome.status).toBe('AWAITING_APPROVAL');
        expect(outcome.createdEntityId).toBeNull();
        expect(await prisma.risk.count({ where: { tenantId: T, title: 'one-way-stamp' } })).toBe(0);
    });

    it('may leave PENDING exactly once', async () => {
        await expect(
            raw(`UPDATE "AgentProposalApproval" SET "outcome" = 'ACCEPTED' WHERE "id" = $1`, pendingId),
        ).resolves.toBeDefined();
        const after = await prisma.agentProposalApproval.findUnique({ where: { id: pendingId } });
        expect(after?.outcome).toBe('ACCEPTED');
    });

    it('and never again', async () => {
        await expect(
            raw(`UPDATE "AgentProposalApproval" SET "outcome" = 'REJECTED' WHERE "id" = $1`, pendingId),
        ).rejects.toThrow(/already recorded/);
    });

    it('and the transition cannot smuggle another column with it', async () => {
        const secondPendingId = 'immutability-pending-signature-2';
        await raw(
            `INSERT INTO "AgentProposalApproval"
                 ("id","tenantId","proposalId","approverUserId","requiredApprovals")
             VALUES ($1,$2,$3,$4,2)`,
            secondPendingId,
            T,
            proposalId,
            users.owner,
        );
        await expect(
            raw(
                `UPDATE "AgentProposalApproval"
                    SET "outcome" = 'ACCEPTED', "approverUserId" = $2
                  WHERE "id" = $1`,
                secondPendingId,
                users.bob,
            ),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROPOSAL_APPROVAL/);
    });

    it('and the owner cannot stamp their own PENDING row into a signature', async () => {
        // The four-eyes trigger fires on UPDATE as well as INSERT, precisely so
        // the PENDING rung cannot be used as a two-statement way around it. The
        // row inserted above names the agent's registered owner.
        await expect(
            raw(
                `UPDATE "AgentProposalApproval" SET "outcome" = 'ACCEPTED' WHERE "id" = $1`,
                'immutability-pending-signature-2',
            ),
        ).rejects.toThrow(/OWNER_SELF_REVIEW/);
    });
});

describe('the requirement the trigger reads is itself write-once', () => {
    it('a queued proposal cannot be quietly lowered from two approvers to one', async () => {
        const proposalId = await propose(highAgentId, 'requirement-write-once');
        await expect(
            raw(`UPDATE "AgentProposal" SET "requiredApprovals" = 1 WHERE "id" = $1`, proposalId),
        ).rejects.toThrow(/IMMUTABLE_REQUIRED_APPROVALS/);

        const after = await prisma.agentProposal.findUnique({
            where: { id: proposalId },
            select: { requiredApprovals: true },
        });
        expect(after?.requiredApprovals).toBe(2);
    });

    it('but a legacy row that never had one can still be filled in', async () => {
        // NULL → value is the one permitted transition, so a backfill remains
        // possible without being able to rewrite a row that already answered.
        const proposalId = await propose(highAgentId, 'requirement-backfill');
        await raw(
            `UPDATE "AgentProposal" SET "requiredApprovals" = NULL WHERE "id" = $1`,
            proposalId,
        ).catch(() => undefined);
        // Clearing is itself a change away from a set value, so it must have
        // been refused — the row is untouched and the backfill path is exercised
        // on a row that genuinely predates the column instead.
        const stillPinned = await prisma.agentProposal.findUnique({
            where: { id: proposalId },
            select: { requiredApprovals: true },
        });
        expect(stillPinned?.requiredApprovals).toBe(2);

        await raw(
            `INSERT INTO "AgentProposal"
                 ("id","tenantId","kind","status","payloadJson","updatedAt")
             VALUES ($1,$2,'RISK','PENDING','{}',NOW())`,
            'legacy-unpinned-proposal',
            T,
        );
        await expect(
            raw(
                `UPDATE "AgentProposal" SET "requiredApprovals" = 2 WHERE "id" = $1`,
                'legacy-unpinned-proposal',
            ),
        ).resolves.toBeDefined();
    });
});
