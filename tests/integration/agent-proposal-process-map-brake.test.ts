/**
 * THE PROCESS_MAP BRAKE, HELD OFF (#5053): WHAT A ROLLBACK RELIES ON.
 *
 * `PROCESS_MAP_PROPOSALS_IMPLEMENTED` is released in this release, so nothing
 * in the shipped code runs its refused side — and the refused side is exactly
 * what setting it back to false depends on in an emergency. This suite forces
 * the brake OFF for the modules it loads and proves, against a real database,
 * that every gate it feeds still holds:
 *
 *   1. `createAgentProposal` refuses the kind for EVERY shape, by reason, and
 *      stores nothing — and the refusal is about this kind, not every kind;
 *   2. a row already queued is refused at approve BEFORE the signature insert
 *      and BEFORE the claim, so it stays PENDING with no approval row and no
 *      map — never ACCEPTED with nothing created;
 *   3. such a row is read by the queue and the diff builder, is shown as
 *      KIND_NOT_APPROVABLE (never PAYLOAD_UNREADABLE: it is well formed), and
 *      so is not reviewable;
 *   4. it can still be REJECTED;
 *   5. `propose_process_map` is withdrawn from the agent's catalogue.
 *
 * The brake is forced through the module's own export and through
 * `withheldProposalDiff`'s parameter, so the bodies under test are the real
 * ones; only the flag's value is changed.
 *
 * ## Why the seeded row is a VALID canonical map
 *
 * So that the brake is the only thing that can refuse it. With the brake's
 * gate deleted, approval of this row succeeds and creates a map, and every
 * assertion below turns red — an invalid payload would be refused anyway, for
 * another reason, and prove nothing about the brake.
 */
jest.mock('@/lib/agentic/proposal-kind-rollout', () => {
    const actual = jest.requireActual('@/lib/agentic/proposal-kind-rollout');
    return {
        ...actual,
        PROCESS_MAP_PROPOSALS_IMPLEMENTED: false,
        withheldProposalDiff: (kind: string) => actual.withheldProposalDiff(kind, false),
    };
});

import { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    PROCESS_MAP_PROPOSALS_NOT_AVAILABLE,
    approveAgentProposal,
    createAgentProposal,
    listAgentProposals,
    rejectAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { buildProposalDiffs } from '@/app-layer/usecases/agent-proposal-diff';
import { isDiffReviewable } from '@/lib/agentic/proposal-diff';
import { PROCESS_MAP_PROPOSALS_IMPLEMENTED } from '@/lib/agentic/proposal-kind-rollout';
import { PROPOSE_TOOLS, loadableProposeTools } from '@/lib/mcp/tools/propose-tools';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { runInTenantContext } from '@/lib/db-context';
import {
    ProposedProcessMapSchema,
    canonicaliseProposedProcessMap,
} from '@/lib/agentic/process-map-proposal';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T = 'process-map-brake-tenant';
const U = 'process-map-brake-user';

const ctx = () => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: U });

beforeAll(async () => {
    // `upsert` throughout: `resetDatabase` does not truncate `Tenant` or `User`.
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

async function clearTenant(): Promise<void> {
    // Signatures cascade with their proposal.
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
    await prisma.processEdge.deleteMany({ where: { tenantId: T } });
    await prisma.processNode.deleteMany({ where: { tenantId: T } });
    await prisma.processMapSnapshot.deleteMany({ where: { tenantId: T } });
    await prisma.processMap.deleteMany({ where: { tenantId: T } });
}

beforeEach(clearTenant);

afterAll(async () => {
    await clearTenant();
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$disconnect();
});

/** A well-formed map, as `propose_process_map` would have stored it. */
const MAP = canonicaliseProposedProcessMap(
    ProposedProcessMapSchema.parse({
        name: 'Joiner onboarding',
        description: 'From signed offer to first-day access.',
        nodes: [
            { nodeKey: 'offer', label: 'Offer signed' },
            { nodeKey: 'check', nodeType: 'decision', label: 'Background check passed?' },
            { nodeKey: 'grant', label: 'Accounts provisioned' },
        ],
        edges: [
            { sourceKey: 'offer', targetKey: 'check' },
            { sourceKey: 'check', targetKey: 'grant', labelOverride: 'Yes' },
        ],
    }),
);

/**
 * A row queued before the brake was set back, written through the app client
 * so its payload is encrypted as a real one is.
 */
async function seedQueuedMap(): Promise<string> {
    const row = await runInTenantContext(ctx(), (db) =>
        db.agentProposal.create({
            data: {
                tenantId: T,
                kind: 'PROCESS_MAP',
                operation: 'CREATE',
                status: 'PENDING',
                payloadJson: JSON.stringify(MAP),
            },
            select: { id: true },
        }),
    );
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

describe('the brake, forced off', () => {
    it('reads as false to every module this suite loads', () => {
        expect(PROCESS_MAP_PROPOSALS_IMPLEMENTED).toBe(false);
    });
});

describe('nothing writes one', () => {
    it.each([
        ['CREATE', {}],
        // An UPDATE would otherwise be refused by the CREATE-only check with a
        // different sentence. The brake's refusal comes first, for every shape.
        ['UPDATE', { targetEntityId: 'map-1' }],
    ] as const)('refuses a %s-shaped PROCESS_MAP by reason, and stores nothing', async (operation, extra) => {
        const reason = await refusalReason(
            createAgentProposal(ctx(), {
                kind: 'PROCESS_MAP',
                operation,
                ...extra,
                payload: MAP,
                policyCardVersion: 0,
            } as unknown as Parameters<typeof createAgentProposal>[1]),
        );
        expect(reason).toBe(PROCESS_MAP_PROPOSALS_NOT_AVAILABLE);
        expect(await prisma.agentProposal.count({ where: { tenantId: T } })).toBe(0);
    });

    it('and the refusal is about THIS kind, not about every kind', async () => {
        // The positive control: a RISK proposal goes through with the brake off.
        const r = await createAgentProposal(ctx(), {
            kind: 'RISK',
            payload: { title: 'a risk', description: 'x'.repeat(40) },
            policyCardVersion: 0,
        } as unknown as Parameters<typeof createAgentProposal>[1]);
        expect(r.id).toEqual(expect.any(String));
    });

    it('propose_process_map is withdrawn from the catalogue, and the other propose tools are not', async () => {
        const names = loadableProposeTools(await resolveMcpInvocation(ctx())).map((t) => t.name);
        expect(names).not.toContain('propose_process_map');
        expect(names.sort()).toEqual(
            PROPOSE_TOOLS.filter((t) => t.kind !== 'PROCESS_MAP').map((t) => t.name).sort(),
        );
    });
});

describe('a row queued before the brake was set back', () => {
    it('is refused at approve, and stays PENDING with nothing signed or created', async () => {
        const id = await seedQueuedMap();

        expect(await refusalReason(approveAgentProposal(ctx(), id))).toBe(PROCESS_MAP_PROPOSALS_NOT_AVAILABLE);

        const after = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { status: true, createdEntityId: true },
        });
        // Not ACCEPTED: the refusal sits before the claim.
        expect(after).toEqual({ status: 'PENDING', createdEntityId: null });
        // Not signed: the refusal sits before the signature insert too.
        expect(await prisma.agentProposalApproval.count({ where: { proposalId: id } })).toBe(0);
        expect(await prisma.processMap.count({ where: { tenantId: T } })).toBe(0);
    });

    it('is read by the queue and the diff builder, as KIND_NOT_APPROVABLE, and is not reviewable', async () => {
        const id = await seedQueuedMap();

        const listed = await listAgentProposals(ctx(), { status: 'PENDING' });
        expect(listed.find((r) => r.id === id)?.kind).toBe('PROCESS_MAP');

        const row = await runInTenantContext(ctx(), (db) =>
            db.agentProposal.findUniqueOrThrow({
                where: { id },
                select: { id: true, kind: true, operation: true, payloadJson: true, targetEntityId: true },
            }),
        );
        const diff = (await buildProposalDiffs(ctx(), [row])).get(id);
        // Its own status, never PAYLOAD_UNREADABLE: the row is well formed.
        expect(diff?.status).toBe('KIND_NOT_APPROVABLE');
        // Not reviewable, so neither the queue nor the canvas review panel
        // offers Approve on it while the brake is on.
        expect(isDiffReviewable(diff!)).toBe(false);
    });

    it('can be REJECTED, because narrowing is never gated', async () => {
        const id = await seedQueuedMap();
        await rejectAgentProposal(ctx(), id);
        const after = await prisma.agentProposal.findUniqueOrThrow({
            where: { id },
            select: { status: true },
        });
        expect(after.status).toBe('REJECTED');
    });
});
