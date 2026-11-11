/**
 * THE PROCESS_MAP PROPOSAL KIND, DEPLOY 1 OF 2: READ, NEVER WRITTEN (#5053).
 *
 * A Prisma client meeting a stored enum value it was not generated with fails
 * the WHOLE read, which on the proposal queue is every proposal the tenant has.
 * So the value reaches the database a release before anything writes it, and
 * this release teaches every reader. This suite proves the four halves of that:
 *
 *   1. the value is storable (the migration landed);
 *   2. nothing in this release can write one — `createAgentProposal`, the only
 *      `agentProposal.create` site, refuses the kind for EVERY shape, with the
 *      same reason, and leaves no row;
 *   3. a row written by a newer container mid-rollout is refused at approve
 *      BEFORE the signature insert and BEFORE the claim, so it stays PENDING
 *      with no approval row and no process map — and it is never burned
 *      ACCEPTED with nothing created;
 *   4. such a row is read by the queue and the diff builder without throwing,
 *      is not reviewable (so no surface offers Approve), and can be rejected.
 *
 * ## Why the approval test seeds a CREATE-shaped row
 *
 * The same reason as `agent-proposal-external-write-kind.test.ts`: the refusal
 * must be observable as sitting before the claim, so the seeded row has to be
 * one that would otherwise REACH the claim. A CREATE-shaped row resolves no
 * target; move the refusal below the claim and the row comes back ACCEPTED.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    approveAgentProposal,
    createAgentProposal,
    listAgentProposals,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { buildProposalDiffs } from '@/app-layer/usecases/agent-proposal-diff';
import { isDiffReviewable } from '@/lib/agentic/proposal-diff';
import { PROCESS_MAP_PROPOSALS_IMPLEMENTED } from '@/lib/agentic/proposal-kind-rollout';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T = 'process-map-kind-tenant';
const U = 'process-map-kind-user';

const ctx = () => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: U });

beforeAll(async () => {
    // `upsert` throughout: `resetDatabase` does not truncate `Tenant` or `User`,
    // so a create here would fail on the second run of this file.
    await prisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, name: T, slug: T } });
    const email = `${U}@example.test`;
    await prisma.user.upsert({
        where: { id: U },
        update: {},
        create: { id: U, email, emailHash: hashForLookup(email) },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: T, userId: U } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: { tenantId: T, userId: U, role: 'OWNER', status: 'ACTIVE' },
    });
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: T },
        update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        create: { tenantId: T, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
    });
});

beforeEach(async () => {
    // Signatures cascade with their proposal.
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
});

afterAll(async () => {
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
    await prisma.$disconnect();
});

/** A map an agent might one day propose: a name and a handful of steps. */
const MAP_PAYLOAD = {
    name: 'Joiner onboarding',
    description: 'From signed offer to first-day access.',
    steps: ['Offer signed', 'Accounts requested', 'Accounts provisioned'],
};

/** A row of the new kind, inserted directly, as a newer container would. */
async function seedProcessMapProposal(): Promise<string> {
    const row = await prisma.agentProposal.create({
        data: {
            tenantId: T,
            kind: 'PROCESS_MAP',
            // CREATE, so the row would reach the claim. See the header.
            operation: 'CREATE',
            status: 'PENDING',
            payloadJson: JSON.stringify(MAP_PAYLOAD),
        },
        select: { id: true },
    });
    return row.id;
}

/** The refusal's `details.reason`, or null when it threw something else. */
async function refusalReason(p: Promise<unknown>): Promise<unknown> {
    try {
        await p;
    } catch (e) {
        return (e as { details?: { reason?: unknown } }).details?.reason ?? null;
    }
    throw new Error('expected a refusal, and the call succeeded');
}

describe('the brake', () => {
    it('is engaged in this release (IMPLEMENTED=false)', () => {
        // Every refusal below is the brake's. Flipping it is deploy 2's commit.
        expect(PROCESS_MAP_PROPOSALS_IMPLEMENTED).toBe(false);
    });
});

describe('the kind is storable', () => {
    it('accepts PROCESS_MAP on the column — the migration landed', async () => {
        const id = await seedProcessMapProposal();
        const row = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { kind: true, status: true, targetEntityId: true },
        });
        expect(row.kind).toBe('PROCESS_MAP');
        expect(row.status).toBe('PENDING');
        expect(row.targetEntityId).toBeNull();
    });
});

describe('nothing in this release writes one', () => {
    it.each([
        ['CREATE', {}],
        // An UPDATE would otherwise be refused by the update-target check with a
        // different sentence. The kind's refusal comes first, for every shape.
        ['UPDATE', { targetEntityId: 'map-1' }],
    ] as const)('refuses a %s-shaped PROCESS_MAP by name, and stores nothing', async (operation, extra) => {
        const reason = await refusalReason(
            createAgentProposal(ctx(), {
                kind: 'PROCESS_MAP',
                operation,
                ...extra,
                payload: MAP_PAYLOAD,
                policyCardVersion: 0,
            } as unknown as Parameters<typeof createAgentProposal>[1]),
        );
        expect(reason).toBe('PROCESS_MAP_PROPOSALS_NOT_AVAILABLE');
        expect(await prisma.agentProposal.count({ where: { tenantId: T } })).toBe(0);
    });

    it('and the refusal is about THIS kind, not about every kind', async () => {
        // The positive control: a refusal that fired for every kind would
        // satisfy the test above while saying nothing about PROCESS_MAP. A RISK
        // proposal may fail later on its own payload, but never with this reason.
        let reason: unknown = null;
        try {
            await createAgentProposal(ctx(), {
                kind: 'RISK',
                payload: { title: 'a risk', description: 'x'.repeat(40) },
            } as unknown as Parameters<typeof createAgentProposal>[1]);
        } catch (e) {
            reason = (e as { details?: { reason?: unknown } }).details?.reason ?? null;
        }
        expect(reason).not.toBe('PROCESS_MAP_PROPOSALS_NOT_AVAILABLE');
    });
});

describe('a row written by a newer container', () => {
    it('is refused at approve, and stays PENDING with nothing signed or created', async () => {
        const id = await seedProcessMapProposal();
        const mapsBefore = await prisma.processMap.count({ where: { tenantId: T } });

        expect(await refusalReason(approveAgentProposal(ctx(), id))).toBe(
            'PROCESS_MAP_PROPOSALS_NOT_AVAILABLE',
        );

        const after = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { status: true, createdEntityId: true },
        });
        // Not ACCEPTED: the refusal sits before the claim, which is never
        // handed back once taken.
        expect(after.status).toBe('PENDING');
        expect(after.createdEntityId).toBeNull();
        // Not signed: the refusal sits before the signature insert too.
        expect(await prisma.agentProposalApproval.count({ where: { proposalId: id } })).toBe(0);
        expect(await prisma.processMap.count({ where: { tenantId: T } })).toBe(mapsBefore);
    });

    it('is read by the queue and the diff builder, and is not reviewable', async () => {
        const id = await seedProcessMapProposal();

        const listed = await listAgentProposals(ctx(), { status: 'PENDING' });
        expect(listed.find((r) => r.id === id)?.kind).toBe('PROCESS_MAP');

        const row = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { id: true, kind: true, operation: true, payloadJson: true, targetEntityId: true },
        });
        const diff = (await buildProposalDiffs(ctx(), [row])).get(id);
        expect(diff).toBeDefined();
        // Not reviewable, so neither the queue nor the canvas review panel
        // offers Approve on it while the brake is on.
        expect(isDiffReviewable(diff!)).toBe(false);
        // Its own status, never PAYLOAD_UNREADABLE: the row is well formed.
        expect(diff!.status).toBe('KIND_NOT_APPROVABLE');
    });

    it('can be REJECTED, because narrowing is never gated', async () => {
        const id = await seedProcessMapProposal();
        await rejectAgentProposal(ctx(), id);
        const after = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { status: true },
        });
        expect(after.status).toBe('REJECTED');
    });
});
