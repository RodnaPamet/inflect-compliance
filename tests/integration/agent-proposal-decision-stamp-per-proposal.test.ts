/**
 * EU AI Act Art 14 — a decision on ONE proposal stamps ONE decision-log row
 * (#5191).
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 *
 * The stamp used to be keyed by `inputDigest` alone. That digest is
 * `computeProposalDigest({ kind, payload, rationale })` — a pure function of
 * CONTENT — and nothing de-duplicates proposals, so two PENDING proposals with
 * identical content share it. Approving the first stamped BOTH rows ACCEPTED;
 * rejecting the second then matched nothing (both were already stamped) and the
 * miss was swallowed. The register recorded ACCEPTED for a decision a human
 * REJECTED.
 *
 * ── WHAT THIS SUITE HOLDS ───────────────────────────────────────────────────
 *
 * Everything runs through the real usecases against the real database, and
 * every assertion reads the rows back: an `updateMany` that hits the wrong row
 * reports success exactly as loudly as one that hits the right one.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    approveAgentProposal,
    bulkRejectAgentProposals,
    createAgentProposal,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { AGENT_PROPOSAL_DECISION_FEATURE } from '@/app-layer/ai/decision-log';
import { makeRequestContext } from '../helpers/make-context';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `pstamp-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
/** Proposes. */
const AUTHOR = `a-${SUITE}`;
/** Decides — a different person, so no self-review rule is in play. */
const REVIEWER = `r-${SUITE}`;

const ctxFor = (userId: string) =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId });

/**
 * Queue a proposal whose content is IDENTICAL to every other one queued with
 * the same `label` — same kind, payload and rationale, so the same digest.
 */
async function queueIdentical(label: string): Promise<string> {
    const created = await createAgentProposal(ctxFor(AUTHOR), {
        kind: 'RISK',
        payload: {
            title: `${SUITE} ${label} unevidenced access recertification`,
            description: 'The quarterly access recertification has no signed reviewer record.',
        },
        rationale: 'Observed during the nightly control sweep.',
        policyCardVersion: NO_POLICY_CARD,
    });
    return created.id;
}

async function digestOf(proposalId: string): Promise<string> {
    const row = await prisma.agentProposal.findUniqueOrThrow({
        where: { id: proposalId },
        select: { guardInputDigest: true },
    });
    if (!row.guardInputDigest) throw new Error('proposal carries no digest');
    return row.guardInputDigest;
}

/** The ONE Art 12 row a proposal's creation wrote, read by the id it carries. */
async function rowOf(proposalId: string) {
    return prisma.aiDecisionLog.findUniqueOrThrow({
        where: { tenantId_agentProposalId: { tenantId: TENANT, agentProposalId: proposalId } },
        select: { humanOutcome: true, inputDigest: true, feature: true },
    });
}

/** Every Art 12 row for a digest, outcome only, sorted so the read is stable. */
async function outcomesForDigest(inputDigest: string): Promise<string[]> {
    const rows = await prisma.aiDecisionLog.findMany({
        where: { tenantId: TENANT, inputDigest },
        select: { humanOutcome: true },
    });
    return rows.map((r) => r.humanOutcome).sort();
}

async function seed(): Promise<void> {
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: TENANT, slug: TENANT },
    });
    for (const userId of [AUTHOR, REVIEWER]) {
        const email = `${userId}@example.test`;
        await prisma.user.upsert({
            where: { id: userId },
            update: {},
            create: { id: userId, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId, role: 'OWNER', status: 'ACTIVE' },
        });
    }
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        create: { tenantId: TENANT, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
    });
}

describeFn('a decision on one proposal stamps that proposal\'s decision row only', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await seed();
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('approving one of two identical proposals leaves the other PENDING; rejecting it records REJECTED', async () => {
        const first = await queueIdentical('approve-then-reject');
        const second = await queueIdentical('approve-then-reject');

        // The precondition the bug needs: two proposals, one digest, two rows.
        const digest = await digestOf(first);
        expect(await digestOf(second)).toBe(digest);
        expect(await outcomesForDigest(digest)).toEqual(['PENDING', 'PENDING']);

        await approveAgentProposal(ctxFor(REVIEWER), first);

        // Exactly ONE row moved. The bug stamped both here.
        expect(await outcomesForDigest(digest)).toEqual(['ACCEPTED', 'PENDING']);

        await rejectAgentProposal(ctxFor(REVIEWER), second);

        // The rejection lands on the row that was still waiting for it.
        expect(await outcomesForDigest(digest)).toEqual(['ACCEPTED', 'REJECTED']);

        // …and each outcome is on the right proposal's own row, not merely in
        // the right multiset.
        expect((await rowOf(first)).humanOutcome).toBe('ACCEPTED');
        expect((await rowOf(second)).humanOutcome).toBe('REJECTED');
    });

    it('each proposal writes exactly one row naming it, under the feature the legacy stamp reads', async () => {
        const id = await queueIdentical('row-shape');
        const row = await rowOf(id);
        expect(row.inputDigest).toBe(await digestOf(id));
        // The legacy arm filters on this constant; the real writer must agree.
        expect(row.feature).toBe(AGENT_PROPOSAL_DECISION_FEATURE);
    });

    it('rejecting first, then approving the twin, records each decision on its own row', async () => {
        const first = await queueIdentical('reject-then-approve');
        const second = await queueIdentical('reject-then-approve');
        const digest = await digestOf(first);

        await rejectAgentProposal(ctxFor(REVIEWER), first);
        expect(await outcomesForDigest(digest)).toEqual(['PENDING', 'REJECTED']);

        await approveAgentProposal(ctxFor(REVIEWER), second);
        expect((await rowOf(first)).humanOutcome).toBe('REJECTED');
        expect((await rowOf(second)).humanOutcome).toBe('ACCEPTED');
    });

    it('bulk-rejecting one of two identical proposals leaves the other PENDING', async () => {
        const first = await queueIdentical('bulk');
        const second = await queueIdentical('bulk');
        const digest = await digestOf(first);

        const result = await bulkRejectAgentProposals(ctxFor(REVIEWER), [first]);
        expect(result.rejected).toEqual([first]);

        expect(await outcomesForDigest(digest)).toEqual(['PENDING', 'REJECTED']);
        expect((await rowOf(first)).humanOutcome).toBe('REJECTED');
        expect((await rowOf(second)).humanOutcome).toBe('PENDING');
    });
});
