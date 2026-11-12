/**
 * APPROVING A FINDING OR A RISK PROPOSAL TAKES THE KEY ITS ROUTE TAKES (#5369).
 *
 * The finding and risk routes gate on `findings.create` / `findings.edit` and
 * `risks.create` / `risks.edit`, but `createFinding` / `updateFinding` /
 * `createRisk` / `updateRisk` asserted only the role-tier write — and
 * `approveAgentProposal` runs them as the approver. So a custom role on an
 * EDITOR base with `findings.create: false` could not create a finding through
 * the API and could through the proposal queue.
 *
 * Against a real database:
 *
 *   1. the four usecases refuse a write-capable custom role that withholds the
 *      key, and write nothing;
 *   2. approving a proposal of each kind and operation is refused BEFORE the
 *      signature and the claim — 403 with a named reason, ONE `AUTHZ_DENIED`
 *      row, the proposal still PENDING and unsigned, nothing written;
 *   3. an ordinary EDITOR still creates and edits directly and approves each.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    approveAgentProposal,
    createAgentProposal,
    getAgentProposal,
} from '@/app-layer/usecases/agent-proposals';
import { buildProposalDiff } from '@/app-layer/usecases/agent-proposal-diff';
import { createFinding, updateFinding } from '@/app-layer/usecases/finding';
import { createRisk, updateRisk } from '@/app-layer/usecases/risk';
import { RECORD_APPROVER_REFUSALS } from '@/app-layer/usecases/proposal-kind-approval';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(90_000);

const T = 'granular-approve-tenant';
const OWNER = 'granular-approve-owner';
const EDITOR = 'granular-approve-editor';

const ownerCtx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: OWNER });
const editorCtx = (): RequestContext => makeRequestContext('EDITOR', { tenantId: T, tenantSlug: T, userId: EDITOR });

/** An EDITOR whose custom role withholds one granular flag on a write-capable base. */
function editorWithout(domain: 'findings' | 'risks', flag: 'create' | 'edit'): RequestContext {
    const editor = getPermissionsForRole('EDITOR');
    const appPermissions: PermissionSet = { ...editor, [domain]: { ...editor[domain], [flag]: false } };
    const ctx = makeRequestContext('EDITOR', { tenantId: T, tenantSlug: T, userId: EDITOR, appPermissions });
    // The precondition of the finding: the coarse write is still held.
    expect(ctx.permissions.canWrite).toBe(true);
    return ctx;
}

async function seedMember(userId: string, role: 'OWNER' | 'EDITOR'): Promise<void> {
    const email = `${userId}@example.test`;
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: T, userId } },
        update: { role, status: 'ACTIVE' },
        create: { tenantId: T, userId, role, status: 'ACTIVE' },
    });
}

async function clearTenant(): Promise<void> {
    await prisma.agentProposalApproval.deleteMany({ where: { tenantId: T } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
    await prisma.findingRisk.deleteMany({ where: { tenantId: T } });
    await prisma.finding.deleteMany({ where: { tenantId: T } });
    await prisma.riskScoreEvent.deleteMany({ where: { tenantId: T } });
    await prisma.risk.deleteMany({ where: { tenantId: T } });
}

beforeAll(async () => {
    await prisma.tenant.upsert({ where: { id: T }, update: {}, create: { id: T, name: T, slug: T } });
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: T },
        update: { requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
        create: { tenantId: T, requireRegisteredAgent: false, aiGuardMode: 'AUDIT' },
    });
    await seedMember(OWNER, 'OWNER');
    await seedMember(EDITOR, 'EDITOR');
});

beforeEach(async () => {
    await clearTenant();
});

afterAll(async () => {
    await clearTenant();
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$disconnect();
});

const FINDING = { severity: 'MEDIUM', type: 'NONCONFORMITY', title: 'Unreviewed firewall rule' };
const RISK = { title: 'Unpatched edge router', description: 'Seen in the last scan.' };

async function refusal(p: Promise<unknown>): Promise<{ status?: number; reason?: unknown }> {
    try {
        await p;
    } catch (e) {
        const err = e as { status?: number; details?: { reason?: unknown } };
        return { status: err.status, reason: err.details?.reason };
    }
    throw new Error('expected a refusal, and the call succeeded');
}

const deniedCount = () => prisma.auditLog.count({ where: { tenantId: T, userId: EDITOR, action: 'AUTHZ_DENIED' } });

async function expectPendingAndUnsigned(id: string): Promise<void> {
    const row = await prisma.agentProposal.findUniqueOrThrow({ where: { id }, select: { status: true, createdEntityId: true } });
    expect(row).toEqual({ status: 'PENDING', createdEntityId: null });
    expect(await prisma.agentProposalApproval.count({ where: { proposalId: id } })).toBe(0);
}

async function proposeCreate(kind: 'FINDING' | 'RISK'): Promise<string> {
    const r = await createAgentProposal(ownerCtx(), { kind, payload: kind === 'FINDING' ? FINDING : RISK, policyCardVersion: 0 });
    return r.id;
}

async function proposeUpdate(kind: 'FINDING' | 'RISK', targetEntityId: string): Promise<string> {
    const r = await createAgentProposal(ownerCtx(), {
        kind,
        operation: 'UPDATE',
        targetEntityId,
        payload: { title: 'Renamed by the agent' },
        policyCardVersion: 0,
    });
    return r.id;
}

/** Approve as `ctx`, binding the diff the way the review surface does for an UPDATE. */
async function approve(ctx: RequestContext, id: string) {
    const row = await getAgentProposal(ownerCtx(), id);
    if (row.operation !== 'UPDATE') return approveAgentProposal(ctx, id);
    const diff = await buildProposalDiff(ownerCtx(), row);
    return approveAgentProposal(ctx, id, { baseDigest: diff.baseDigest ?? undefined });
}

it('names each refusal', () => {
    expect(RECORD_APPROVER_REFUSALS.FINDING.CREATE.reason).toBe('FINDING_APPROVER_NEEDS_FINDINGS_CREATE');
    expect(RECORD_APPROVER_REFUSALS.FINDING.UPDATE.reason).toBe('FINDING_APPROVER_NEEDS_FINDINGS_EDIT');
    expect(RECORD_APPROVER_REFUSALS.RISK.CREATE.reason).toBe('RISK_APPROVER_NEEDS_RISKS_CREATE');
    expect(RECORD_APPROVER_REFUSALS.RISK.UPDATE.reason).toBe('RISK_APPROVER_NEEDS_RISKS_EDIT');
});

describe('findings', () => {
    it('createFinding refuses a write-capable role without findings.create, and writes nothing', async () => {
        const r = await refusal(createFinding(editorWithout('findings', 'create'), FINDING));
        expect(r.status).toBe(403);
        expect(await prisma.finding.count({ where: { tenantId: T } })).toBe(0);
    });

    it('approving a FINDING create proposal without findings.create is refused before the claim', async () => {
        const id = await proposeCreate('FINDING');
        const before = await deniedCount();
        const r = await refusal(approve(editorWithout('findings', 'create'), id));
        expect([r.status, r.reason]).toEqual([403, RECORD_APPROVER_REFUSALS.FINDING.CREATE.reason]);
        expect(await deniedCount()).toBe(before + 1);
        await expectPendingAndUnsigned(id);
        expect(await prisma.finding.count({ where: { tenantId: T } })).toBe(0);
    });

    it('updateFinding refuses a role without findings.edit; approving a FINDING update is refused too', async () => {
        const finding = await createFinding(ownerCtx(), FINDING);
        const r1 = await refusal(updateFinding(editorWithout('findings', 'edit'), finding.id, { title: 'Edited directly' }));
        expect(r1.status).toBe(403);

        const id = await proposeUpdate('FINDING', finding.id);
        const before = await deniedCount();
        const r2 = await refusal(approve(editorWithout('findings', 'edit'), id));
        expect([r2.status, r2.reason]).toEqual([403, RECORD_APPROVER_REFUSALS.FINDING.UPDATE.reason]);
        expect(await deniedCount()).toBe(before + 1);
        await expectPendingAndUnsigned(id);

        const stored = await prisma.finding.findUniqueOrThrow({ where: { id: finding.id }, select: { updatedAt: true } });
        expect(stored.updatedAt.getTime()).toBe(new Date(finding.updatedAt).getTime());
    });

    it('withholding findings.create does not stop approving a finding update', async () => {
        const finding = await createFinding(ownerCtx(), FINDING);
        const id = await proposeUpdate('FINDING', finding.id);
        const outcome = await approve(editorWithout('findings', 'create'), id);
        expect(outcome.status).toBe('ACCEPTED');
    });
});

describe('risks', () => {
    it('createRisk refuses a write-capable role without risks.create, and writes nothing', async () => {
        const r = await refusal(createRisk(editorWithout('risks', 'create'), RISK));
        expect(r.status).toBe(403);
        expect(await prisma.risk.count({ where: { tenantId: T } })).toBe(0);
    });

    it('approving a RISK create proposal without risks.create is refused before the claim', async () => {
        const id = await proposeCreate('RISK');
        const before = await deniedCount();
        const r = await refusal(approve(editorWithout('risks', 'create'), id));
        expect([r.status, r.reason]).toEqual([403, RECORD_APPROVER_REFUSALS.RISK.CREATE.reason]);
        expect(await deniedCount()).toBe(before + 1);
        await expectPendingAndUnsigned(id);
        expect(await prisma.risk.count({ where: { tenantId: T } })).toBe(0);
    });

    it('updateRisk refuses a role without risks.edit; approving a RISK update is refused too', async () => {
        const risk = await createRisk(ownerCtx(), RISK);
        const r1 = await refusal(updateRisk(editorWithout('risks', 'edit'), risk.id, { title: 'Edited directly' }));
        expect(r1.status).toBe(403);

        const id = await proposeUpdate('RISK', risk.id);
        const before = await deniedCount();
        const r2 = await refusal(approve(editorWithout('risks', 'edit'), id));
        expect([r2.status, r2.reason]).toEqual([403, RECORD_APPROVER_REFUSALS.RISK.UPDATE.reason]);
        expect(await deniedCount()).toBe(before + 1);
        await expectPendingAndUnsigned(id);

        const stored = await prisma.risk.findUniqueOrThrow({ where: { id: risk.id }, select: { title: true } });
        expect(stored.title).toBe(RISK.title);
    });
});

describe('an ordinary EDITOR is unaffected', () => {
    it('creates and edits a finding and a risk directly', async () => {
        const finding = await createFinding(editorCtx(), FINDING);
        await updateFinding(editorCtx(), finding.id, { title: 'Edited directly' });
        const risk = await createRisk(editorCtx(), RISK);
        await updateRisk(editorCtx(), risk.id, { title: 'Edited directly' });
        expect(await prisma.finding.count({ where: { tenantId: T } })).toBe(1);
        expect(await prisma.risk.count({ where: { tenantId: T } })).toBe(1);
    });

    it.each(['FINDING', 'RISK'] as const)('approves a %s create proposal and an update proposal', async (kind) => {
        const before = await deniedCount();
        const created = await approve(editorCtx(), await proposeCreate(kind));
        expect(created.status).toBe('ACCEPTED');
        expect(created.createdEntityId).toBeTruthy();

        const updated = await approve(editorCtx(), await proposeUpdate(kind, created.createdEntityId!));
        expect(updated.status).toBe('ACCEPTED');
        expect(await deniedCount()).toBe(before);
    });
});
