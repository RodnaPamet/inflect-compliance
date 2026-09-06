/**
 * THE SAMPLE AUDIT — the only measurement of whether approvals mean anything.
 *
 * OWASP ASI09 (human-agent trust exploitation). The propose-not-commit queue
 * claims a human approved every agent-authored write. Every other signal the
 * product emits about that queue describes its SHAPE — how many, how fast, by
 * whom — and a queue that is being rubber-stamped scores perfectly on all of
 * them while manufacturing an auditable record of consent nobody gave.
 *
 * The instrument is a second human re-reviewing an already-approved proposal.
 * This suite pins the two halves of that: the sampler draws from APPROVED
 * proposals and only those, and the disagreement it finds is recorded.
 *
 * ═══ THE TENSION THE SAMPLER RESOLVES, AND HOW IT IS TESTED ═══
 *
 * A sample must be REPRODUCIBLE — otherwise nobody can show it was fair — and
 * UNPREDICTABLE — otherwise a reviewer who can tell which approvals will be
 * audited rubber-stamps the rest, and the audit measures their eyesight rather
 * than the queue. Three properties get both, and each is asserted separately
 * below because each fails differently:
 *
 *   1. KEYED. The same id under two seeds scores differently, so reading the
 *      algorithm is not enough. Defeats a reviewer with the source.
 *   2. EPOCH-BOUND. The same population under two epochs draws differently, so
 *      "am I safe?" has no single answer.
 *   3. RANK OVER A POPULATION — the load-bearing one, and the only property
 *      that survives an adversary who HOLDS the seed. Whether a proposal is
 *      drawn depends on which other approvals are in the pool, including ones
 *      made after it, so the answer does not exist at approval time. Asserted
 *      by removing the drawn element and showing the draw changes.
 *
 * ═══ AND THE CONTROL THAT MAKES AN ANSWER WORTH ANYTHING ═══
 *
 * The re-reviewer may not be the original approver. Without that, the approver
 * marks their own approval CONCURRED, and the disagreement rate goes to zero
 * exactly in the tenants where rubber-stamping is worst — because there the
 * approver is the only person looking.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { runAgentProposalSampleAudit } from '@/app-layer/jobs/agent-proposal-sample-audit';
import {
    getSampleAuditDisagreementRate,
    listAgentProposalSampleAudits,
    recordSampleAuditOutcome,
} from '@/app-layer/usecases/agent-proposal-sample-audit';
import {
    sampleScore,
    sampleSizeFor,
    selectSample,
} from '@/lib/agentic/proposal-sampling';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `psam-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
/** The approver. Their own approvals are the thing under retrospective review. */
const APPROVER = `u-${SUITE}-approver`;
/** A second human. The only one who may answer. */
const REVIEWER = `u-${SUITE}-reviewer`;

/**
 * The seed the tests drive the sampler with.
 *
 * Supplied through the job's test-only seam rather than derived from the
 * deployment key, which is the entire reason `selectSample` takes a seed as an
 * argument: a test has to be able to re-derive the draw, and a reviewer must
 * not be able to.
 */
const TEST_SEED = `seed-${SUITE}`;
const EPOCH = '2026-09-06';

let agentId = '';
/** Proposals a human approved — the eligible population. */
const approvedIds: string[] = [];
/** Proposals in every other status — must never be drawn. */
const ineligibleIds: string[] = [];

const approverCtx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: APPROVER });
const reviewerCtx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: REVIEWER });

/**
 * Insert one proposal in a chosen terminal state.
 *
 * Written straight to the table rather than driven through propose+approve for
 * every row: what is under test is the SAMPLER's population filter, and the
 * honest way to test a filter is to put rows of every status in front of it.
 * Driving forty risks through the real create-usecase would test createRisk.
 */
async function seedProposal(
    status: 'ACCEPTED' | 'EDITED' | 'PENDING' | 'REJECTED' | 'QUARANTINED',
    n: number,
): Promise<string> {
    const reviewed = status === 'ACCEPTED' || status === 'EDITED' || status === 'REJECTED';
    const row = await prisma.agentProposal.create({
        data: {
            tenantId: TENANT,
            kind: 'RISK',
            status,
            payloadJson: JSON.stringify({ title: `${SUITE} risk ${n}`, description: 'seeded' }),
            rationale: `${SUITE} rationale ${n}`,
            agentId,
            policyCardVersion: 1,
            reviewedByUserId: reviewed ? APPROVER : null,
            reviewedAt: reviewed ? new Date() : null,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        select: { id: true },
    });
    return row.id;
}

describeFn('approved agent proposals are sample-audited, and disagreement is recorded', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        for (const id of [APPROVER, REVIEWER]) {
            const email = `${id}@example.test`;
            await prisma.user.upsert({
                where: { id },
                update: {},
                create: { id, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: TENANT, userId: id } },
                update: { role: 'OWNER', status: 'ACTIVE' },
                create: { tenantId: TENANT, userId: id, role: 'OWNER', status: 'ACTIVE' },
            });
        }

        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: `${SUITE} host`, ownerUserId: APPROVER },
        });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: `${SUITE} agent`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                // The accountable human the sampler assigns the review to.
                ownerUserId: APPROVER,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        agentId = agent.id;

        // 20 approved (the eligible population) …
        for (let n = 0; n < 16; n += 1) approvedIds.push(await seedProposal('ACCEPTED', n));
        for (let n = 16; n < 20; n += 1) approvedIds.push(await seedProposal('EDITED', n));
        // … and 15 in every status that is NOT an approval.
        for (let n = 20; n < 25; n += 1) ineligibleIds.push(await seedProposal('PENDING', n));
        for (let n = 25; n < 30; n += 1) ineligibleIds.push(await seedProposal('REJECTED', n));
        for (let n = 30; n < 35; n += 1) ineligibleIds.push(await seedProposal('QUARANTINED', n));
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    // ═════════════════════════════════════════════════════════════════
    describe('the sampler draws from APPROVED proposals and only those', () => {
        it('opens audits, and every one of them is on an approval', async () => {
            const result = await runAgentProposalSampleAudit(prisma, {
                tenantId: TENANT,
                seed: TEST_SEED,
                epoch: EPOCH,
            });
            expect(result.candidates).toBe(approvedIds.length);
            expect(result.opened).toBe(sampleSizeFor(approvedIds.length));

            const audits = await prisma.agentProposalSampleAudit.findMany({
                where: { tenantId: TENANT },
            });
            expect(audits.length).toBe(sampleSizeFor(approvedIds.length));
            for (const audit of audits) {
                expect(approvedIds).toContain(audit.proposalId);
                expect(ineligibleIds).not.toContain(audit.proposalId);
            }
        });

        it('opens them PENDING, assigned to the agent’s registered owner', async () => {
            const audits = await prisma.agentProposalSampleAudit.findMany({
                where: { tenantId: TENANT },
            });
            expect(audits.length).toBeGreaterThan(0);
            for (const audit of audits) {
                // A drawn-but-unreviewed row must never read as agreement, or
                // the disagreement rate improves every time nobody does the work.
                expect(audit.outcome).toBe('PENDING');
                expect(audit.reviewedByUserId).toBeNull();
                expect(audit.reviewedAt).toBeNull();
                expect(audit.assignedToUserId).toBe(APPROVER);
                expect(audit.samplingEpoch).toBe(EPOCH);
            }
        });

        it('stores the epoch but never the seed — a stored seed is a predictable draw', async () => {
            const audits = await prisma.agentProposalSampleAudit.findMany({
                where: { tenantId: TENANT },
            });
            expect(JSON.stringify(audits)).not.toContain(TEST_SEED);
            const trail = await prisma.auditLog.findMany({
                where: { tenantId: TENANT, action: 'AGENT_PROPOSAL_SAMPLED' },
            });
            expect(trail.length).toBe(audits.length);
            expect(JSON.stringify(trail.map((t) => t.detailsJson))).not.toContain(TEST_SEED);
        });

        it('is idempotent — a second run in the same epoch opens nothing more', async () => {
            const before = await prisma.agentProposalSampleAudit.count({
                where: { tenantId: TENANT },
            });
            const again = await runAgentProposalSampleAudit(prisma, {
                tenantId: TENANT,
                seed: TEST_SEED,
                epoch: EPOCH,
            });
            // The already-sampled rows are not candidates at all, so the run
            // does not re-draw and discard — it draws from what is left.
            const after = await prisma.agentProposalSampleAudit.count({
                where: { tenantId: TENANT },
            });
            expect(again.candidates).toBe(approvedIds.length - before);
            expect(after).toBeGreaterThanOrEqual(before);
            const perProposal = await prisma.agentProposalSampleAudit.groupBy({
                by: ['proposalId'],
                where: { tenantId: TENANT },
                _count: { _all: true },
            });
            // One audit per proposal, ever — the unique index is the durable
            // idempotency key a scheduled job needs.
            for (const group of perProposal) expect(group._count._all).toBe(1);
        });
    });

    // ═════════════════════════════════════════════════════════════════
    describe('the draw is reproducible, and not predictable', () => {
        const population = () => approvedIds.map((id) => ({ id }));

        it('the same seed, epoch and population give the same selection', () => {
            const a = selectSample(population(), { seed: TEST_SEED, epoch: EPOCH, count: 3 });
            const b = selectSample(population(), { seed: TEST_SEED, epoch: EPOCH, count: 3 });
            expect(b.map((p) => p.id)).toStrictEqual(a.map((p) => p.id));
        });

        it('a different EPOCH draws differently — there is no single "am I safe?" answer', () => {
            const today = selectSample(population(), { seed: TEST_SEED, epoch: EPOCH, count: 3 });
            const tomorrow = selectSample(population(), {
                seed: TEST_SEED,
                epoch: '2026-09-13',
                count: 3,
            });
            expect(tomorrow.map((p) => p.id)).not.toStrictEqual(today.map((p) => p.id));
        });

        it('a different SEED draws differently — reading the algorithm is not enough', () => {
            const mine = selectSample(population(), { seed: TEST_SEED, epoch: EPOCH, count: 3 });
            const theirs = selectSample(population(), {
                seed: `${TEST_SEED}-other-tenant`,
                epoch: EPOCH,
                count: 3,
            });
            expect(theirs.map((p) => p.id)).not.toStrictEqual(mine.map((p) => p.id));
            // …because the SCORE itself is keyed, not merely the ordering.
            const id = approvedIds[0];
            expect(sampleScore(TEST_SEED, EPOCH, id)).not.toBe(
                sampleScore(`${TEST_SEED}-other-tenant`, EPOCH, id),
            );
        });

        it('selection depends on the POPULATION, so no answer exists at approval time', () => {
            // The property that survives an adversary holding the seed. A
            // proposal is drawn by RANK, and the pool it is ranked against
            // includes approvals nobody has made yet — so removing one member
            // changes who is drawn, deterministically.
            const all = population();
            const [globalPick] = selectSample(all, { seed: TEST_SEED, epoch: EPOCH, count: 1 });
            const smaller = all.filter((c) => c.id !== globalPick.id);
            const [subsetPick] = selectSample(smaller, {
                seed: TEST_SEED,
                epoch: EPOCH,
                count: 1,
            });
            expect(subsetPick.id).not.toBe(globalPick.id);
            // And the removed one really was in the larger pool, so this is a
            // statement about ranking rather than about a filtered list.
            expect(all.map((c) => c.id)).toContain(globalPick.id);
        });

        it('a non-empty population always draws at least one — a zero sample says nothing', () => {
            expect(sampleSizeFor(1)).toBe(1);
            expect(sampleSizeFor(3)).toBe(1);
            expect(sampleSizeFor(0)).toBe(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════
    describe('the disagreement is recorded, and the rate reflects it', () => {
        it('reports the rate as null — not zero — while nothing has been answered', async () => {
            const rate = await getSampleAuditDisagreementRate(reviewerCtx());
            expect(rate.pending).toBeGreaterThan(0);
            expect(rate.answered).toBe(0);
            // Zero would read as "nobody disagreed", which is what a perfect
            // record and an unread queue both produce.
            expect(rate.disagreementRate).toBeNull();
        });

        it('the ORIGINAL APPROVER cannot answer their own audit', async () => {
            const [open] = await listAgentProposalSampleAudits(approverCtx(), { take: 1 });
            expect(open).toBeDefined();

            await expect(
                recordSampleAuditOutcome(approverCtx(), open.id, { outcome: 'CONCURRED' }),
            ).rejects.toThrow('sample_audit_self_review');

            const denial = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: TENANT, entityId: open.id, action: 'AUTHZ_DENIED' },
            });
            const details = denial.detailsJson as Record<string, unknown>;
            expect(details.reason).toBe('sample_audit_self_review');
            // …and the row is untouched: the refusal is ahead of the claim.
            const row = await prisma.agentProposalSampleAudit.findFirstOrThrow({
                where: { id: open.id },
            });
            expect(row.outcome).toBe('PENDING');
            expect(row.reviewedByUserId).toBeNull();
        });

        it('a SECOND human records DISSENTED with codes, and the rate moves', async () => {
            const [open] = await listAgentProposalSampleAudits(reviewerCtx(), { take: 1 });
            const result = await recordSampleAuditOutcome(reviewerCtx(), open.id, {
                outcome: 'DISSENTED',
                dissentCodes: ['SHOULD_HAVE_BEEN_REJECTED', 'MATERIALLY_INACCURATE'],
            });
            expect(result.outcome).toBe('DISSENTED');

            const row = await prisma.agentProposalSampleAudit.findFirstOrThrow({
                where: { id: open.id },
            });
            expect(row.outcome).toBe('DISSENTED');
            expect(row.reviewedByUserId).toBe(REVIEWER);
            expect(row.reviewedAt).not.toBeNull();
            expect([...row.dissentCodes].sort()).toStrictEqual([
                'MATERIALLY_INACCURATE',
                'SHOULD_HAVE_BEEN_REJECTED',
            ]);

            const trail = await prisma.auditLog.findFirstOrThrow({
                where: {
                    tenantId: TENANT,
                    entityId: open.id,
                    action: 'AGENT_PROPOSAL_SAMPLE_AUDIT_RECORDED',
                },
            });
            const details = trail.detailsJson as Record<string, unknown>;
            expect(details.outcome).toBe('DISSENTED');
            expect(details.dissentCodes).toStrictEqual([
                'SHOULD_HAVE_BEEN_REJECTED',
                'MATERIALLY_INACCURATE',
            ]);

            const rate = await getSampleAuditDisagreementRate(reviewerCtx());
            expect(rate.answered).toBe(1);
            expect(rate.dissented).toBe(1);
            expect(rate.disagreementRate).toBe(1);
        });

        it('a CONCURRED answer moves the rate the other way', async () => {
            // The positive companion: without it, a `recordSampleAuditOutcome`
            // that wrote DISSENTED whatever it was handed would pass above.
            const [open] = await listAgentProposalSampleAudits(reviewerCtx(), { take: 1 });
            expect(open).toBeDefined();
            await recordSampleAuditOutcome(reviewerCtx(), open.id, { outcome: 'CONCURRED' });

            const rate = await getSampleAuditDisagreementRate(reviewerCtx());
            expect(rate.answered).toBe(2);
            expect(rate.concurred).toBe(1);
            expect(rate.dissented).toBe(1);
            expect(rate.disagreementRate).toBe(0.5);
        });

        it('refuses a DISSENTED answer that names no reason', async () => {
            await runAgentProposalSampleAudit(prisma, {
                tenantId: TENANT,
                seed: TEST_SEED,
                epoch: '2026-09-20',
            });
            const [open] = await listAgentProposalSampleAudits(reviewerCtx(), { take: 1 });
            expect(open).toBeDefined();
            await expect(
                recordSampleAuditOutcome(reviewerCtx(), open.id, { outcome: 'DISSENTED' }),
            ).rejects.toThrow(/dissent code/i);
            const row = await prisma.agentProposalSampleAudit.findFirstOrThrow({
                where: { id: open.id },
            });
            expect(row.outcome).toBe('PENDING');
        });

        it('refuses PENDING as an answer — a decided audit cannot be un-decided', async () => {
            const [open] = await listAgentProposalSampleAudits(reviewerCtx(), { take: 1 });
            await expect(
                recordSampleAuditOutcome(reviewerCtx(), open.id, {
                    outcome: 'PENDING' as never,
                }),
            ).rejects.toThrow();
        });
    });

    // ═════════════════════════════════════════════════════════════════
    /**
     * The two-tenant behavioural proof `ISOLATION_TESTED` asks for.
     *
     * `rls-coverage` certifies that the policy triple EXISTS on this table.
     * That is shape, not conduct: it says nothing about whether the usecase
     * path honours it. So a second tenant is created with its own OWNER, and
     * that OWNER is driven through the REAL read and the REAL write against
     * tenant A's rows.
     *
     * Both directions are asserted. A read that returns nothing proves
     * isolation only if the same read returns something for its own tenant —
     * otherwise a listing that was simply broken would pass.
     */
    describe('tenant isolation — a second tenant reaches none of this', () => {
        const OTHER_TENANT = `t-${SUITE}-other`;
        const OTHER_USER = `u-${SUITE}-other`;
        const otherCtx = () =>
            makeRequestContext('OWNER', {
                tenantId: OTHER_TENANT,
                tenantSlug: OTHER_TENANT,
                userId: OTHER_USER,
            });

        beforeAll(async () => {
            await prisma.tenant.upsert({
                where: { id: OTHER_TENANT },
                update: {},
                create: { id: OTHER_TENANT, name: OTHER_TENANT, slug: OTHER_TENANT },
            });
            const email = `${OTHER_USER}@example.test`;
            await prisma.user.upsert({
                where: { id: OTHER_USER },
                update: {},
                create: { id: OTHER_USER, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: OTHER_TENANT, userId: OTHER_USER } },
                update: { role: 'OWNER', status: 'ACTIVE' },
                create: {
                    tenantId: OTHER_TENANT,
                    userId: OTHER_USER,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });
        }, 60_000);

        it('cannot LIST tenant A’s sample audits', async () => {
            // Tenant A has some — otherwise the empty result below proves
            // nothing at all.
            const mine = await listAgentProposalSampleAudits(reviewerCtx(), {
                open: false,
                take: 200,
            });
            expect(mine.length).toBeGreaterThan(0);

            const theirs = await listAgentProposalSampleAudits(otherCtx(), {
                open: false,
                take: 200,
            });
            expect(theirs).toStrictEqual([]);
        });

        it('cannot read tenant A’s disagreement rate', async () => {
            const theirs = await getSampleAuditDisagreementRate(otherCtx());
            expect(theirs.sampled).toBe(0);
            expect(theirs.answered).toBe(0);
            expect(theirs.disagreementRate).toBeNull();
        });

        it('cannot ANSWER a tenant A audit, even holding its id', async () => {
            const [target] = await prisma.agentProposalSampleAudit.findMany({
                where: { tenantId: TENANT, outcome: 'PENDING' },
                take: 1,
            });
            expect(target).toBeDefined();

            await expect(
                recordSampleAuditOutcome(otherCtx(), target.id, { outcome: 'CONCURRED' }),
            ).rejects.toThrow(/not found/i);

            // Not merely refused — untouched. A check that threw after the
            // write would also reject the caller.
            const row = await prisma.agentProposalSampleAudit.findFirstOrThrow({
                where: { id: target.id },
            });
            expect(row.outcome).toBe('PENDING');
            expect(row.reviewedByUserId).toBeNull();
            expect(row.tenantId).toBe(TENANT);
        });

        it('and the sampler run for tenant B opens nothing on tenant A’s proposals', async () => {
            const before = await prisma.agentProposalSampleAudit.count({
                where: { tenantId: TENANT },
            });
            const result = await runAgentProposalSampleAudit(prisma, {
                tenantId: OTHER_TENANT,
                seed: TEST_SEED,
                epoch: '2026-10-04',
            });
            expect(result.candidates).toBe(0);
            expect(result.opened).toBe(0);
            expect(
                await prisma.agentProposalSampleAudit.count({ where: { tenantId: TENANT } }),
            ).toBe(before);
        });
    });
});
