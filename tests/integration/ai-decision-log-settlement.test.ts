/**
 * A decision nobody will review does not sit at "awaiting review" for ever
 * (#4896, owner decision 2026-11-01).
 *
 * The AI decision log writes a run's model calls PENDING, because when they
 * are written nobody knows whether the run will stop for approval. Before
 * this, nothing stamped them when the run finished without stopping, so the
 * log built a backlog no person was ever asked to clear and the evidence pack
 * counted it as "still pending review". Against a real database, with the
 * append-only trigger in force:
 *
 *   1. a finished run's still-pending rows are stamped "no human review", and
 *      nothing else is touched — not another run's rows, not a row already
 *      decided — while a paused run, or one that left a proposal for a
 *      person, keeps its rows pending;
 *   2. a person deciding a run's proposal stamps the run's rows with that
 *      decision;
 *   3. a proposal expiring undecided stamps its run's rows "no human review",
 *      but only when the run is finished and holds no other pending proposal.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { recordRunDecisionsUnreviewed } from '@/app-layer/ai/decision-log';
import { createAgentProposal, rejectAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { runAgentProposalExpiry } from '@/app-layer/jobs/agent-proposal-expiry';
import { settleRunDecisionLog } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `dls-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
let AGENT = '';

const ctx = (agentId?: string) =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER, ...(agentId ? { agentId } : {}) });

const PAYLOAD = {
    title: `${SUITE} unevidenced access recertification`,
    description:
        'The quarterly access recertification for the production account has no signed reviewer record. ' +
        'Remediation is to attach the identity-provider export and have the system owner sign off.',
};

async function run(status: 'COMPLETED' | 'RUNNING' = 'COMPLETED'): Promise<string> {
    const id = `run-${randomUUID()}`;
    await prisma.workflowRun.create({ data: { id, tenantId: TENANT, workflowKey: 'audit-prep', status } });
    return id;
}

async function decision(runId: string, humanOutcome: 'PENDING' | 'ACCEPTED' = 'PENDING'): Promise<string> {
    const row = await prisma.aiDecisionLog.create({
        data: {
            tenantId: TENANT,
            feature: 'agentic-run:audit-prep',
            provider: 'anthropic',
            inputDigest: `sha256:${randomUUID()}`,
            sessionRef: runId,
            humanOutcome,
        },
        select: { id: true },
    });
    return row.id;
}

const outcomeOf = async (id: string) =>
    (await prisma.aiDecisionLog.findUniqueOrThrow({ where: { id }, select: { humanOutcome: true } })).humanOutcome;

async function proposalFrom(runId: string): Promise<string> {
    const created = await createAgentProposal(ctx(AGENT), {
        kind: 'RISK',
        payload: PAYLOAD,
        policyCardVersion: 1,
        origin: { runId, stepSeq: 0 },
    });
    return created.id;
}

describeFn('the decision log settles rows nobody will review (#4896)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${USER}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: TENANT },
            update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
            create: { tenantId: TENANT, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        });
        const aiSystem = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `${SUITE} host`, ownerUserId: USER } });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: `${SUITE}-agent`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: USER,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        AGENT = agent.id;
        const card = await prisma.agentPolicyCard.create({
            data: { tenantId: TENANT, agentId: AGENT, currentVersion: 1, createdByUserId: USER },
        });
        await prisma.agentPolicyCardVersion.create({
            data: {
                tenantId: TENANT,
                cardId: card.id,
                version: 1,
                permittedTools: ['propose_risks'],
                maxDataScope: 'READ_TENANT_DATA',
                maxAutonomyLevel: 2,
                maxActionsPerRun: 10,
                maxActionsPerDay: 100,
                escalationTriggers: [],
                approvalRung: 'SINGLE_APPROVER',
                seeded: true,
                seededFromTier: 'LOW',
                createdByUserId: USER,
            },
        });
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('stamps a finished run’s pending rows, and nothing else', async () => {
        const [mine, other] = [await run(), await run()];
        const pending = await decision(mine);
        const decided = await decision(mine, 'ACCEPTED');
        const elsewhere = await decision(other);

        const stamped = await prisma.$transaction((tx) => recordRunDecisionsUnreviewed(tx as never, ctx(), mine));

        expect(stamped).toBe(1);
        expect(await outcomeOf(pending)).toBe('AUTONOMOUS');
        expect(await outcomeOf(decided)).toBe('ACCEPTED');
        expect(await outcomeOf(elsewhere)).toBe('PENDING');
    });

    it('the settle step stamps a finished run, and leaves a paused run or one awaiting a person', async () => {
        const finished = await run();
        const finishedRow = await decision(finished);
        await settleRunDecisionLog(ctx(), finished, 'COMPLETED');
        expect(await outcomeOf(finishedRow)).toBe('AUTONOMOUS');

        const paused = await run('RUNNING');
        const pausedRow = await decision(paused);
        await settleRunDecisionLog(ctx(), paused, 'AWAITING_APPROVAL');
        expect(await outcomeOf(pausedRow)).toBe('PENDING');

        const proposing = await run();
        const proposingRow = await decision(proposing);
        await proposalFrom(proposing);
        await settleRunDecisionLog(ctx(), proposing, 'COMPLETED');
        expect(await outcomeOf(proposingRow)).toBe('PENDING');
    });

    it('a person rejecting a run’s proposal stamps the run’s rows with that decision', async () => {
        const runId = await run();
        const row = await decision(runId);
        const proposalId = await proposalFrom(runId);

        await rejectAgentProposal(ctx(), proposalId);

        expect(await outcomeOf(row)).toBe('REJECTED');
    });

    it('a proposal expiring undecided stamps its finished run’s rows "no human review"', async () => {
        const runId = await run();
        const row = await decision(runId);
        const proposalId = await proposalFrom(runId);
        await prisma.agentProposal.update({ where: { id: proposalId }, data: { expiresAt: new Date(Date.now() - 60_000) } });

        await runAgentProposalExpiry(prisma, { tenantId: TENANT });

        expect((await prisma.agentProposal.findUniqueOrThrow({ where: { id: proposalId } })).status).toBe('EXPIRED');
        expect(await outcomeOf(row)).toBe('AUTONOMOUS');
    });

    it('…but not while the run holds another pending proposal, nor while the run is unfinished', async () => {
        const busy = await run();
        const busyRow = await decision(busy);
        const expiring = await proposalFrom(busy);
        await proposalFrom(busy); // still in its window
        await prisma.agentProposal.update({ where: { id: expiring }, data: { expiresAt: new Date(Date.now() - 60_000) } });

        const running = await run('RUNNING');
        const runningRow = await decision(running);
        const runningProposal = await proposalFrom(running);
        await prisma.agentProposal.update({ where: { id: runningProposal }, data: { expiresAt: new Date(Date.now() - 60_000) } });

        await runAgentProposalExpiry(prisma, { tenantId: TENANT });

        expect(await outcomeOf(busyRow)).toBe('PENDING');
        expect(await outcomeOf(runningRow)).toBe('PENDING');
    });
});
