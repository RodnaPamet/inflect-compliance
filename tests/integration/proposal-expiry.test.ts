/**
 * THE REVIEW WINDOW — a proposal past it expires, and cannot be approved.
 *
 * OWASP ASI09 (human-agent trust exploitation). The propose-not-commit queue's
 * whole safety claim is that a human approved every agent-authored write. Queue
 * DEPTH is what makes that claim hollow: past some backlog, "approve" stops
 * meaning "I read this" and starts meaning "clear the list". So an unbounded
 * queue is part of the threat model, not a housekeeping matter, and the bound
 * is a deadline.
 *
 * ═══ WHY THE REFUSAL IS TESTED AGAINST THE CLOCK, NOT THE STATUS ═══
 *
 * The sweep that stamps `EXPIRED` runs nightly. Between the instant a window
 * closes and the instant the sweep notices, the row still reads PENDING — up to
 * a day. A check that only looked at the status would approve every one of
 * those, i.e. the deadline would be enforced by a cron's punctuality rather
 * than by the deadline. So the central case below backdates `expiresAt` and
 * leaves the status PENDING, which is exactly the state a real closed window
 * occupies for most of its life.
 *
 * ═══ WHY EVERY REFUSAL HAS A POSITIVE COMPANION ═══
 *
 * A gate that refused everything would satisfy every refusal assertion here
 * while taking the entire proposal queue dark, and would look — from inside the
 * tests — exactly like the control working. So each refusal is stated against
 * the SAME agent, the SAME payload and the SAME reviewer, differing only in
 * whether the window has closed.
 *
 * ═══ AND WHY "NOTHING WAS CREATED" IS ASSERTED, NOT JUST "IT THREW" ═══
 *
 * The refusal sits ahead of the claim, in front of the create-usecase. A check
 * placed after the write would also throw, would also hand the caller an error,
 * and would leave a live compliance record behind. So the refusal is checked
 * against the Risk table and against the proposal row, either of which can only
 * be untouched if the write never ran.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    approveAgentProposal,
    createAgentProposal,
    listAgentProposals,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { runAgentProposalExpiry } from '@/app-layer/jobs/agent-proposal-expiry';
import {
    PROPOSAL_WINDOW_DAYS,
    UNCARDED_PROPOSAL_WINDOW_DAYS,
} from '@/lib/agentic/proposal-expiry';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `pexp-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Two agents, so the two approval rungs can be compared side by side. */
let secondApproverAgentId = '';
let singleApproverAgentId = '';

const ctxFor = (agentId?: string) =>
    makeRequestContext('OWNER', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: USER,
        ...(agentId ? { agentId } : {}),
    });

const PAYLOAD = {
    title: `${SUITE} unevidenced access recertification`,
    description:
        'The quarterly access recertification for the production account has no ' +
        'signed reviewer record. Remediation is to attach the identity-provider ' +
        'export and have the system owner sign off.',
};

/** Seed an agent with a policy card whose only version declares `rung`. */
async function seedCardedAgent(name: string, rung: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
            status: 'ACTIVE',
            // The CHECK pins tier and stamp to move together.
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    const card = await prisma.agentPolicyCard.create({
        data: { tenantId: TENANT, agentId: agent.id, currentVersion: 1, createdByUserId: USER },
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
            approvalRung: rung,
            seeded: true,
            seededFromTier: 'LOW',
            createdByUserId: USER,
        },
    });
    return agent.id;
}

/**
 * Force one proposal's window shut without touching anything else about it.
 *
 * A raw column write rather than a fixture clock, because what is under test is
 * a row in the state a real closed window leaves it in: `expiresAt` in the past
 * and `status` still PENDING, which is where every proposal sits between its
 * deadline passing and the nightly sweep noticing.
 */
async function closeWindow(proposalId: string, msAgo = 60_000): Promise<void> {
    await prisma.agentProposal.update({
        where: { id: proposalId },
        data: { expiresAt: new Date(Date.now() - msAgo) },
    });
}

async function auditActionsFor(entityId: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
        where: { tenantId: TENANT, entityId },
        select: { action: true },
    });
    return rows.map((r) => r.action);
}

describeFn('agent proposals expire, and an expired one cannot be approved', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${USER}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
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
        secondApproverAgentId = await seedCardedAgent(`${SUITE}-two`, 'SECOND_APPROVER');
        singleApproverAgentId = await seedCardedAgent(`${SUITE}-one`, 'SINGLE_APPROVER');
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    // ─────────────────────────────────────────────────────────────────
    describe('the window is pinned at creation, and its length comes from the rung', () => {
        it('a SECOND_APPROVER proposal gets the longer window, from its own creation instant', async () => {
            const created = await createAgentProposal(ctxFor(secondApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            const row = await prisma.agentProposal.findFirstOrThrow({
                where: { id: created.id },
            });
            expect(row.expiresAt).not.toBeNull();
            const days = (row.expiresAt!.getTime() - row.createdAt.getTime()) / MS_PER_DAY;
            expect(Math.round(days)).toBe(PROPOSAL_WINDOW_DAYS.SECOND_APPROVER);
        });

        it('a SINGLE_APPROVER proposal gets the shorter one — same clock, different length', async () => {
            const created = await createAgentProposal(ctxFor(singleApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            const row = await prisma.agentProposal.findFirstOrThrow({
                where: { id: created.id },
            });
            const days = (row.expiresAt!.getTime() - row.createdAt.getTime()) / MS_PER_DAY;
            expect(Math.round(days)).toBe(PROPOSAL_WINDOW_DAYS.SINGLE_APPROVER);
            // The two rungs are genuinely different, so the assertion above is
            // not satisfied by both branches producing the same number.
            expect(PROPOSAL_WINDOW_DAYS.SECOND_APPROVER).toBeGreaterThan(
                PROPOSAL_WINDOW_DAYS.SINGLE_APPROVER,
            );
        });

        it('a proposal no card governed gets the SHORTEST window — an absence buys no extra time', async () => {
            const created = await createAgentProposal(ctxFor(), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: NO_POLICY_CARD,
            });
            const row = await prisma.agentProposal.findFirstOrThrow({
                where: { id: created.id },
            });
            const days = (row.expiresAt!.getTime() - row.createdAt.getTime()) / MS_PER_DAY;
            expect(Math.round(days)).toBe(UNCARDED_PROPOSAL_WINDOW_DAYS);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    describe('a proposal past its window cannot be approved', () => {
        it('refuses with a 403 naming only the condition, and creates nothing', async () => {
            const created = await createAgentProposal(ctxFor(singleApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            await closeWindow(created.id);
            const risksBefore = await prisma.risk.count({ where: { tenantId: TENANT } });

            await expect(approveAgentProposal(ctxFor(), created.id)).rejects.toThrow(
                'agent_proposal_expired',
            );

            // Nothing was created — the refusal is ahead of the claim, so the
            // proposal is still exactly where it was.
            expect(await prisma.risk.count({ where: { tenantId: TENANT } })).toBe(risksBefore);
            const row = await prisma.agentProposal.findFirstOrThrow({ where: { id: created.id } });
            expect(row.status).toBe('PENDING');
            expect(row.createdEntityId).toBeNull();
            expect(row.reviewedByUserId).toBeNull();
        });

        it('and the refusal leaves a hash-chained AUTHZ_DENIED row that names the reason', async () => {
            const created = await createAgentProposal(ctxFor(singleApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            await closeWindow(created.id);
            await expect(approveAgentProposal(ctxFor(), created.id)).rejects.toThrow();

            const denial = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: TENANT, entityId: created.id, action: 'AUTHZ_DENIED' },
            });
            const details = denial.detailsJson as Record<string, unknown>;
            expect(details.reason).toBe('agent_proposal_expired');
            expect(details.attemptedAction).toBe('approve');
            expect(details.category).toBe('access');
            // The trail carries the condition and the structural facts; it must
            // not carry the proposal's content.
            expect(JSON.stringify(details)).not.toContain(PAYLOAD.title);
            expect(denial.entryHash).toBeTruthy();
        });

        it('the SAME proposal inside its window approves and creates the record', async () => {
            // The positive companion. Without it every assertion above is also
            // satisfied by a gate that refuses everything.
            const created = await createAgentProposal(ctxFor(singleApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            const result = await approveAgentProposal(ctxFor(), created.id);
            expect(result.status).toBe('ACCEPTED');
            expect(result.createdEntityId).toBeTruthy();

            const risk = await prisma.risk.findFirst({ where: { id: result.createdEntityId } });
            expect(risk).not.toBeNull();
            const row = await prisma.agentProposal.findFirstOrThrow({ where: { id: created.id } });
            expect(row.status).toBe('ACCEPTED');
            expect(row.reviewedByUserId).toBe(USER);
        });

        it('and rejection is refused too — the record must not improve on its own', async () => {
            const created = await createAgentProposal(ctxFor(singleApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            await closeWindow(created.id);

            await expect(rejectAgentProposal(ctxFor(), created.id)).rejects.toThrow(
                'agent_proposal_expired',
            );
            const row = await prisma.agentProposal.findFirstOrThrow({ where: { id: created.id } });
            // Still "nobody decided", not "somebody decided no".
            expect(row.status).toBe('PENDING');
            expect(row.reviewedByUserId).toBeNull();
            const details = (
                await prisma.auditLog.findFirstOrThrow({
                    where: { tenantId: TENANT, entityId: created.id, action: 'AUTHZ_DENIED' },
                })
            ).detailsJson as Record<string, unknown>;
            expect(details.attemptedAction).toBe('reject');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    describe('the sweep records the expiry without destroying the evidence', () => {
        it('moves PENDING to EXPIRED, audits it, and leaves every fact on the row intact', async () => {
            const created = await createAgentProposal(ctxFor(secondApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                rationale: `${SUITE} the agent's stated reason`,
                policyCardVersion: 1,
            });
            const before = await prisma.agentProposal.findFirstOrThrow({
                where: { id: created.id },
            });
            await closeWindow(created.id);

            const result = await runAgentProposalExpiry(prisma, { tenantId: TENANT });
            expect(result.expired).toBeGreaterThanOrEqual(1);

            const after = await prisma.agentProposal.findFirstOrThrow({
                where: { id: created.id },
            });
            expect(after.status).toBe('EXPIRED');
            // NOBODY reviewed it — that absence is the fact the row records.
            expect(after.reviewedByUserId).toBeNull();
            expect(after.reviewedAt).toBeNull();
            expect(after.createdEntityId).toBeNull();
            // …and everything that made it evidence is still there.
            expect(after.payloadJson).toBe(before.payloadJson);
            expect(after.rationale).toBe(before.rationale);
            expect(after.agentId).toBe(secondApproverAgentId);
            expect(after.policyCardVersion).toBe(1);
            expect(after.guardVerdict).toBe(before.guardVerdict);

            expect(await auditActionsFor(created.id)).toContain('AGENT_PROPOSAL_EXPIRED');
        });

        it('leaves an in-window proposal alone — the sweep is not a queue-clearer', async () => {
            const created = await createAgentProposal(ctxFor(secondApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            await runAgentProposalExpiry(prisma, { tenantId: TENANT });
            const row = await prisma.agentProposal.findFirstOrThrow({ where: { id: created.id } });
            expect(row.status).toBe('PENDING');
            expect(await auditActionsFor(created.id)).not.toContain('AGENT_PROPOSAL_EXPIRED');
        });

        it('an EXPIRED proposal is out of the review queue but still in the database', async () => {
            const created = await createAgentProposal(ctxFor(secondApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            await closeWindow(created.id);
            await runAgentProposalExpiry(prisma, { tenantId: TENANT });

            const queue = await listAgentProposals(ctxFor(), { take: 200 });
            expect(queue.map((p) => p.id)).not.toContain(created.id);
            // Hidden from the queue, NOT deleted: it is the record of something
            // an agent asked for and no human agreed to.
            expect(
                await prisma.agentProposal.count({ where: { id: created.id } }),
            ).toBe(1);
        });

        it('a row written before expiresAt existed is GIVEN a window, not retired by one', async () => {
            // The migration deliberately did not backfill, so every
            // pre-existing proposal has NULL. Computing a deadline from
            // `createdAt` would mass-expire the backlog on the first run after
            // deploy — an outage wearing the costume of a control.
            const legacy = await createAgentProposal(ctxFor(secondApproverAgentId), {
                kind: 'RISK',
                payload: PAYLOAD,
                policyCardVersion: 1,
            });
            await prisma.agentProposal.update({
                where: { id: legacy.id },
                data: {
                    expiresAt: null,
                    createdAt: new Date(Date.now() - 60 * MS_PER_DAY),
                },
            });

            const result = await runAgentProposalExpiry(prisma, { tenantId: TENANT });
            expect(result.backfilled).toBeGreaterThanOrEqual(1);

            const row = await prisma.agentProposal.findFirstOrThrow({ where: { id: legacy.id } });
            expect(row.status).toBe('PENDING');
            expect(row.expiresAt).not.toBeNull();
            expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now());
            // And it is still approvable, which is the whole point of granting
            // the window rather than closing it.
            const approved = await approveAgentProposal(ctxFor(), legacy.id);
            expect(approved.createdEntityId).toBeTruthy();
        });
    });
});
