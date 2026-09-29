/**
 * THE EXTERNAL_WRITE PROPOSAL KIND, BEFORE ANYTHING CREATES ONE (#2861).
 *
 * The `PROPOSE_ONLY` rung queues an external write for human approval, and it
 * reuses `AgentProposal` for that — the four-eyes database trigger, the output
 * guard, the expiry window and the sample audits already live there, and a
 * second copy of that composition is the failure this subsystem has paid for
 * once already.
 *
 * The kind is now CREATABLE — the `PROPOSE_ONLY` arm of `dispatchWrite` queues
 * one — but still NOT APPROVABLE, because approving one dispatches an MCP call
 * and that job is the next slice. That asymmetry is the "control arrives before
 * the authority" ordering #2933 used, and it is safe because `EXTERNAL_MAX_MODE`
 * is `DRY_RUN`: no connection can sit at `PROPOSE_ONLY` to queue one at all.
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
import { approveAgentProposal, createAgentProposal } from '@/app-layer/usecases/agent-proposals';

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

/** Everything a reviewer needs: where, what, what changes, what it replaces. */
const VALID_PAYLOAD = {
    connectionId: 'cmconnaaaaaaaaaaaaaaaaaa',
    connectionName: 'HRM',
    endpointUrl: 'https://hrm.example.test/mcp',
    toolName: 'mcp__cmconnaaaaaaaaaaaaaaaaaa__set_employee_work_email',
    advertisedToolName: 'set_employee_work_email',
    arguments: { empNumber: 7, workEmail: 'new@example.test' },
    priorState: { workEmail: 'old@example.test' },
};

/** A row of the new kind, inserted directly rather than through the dispatch. */
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

describe('what the payload must carry', () => {
    it('refuses a payload that is not an external write at all', async () => {
        // It validates against `ExternalWriteProposalPayloadSchema`, not against
        // one of our entity create-schemas. A bare object is refused for the
        // fields a REVIEWER needs — where it goes, what is called, what changes,
        // what it replaces — rather than for a missing entity field.
        await expect(
            createAgentProposal(ctx(), {
                kind: 'EXTERNAL_WRITE',
                payload: { empNumber: 7 },
                policyCardVersion: 0,
            } as unknown as Parameters<typeof createAgentProposal>[1]),
        ).rejects.toThrow(/Proposed EXTERNAL_WRITE is invalid/);
    });

    it('refuses an UPDATE-shaped one, because its diff could never resolve', async () => {
        // Measured in the previous slice: `buildProposalDiff` resolves an
        // UPDATE's target against one of OUR tables, so an external write shaped
        // as an UPDATE answers TARGET_MISSING and can never be approved. Refusing
        // it at creation is better than storing a row that is unapprovable.
        await expect(
            createAgentProposal(ctx(), {
                kind: 'EXTERNAL_WRITE',
                operation: 'UPDATE',
                targetEntityId: 'emp-7',
                payload: VALID_PAYLOAD,
                policyCardVersion: 0,
            } as unknown as Parameters<typeof createAgentProposal>[1]),
        ).rejects.toThrow(/CREATE-shaped/);
    });

    it('accepts a complete one and queues it PENDING', async () => {
        const res = await createAgentProposal(ctx(), {
            kind: 'EXTERNAL_WRITE',
            payload: VALID_PAYLOAD,
            policyCardVersion: 0,
        } as unknown as Parameters<typeof createAgentProposal>[1]);
        expect(res.kind).toBe('EXTERNAL_WRITE');
        expect(res.status).toBe('PENDING');
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

describe('approving one opens the journal row, and sends nothing', () => {
    /** A live MCP connection at the rung the write was proposed under. */
    async function seedConnection(mode: string) {
        return prisma.integrationConnection.upsert({
            where: { id: VALID_PAYLOAD.connectionId },
            update: { externalWriteMode: mode, isEnabled: true },
            create: {
                id: VALID_PAYLOAD.connectionId,
                tenantId: T,
                provider: 'mcp-server',
                name: VALID_PAYLOAD.connectionName,
                configJson: { url: VALID_PAYLOAD.endpointUrl },
                externalWriteMode: mode,
            },
        });
    }

    async function queue() {
        const r = await createAgentProposal(ctx(), {
            kind: 'EXTERNAL_WRITE',
            payload: VALID_PAYLOAD,
            policyCardVersion: 0,
        } as unknown as Parameters<typeof createAgentProposal>[1]);
        return r.id;
    }

    it('resolves to a PENDING journal row, not to a record of ours', async () => {
        // `createdEntityId` is the journal id. That keeps it non-null, which is
        // what preserves the approve route's distinction between an applied
        // approval and an AWAITING_APPROVAL one — and the row is PENDING, because
        // approving decides that it may be sent, not that it was.
        await seedConnection('PROPOSE_ONLY');
        const id = await queue();

        const out = await approveAgentProposal(ctx(), id);
        const journalId = (out as { createdEntityId: string }).createdEntityId;
        expect(journalId).toBeTruthy();

        const row = await prisma.externalWriteJournal.findUniqueOrThrow({
            where: { id: journalId },
            select: { outcome: true, toolName: true, settledAt: true },
        });
        expect(row.outcome).toBe('PENDING');
        expect(row.toolName).toBe(VALID_PAYLOAD.toolName);
        // Nothing has reported back, because nothing has been sent.
        expect(row.settledAt).toBeNull();
    });

    it('REFUSES when the rung was narrowed after the write was proposed', async () => {
        // The check that makes an operator's withdrawal take effect in front of
        // the person approving, rather than hours later inside a job. `beginWrite`
        // refuses DRY_RUN, so opening the row here IS the re-check.
        await seedConnection('PROPOSE_ONLY');
        const id = await queue();
        await seedConnection('DRY_RUN');

        await expect(approveAgentProposal(ctx(), id)).rejects.toThrow(/now at DRY_RUN/);
    });

    it('REFUSES a payload that is no longer well-formed', async () => {
        // Seeded directly with a payload that does not satisfy its own schema.
        // Dispatching on a guess is the one thing that must not happen.
        await seedConnection('PROPOSE_ONLY');
        const id = await seedExternalWriteProposal();
        await expect(approveAgentProposal(ctx(), id)).rejects.toThrow(/well-formed external write/);
    });
});
