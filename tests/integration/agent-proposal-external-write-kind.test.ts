/**
 * THE EXTERNAL_WRITE PROPOSAL KIND, BEFORE ANYTHING CREATES ONE (#2861).
 *
 * The `PROPOSE_ONLY` rung queues an external write for human approval, and it
 * reuses `AgentProposal` for that — the four-eyes database trigger, the output
 * guard, the expiry window and the sample audits already live there, and a
 * second copy of that composition is the failure this subsystem has paid for
 * once already.
 *
 * This slice adds the enum value and NOTHING that writes it. Both seams that can
 * meet the kind refuse it explicitly and say what is missing, which is the
 * "control arrives before the authority" ordering #2933 used and #2241's lesson
 * about what a rung costs when it arrives after.
 *
 * ## Why the approval test seeds a CREATE-shaped row
 *
 * `approveAgentProposal` claims a proposal by flipping it to ACCEPTED, and that
 * function's own comment explains why the claim is deliberately never handed
 * back — so a refusal placed AFTER it would leave the row permanently ACCEPTED
 * with nothing dispatched and no retry. Proving the guard sits before the claim
 * needs a row that would otherwise REACH the claim.
 *
 * An UPDATE-shaped row does not. `buildProposalDiff` resolves `targetEntityId`
 * against one of our own tables, an external write names a record in somebody
 * else's, so the diff is always TARGET_MISSING and approval is refused before
 * the claim on that instead. Written that way the status assertion could never
 * fail — it was measured, and it did not — which is a test that passes because
 * it never reaches the thing it names.
 *
 * A CREATE-shaped row resolves no target, reaches the guard, and makes the
 * placement observable: move the guard after the claim and the row comes back
 * ACCEPTED. Both mutations were run.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    approveAgentProposal,
    createAgentProposal,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T = 'ext-write-kind-tenant';
const U = 'ext-write-kind-user';

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
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
});

afterAll(async () => {
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
    await prisma.$disconnect();
});

/** A row of the new kind, inserted directly — nothing in the app creates one. */
async function seedExternalWriteProposal(): Promise<string> {
    const row = await prisma.agentProposal.create({
        data: {
            tenantId: T,
            kind: 'EXTERNAL_WRITE',
            // CREATE, so the row reaches the guard under test. See the header:
            // an UPDATE row is refused earlier by the diff gate, which would make
            // the status assertion below unfalsifiable.
            operation: 'CREATE',
            status: 'PENDING',
            payloadJson: JSON.stringify({ empNumber: 7, workEmail: 'new@example.test' }),
        },
        select: { id: true },
    });
    return row.id;
}

describe('the kind is storable', () => {
    it('accepts EXTERNAL_WRITE on the column — the migration landed', async () => {
        const id = await seedExternalWriteProposal();
        const row = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { kind: true, status: true },
        });
        expect(row.kind).toBe('EXTERNAL_WRITE');
        expect(row.status).toBe('PENDING');
    });
});

describe('but nothing can create one through the app', () => {
    it('refuses it by NAME, not as an unknown kind', async () => {
        // The distinction matters to whoever reads the error: it is a known kind
        // with no creation seam, not a missing enum value. A refusal that
        // misdescribes the cause sends them looking in the wrong place.
        await expect(
            createAgentProposal(ctx(), {
                kind: 'EXTERNAL_WRITE',
                payload: { empNumber: 7 },
            } as unknown as Parameters<typeof createAgentProposal>[1]),
        ).rejects.toThrow(/not created through this usecase/);
    });

    it('and the refusal is about THIS kind, not about every kind', async () => {
        // The positive control. A guard that refused everything would satisfy the
        // assertion above while saying nothing about EXTERNAL_WRITE — so a RISK
        // proposal must get PAST this guard. It is allowed to fail later on its
        // own payload; what it must not do is fail with the external-write
        // refusal.
        let message = '';
        try {
            await createAgentProposal(ctx(), {
                kind: 'RISK',
                payload: { title: 'a risk', description: 'x'.repeat(40) },
            } as unknown as Parameters<typeof createAgentProposal>[1]);
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).not.toMatch(/not created through this usecase/);
    });
});

describe('and one that exists by other means cannot be approved', () => {
    it('refuses, and LEAVES THE ROW PENDING', async () => {
        // The claim that matters. `approveAgentProposal` flips the row to
        // ACCEPTED and never hands that back on failure, so a refusal placed
        // after the claim would burn the proposal permanently — ACCEPTED, nothing
        // dispatched, no retry. `rejects.toThrow` alone cannot tell the two
        // placements apart; the status afterwards can — and does, on this shape
        // of row. Mutation-checked by MOVING the guard below the claim.
        const id = await seedExternalWriteProposal();

        await expect(approveAgentProposal(ctx(), id)).rejects.toThrow(/cannot be approved yet/);

        const after = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { status: true, createdEntityId: true },
        });
        expect(after.status).toBe('PENDING');
        // And nothing of ours was created on the way past, which is the other
        // half: this kind names no entity of ours to create.
        expect(after.createdEntityId).toBeNull();
    });
});

describe('but it can always be REJECTED', () => {
    it('rejects, because narrowing is never gated', () => rejectsCleanly());

    /**
     * Extracted so the assertion reads as one claim. Rejecting withdraws an
     * authority, and every gate in this subsystem is deliberately one-directional
     * for that reason — `clearPriorStateRead` takes no catalogue call, the ladder
     * refuses no narrowing, and an operator taking something away is never told
     * to wait for a capability that does not exist yet.
     *
     * The guard that blocked this was a copy of the APPROVE guard, placed in
     * `rejectAgentProposal` by a replace-all that matched the same anchor in both
     * functions. Its own comment gave it away — it explains that "the claim flips
     * the row to ACCEPTED", which is not something rejecting does.
     */
    async function rejectsCleanly() {
        const id = await seedExternalWriteProposal();
        await rejectAgentProposal(ctx(), id);
        const after = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { status: true },
        });
        expect(after.status).toBe('REJECTED');
    }
});
