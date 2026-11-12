/**
 * THE PROCESS_MAP PROPOSAL, DEPLOY 2 OF 2: PROPOSED, REVIEWED, CREATED (#5053).
 *
 * Replaces deploy 1's `agent-proposal-process-map-kind.test.ts`, which proved
 * the kind was read and never written. Against a real database, this proves:
 *
 *   1. `propose_process_map` queues one PENDING row per map, stored in
 *      canonical form, and creates no map;
 *   2. approval creates exactly one map — DRAFT, Document mode, the approver
 *      its creator — with its steps, its `flow` arrows and nothing else, at the
 *      boxes the review diff showed, and the CREATE audit row names the
 *      proposal;
 *   3. every refusal sits before the signature and the claim, so the row stays
 *      PENDING with no signature and no map: edits, a tampered payload, an
 *      approver without `processes.edit` (one `AUTHZ_DENIED` row), an API key;
 *   4. creation is one transaction: a failing graph save leaves no map;
 *   5. a READER cannot queue one, and a map approved in one tenant is not
 *      visible from another.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    approveAgentProposal,
    createAgentProposal,
    getAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { runInTenantContext } from '@/lib/db-context';
import { buildProposalDiffs } from '@/app-layer/usecases/agent-proposal-diff';
import { getProcessMap } from '@/app-layer/usecases/process-map';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { PROCESS_MAP_PROPOSALS_IMPLEMENTED } from '@/lib/agentic/proposal-kind-rollout';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(90_000);

const T = 'pm-proposal-tenant';
const T_OTHER = 'pm-proposal-other';
const OWNER = 'pm-proposal-owner';
const EDITOR = 'pm-proposal-editor';
const READER = 'pm-proposal-reader';
const OTHER = 'pm-proposal-other-owner';

const ownerCtx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: OWNER });

/** An EDITOR whose custom role withholds `processes.edit` on a write-capable base. */
const editorWithoutProcessesEdit = (): RequestContext =>
    makeRequestContext('EDITOR', {
        tenantId: T,
        tenantSlug: T,
        userId: EDITOR,
        appPermissions: { ...getPermissionsForRole('EDITOR'), processes: { edit: false } },
    });

async function seedMember(tenantId: string, userId: string, role: 'OWNER' | 'EDITOR' | 'READER'): Promise<void> {
    const email = `${userId}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { role, status: 'ACTIVE' },
        create: { tenantId, userId, role, status: 'ACTIVE' },
    });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: tenantId, slug: tenantId } });
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        create: { tenantId, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
    });
}

async function clearTenant(tenantId: string): Promise<void> {
    await prisma.agentProposal.deleteMany({ where: { tenantId } });
    await prisma.processEdge.deleteMany({ where: { tenantId } });
    await prisma.processNode.deleteMany({ where: { tenantId } });
    await prisma.processMapSnapshot.deleteMany({ where: { tenantId } });
    await prisma.processMap.deleteMany({ where: { tenantId } });
}

beforeAll(async () => {
    await seedTenant(T);
    await seedTenant(T_OTHER);
    await seedMember(T, OWNER, 'OWNER');
    await seedMember(T, EDITOR, 'EDITOR');
    await seedMember(T, READER, 'READER');
    await seedMember(T_OTHER, OTHER, 'OWNER');
});

beforeEach(async () => {
    await clearTenant(T);
    await clearTenant(T_OTHER);
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    await clearTenant(T);
    await clearTenant(T_OTHER);
    await deleteAuditRowsForTenants(prisma, [T, T_OTHER]);
    await prisma.$disconnect();
});

/** Three steps, two arrows, with the agent's own keys. */
const MAP = {
    name: 'Joiner onboarding',
    description: 'From signed offer to first-day access.',
    nodes: [
        { nodeKey: 'offer', label: 'Offer signed' },
        { nodeKey: 'check', nodeType: 'decision', label: 'Background check passed?' },
        { nodeKey: 'grant', label: 'Accounts provisioned', subtitle: 'Least privilege' },
    ],
    edges: [
        { sourceKey: 'offer', targetKey: 'check' },
        { sourceKey: 'check', targetKey: 'grant', labelOverride: 'Yes' },
    ],
};

async function propose(ctx: RequestContext = ownerCtx()): Promise<string> {
    const r = await createAgentProposal(ctx, { kind: 'PROCESS_MAP', payload: MAP, policyCardVersion: 0 });
    return r.id;
}

async function refusal(p: Promise<unknown>): Promise<{ status?: number; reason?: unknown; message: string }> {
    try {
        await p;
    } catch (e) {
        const err = e as { status?: number; message: string; details?: { reason?: unknown } };
        return { status: err.status, reason: err.details?.reason, message: err.message };
    }
    throw new Error('expected a refusal, and the call succeeded');
}

/** The row stayed PENDING, unsigned, and no map exists. */
async function expectUntouched(id: string): Promise<void> {
    const row = await prisma.agentProposal.findUniqueOrThrow({
        where: { id },
        select: { status: true, createdEntityId: true },
    });
    expect(row).toEqual({ status: 'PENDING', createdEntityId: null });
    expect(await prisma.agentProposalApproval.count({ where: { proposalId: id } })).toBe(0);
    expect(await prisma.processMap.count({ where: { tenantId: T } })).toBe(0);
}

/**
 * Every case here is the RELEASED side of the brake, so the suite follows it
 * rather than pinning it: setting `PROCESS_MAP_PROPOSALS_IMPLEMENTED` back to
 * false skips these and leaves the refused side to
 * `agent-proposal-process-map-brake.test.ts`, which holds it with the brake
 * forced off. A rollback stays the one-line diff the brake promises.
 */
const describeReleased = PROCESS_MAP_PROPOSALS_IMPLEMENTED ? describe : describe.skip;

describeReleased('proposing', () => {
    it('propose_process_map queues one PENDING row per map, canonical, and creates no map', async () => {
        const inv = await resolveMcpInvocation(ownerCtx());
        await runProposeTool(inv, 'propose_process_map', { items: [MAP, { ...MAP, name: 'Second map' }] });

        // Read through the usecase: the payload is encrypted at rest.
        const ids = await prisma.agentProposal.findMany({
            where: { tenantId: T, kind: 'PROCESS_MAP' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
        });
        const rows = await Promise.all(ids.map((r) => getAgentProposal(ownerCtx(), r.id)));
        expect(rows.map((r) => [r.status, r.operation])).toEqual([
            ['PENDING', 'CREATE'],
            ['PENDING', 'CREATE'],
        ]);
        const stored = JSON.parse(rows[0].payloadJson);
        expect(stored.nodes.map((n: { nodeKey: string }) => n.nodeKey)).toEqual(['n1', 'n2', 'n3']);
        expect(stored.edges).toEqual([
            { sourceKey: 'n1', targetKey: 'n2' },
            { sourceKey: 'n2', targetKey: 'n3', labelOverride: 'Yes' },
        ]);
        expect(rows[0].payloadJson).not.toMatch(/"(offer|check|grant)"/);
        expect(await prisma.processMap.count({ where: { tenantId: T } })).toBe(0);
    });

    it('a READER calling the tool is refused and nothing is queued', async () => {
        const ctx = makeRequestContext('READER', { tenantId: T, tenantSlug: T, userId: READER });
        const inv = await resolveMcpInvocation(ctx);
        await expect(runProposeTool(inv, 'propose_process_map', { items: [MAP] })).rejects.toThrow();
        expect(await prisma.agentProposal.count({ where: { tenantId: T } })).toBe(0);
        expect(
            await prisma.auditLog.count({ where: { tenantId: T, userId: READER, action: 'AUTHZ_DENIED' } }),
        ).toBeGreaterThanOrEqual(1);
    });

    it('a map whose arrow names an unknown step is a 400 at propose time, and nothing is stored', async () => {
        const bad = { ...MAP, edges: [{ sourceKey: 'offer', targetKey: 'nowhere' }] };
        const r = await refusal(createAgentProposal(ownerCtx(), { kind: 'PROCESS_MAP', payload: bad, policyCardVersion: 0 }));
        expect(r.status).toBe(400);
        expect(await prisma.agentProposal.count({ where: { tenantId: T } })).toBe(0);
    });
});

describeReleased('approving', () => {
    it('creates exactly one DRAFT Document-mode map, at the boxes the review showed', async () => {
        const id = await propose();
        const row = await getAgentProposal(ownerCtx(), id);
        const diff = (await buildProposalDiffs(ownerCtx(), [row])).get(id)!;
        expect(diff.status).toBe('CREATE');
        const shown = diff.processMap!.steps.map((s) => [s.key, s.box.x, s.box.y]);

        const outcome = await approveAgentProposal(ownerCtx(), id);
        expect(outcome.status).toBe('ACCEPTED');

        const maps = await prisma.processMap.findMany({ where: { tenantId: T } });
        expect(maps).toHaveLength(1);
        const map = maps[0];
        expect(outcome.createdEntityId).toBe(map.id);
        expect([map.status, map.canvasMode, map.createdByUserId, map.version]).toEqual(['DRAFT', 'DOCUMENT', OWNER, 2]);

        const nodes = await prisma.processNode.findMany({ where: { tenantId: T, processMapId: map.id }, orderBy: { nodeKey: 'asc' } });
        expect(nodes.map((n) => [n.nodeKey, n.posX, n.posY])).toEqual(shown);
        expect(nodes.map((n) => n.nodeType)).toEqual(['processStep', 'decision', 'processStep']);
        const edges = await prisma.processEdge.findMany({ where: { tenantId: T, processMapId: map.id } });
        expect(edges).toHaveLength(2);
        expect(new Set(edges.map((e) => e.edgeKind))).toEqual(new Set(['flow']));
        expect(await prisma.processEdgeControl.count({ where: { tenantId: T } })).toBe(0);
        expect(await prisma.automationRule.count({ where: { tenantId: T } })).toBe(0);
        expect(await prisma.processMapSnapshot.count({ where: { tenantId: T, processMapId: map.id } })).toBe(1);

        // Through the read the canvas page loads a map with, not the raw rows:
        // the map that opens is the map the review showed, labels included.
        // (The read carries no canvas mode; DOCUMENT is asserted on the row above.)
        const opened = await getProcessMap(ownerCtx(), map.id);
        expect([opened.id, opened.status, opened.name]).toEqual([map.id, 'DRAFT', 'Joiner onboarding']);
        expect(opened.nodes.map((n) => [n.nodeKey, n.label, n.subtitle ?? null, n.posX, n.posY])).toEqual(
            diff.processMap!.steps.map((s) => [s.key, s.label, s.subtitle, s.box.x, s.box.y]),
        );
        expect(
            opened.edges.map((e) => [e.sourceKey, e.targetKey, e.labelOverride ?? null, e.edgeKind]),
        ).toEqual(diff.processMap!.arrows.map((a) => [a.fromKey, a.toKey, a.label, 'flow']));
        expect(opened.edges.map((e) => e.labelOverride ?? null)).toEqual([null, 'Yes']);
        expect(opened.nodes.map((n) => n.label)).toEqual([
            'Offer signed',
            'Background check passed?',
            'Accounts provisioned',
        ]);
        expect(opened.nodes[2].subtitle).toBe('Least privilege');

        const accepted = await prisma.agentProposal.findUniqueOrThrow({ where: { id }, select: { status: true, createdEntityId: true } });
        expect(accepted).toEqual({ status: 'ACCEPTED', createdEntityId: map.id });

        // The usecase's own CREATE row (`operation: 'created'`), not the one the
        // Prisma audit extension writes for the insert.
        const creates = await prisma.auditLog.findMany({
            where: { tenantId: T, entity: 'ProcessMap', entityId: map.id, action: 'CREATE' },
            select: { detailsJson: true },
        });
        const lifecycle = creates
            .map((r) => r.detailsJson as { operation?: string; after?: { sourceProposalId?: string } } | null)
            .find((d) => d?.operation === 'created');
        expect(lifecycle?.after?.sourceProposalId).toBe(id);
    });

    it('refuses edits with a 400, by reason, and the row stays PENDING and unsigned', async () => {
        const id = await propose();
        const r = await refusal(approveAgentProposal(ownerCtx(), id, { edits: { name: 'Renamed' } }));
        expect([r.status, r.reason]).toEqual([400, 'PROCESS_MAP_PROPOSAL_NOT_EDITABLE']);
        await expectUntouched(id);
    });

    it('refuses a stored payload tampered after review (a dangling arrow) before the claim', async () => {
        const id = await propose();
        const row = await getAgentProposal(ownerCtx(), id);
        const tampered = JSON.parse(row.payloadJson);
        tampered.edges.push({ sourceKey: 'n1', targetKey: 'n9' });
        // Through the app client, so the tampered payload is encrypted as a real one is.
        await runInTenantContext(ownerCtx(), (db) =>
            db.agentProposal.update({ where: { id }, data: { payloadJson: JSON.stringify(tampered) } }),
        );

        const r = await refusal(approveAgentProposal(ownerCtx(), id));
        expect([r.status, r.reason]).toEqual([400, 'PROCESS_MAP_PROPOSAL_UNREADABLE']);
        await expectUntouched(id);
    });

    it('refuses an approver without processes.edit with a 403 and ONE AUTHZ_DENIED row', async () => {
        const id = await propose();
        const deniedBefore = await prisma.auditLog.count({ where: { tenantId: T, userId: EDITOR, action: 'AUTHZ_DENIED' } });

        const r = await refusal(approveAgentProposal(editorWithoutProcessesEdit(), id));
        expect([r.status, r.reason]).toEqual([403, 'PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT']);

        expect(await prisma.auditLog.count({ where: { tenantId: T, userId: EDITOR, action: 'AUTHZ_DENIED' } })).toBe(
            deniedBefore + 1,
        );
        await expectUntouched(id);
    });

    it('refuses an API key as a credential, not as a processes.edit denial', async () => {
        const id = await propose();
        const ctx = makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: OWNER, apiKeyId: 'key-1' });
        const r = await refusal(approveAgentProposal(ctx, id));
        expect([r.status, r.message]).toEqual([403, 'agent_proposal_human_review_required']);
        await expectUntouched(id);
    });

    it('is one transaction: a failing graph save leaves no map behind', async () => {
        const id = await propose();
        jest.spyOn(ProcessMapRepository, 'replaceGraph').mockRejectedValueOnce(new Error('forced graph failure'));

        await expect(approveAgentProposal(ownerCtx(), id)).rejects.toThrow('forced graph failure');
        expect(await prisma.processMap.count({ where: { tenantId: T } })).toBe(0);
        expect(await prisma.processNode.count({ where: { tenantId: T } })).toBe(0);
    });

    it('a map approved in one tenant is not visible from another', async () => {
        const id = await propose();
        const { createdEntityId } = await approveAgentProposal(ownerCtx(), id);
        const otherCtx = makeRequestContext('OWNER', { tenantId: T_OTHER, tenantSlug: T_OTHER, userId: OTHER });
        await expect(getProcessMap(otherCtx, createdEntityId!)).rejects.toThrow(/not found/i);
        expect(await prisma.processMap.count({ where: { tenantId: T_OTHER } })).toBe(0);
    });
});
