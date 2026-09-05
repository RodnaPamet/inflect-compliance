/**
 * Integration coverage: the propose-not-commit write path end-to-end (real MCP
 * route + real TenantApiKey + real RLS + real approval usecase). Proves the
 * load-bearing safety property and the boundary controls:
 *   - propose_* creates a PENDING AgentProposal, NOT a real record;
 *   - human approval runs the REAL create-usecase → the record now exists;
 *   - reject creates nothing;
 *   - a malformed proposal is refused at the tool, never queued;
 *   - a key without mcp:propose is refused (scope);
 *   - cross-tenant: a human cannot approve another tenant's proposal (RLS);
 *   - a prompt-injection payload is sanitised before it enters the queue.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';
import {
    approveAgentProposal,
    rejectAgentProposal,
    listAgentProposals,
    wasApplied,
} from '@/app-layer/usecases/agent-proposals';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `mcpp-${randomUUID().slice(0, 8)}`;
const TENANT_A = `pa-${SUITE}`;
const TENANT_B = `pb-${SUITE}`;

let keyPropose = ''; // A: mcp:read + mcp:propose + risks:read
let keyReadOnly = ''; // A: mcp:read + risks:read (NO propose)
let keyProposeB = ''; // B: mcp:read + mcp:propose + risks:read
let userA = '';
let userA2 = ''; // A SECOND human in tenant A — see the approval test below.
let userB = '';

async function mintKey(tenantId: string, userId: string, scopes: string[]): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId, name: scopes.join('+'), keyPrefix, keyHash, scopes, createdById: userId },
    });
    return plaintext;
}

async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try { json = await res.json(); } catch { /* noop */ }
    return { status: res.status, json };
}

function proposeRisks(token: string, id: number, items: unknown[]) {
    return rpc(token, {
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'propose_risks', arguments: { items } },
    });
}

function resultOf(json: unknown): { proposed: number; proposalIds: string[] } {
    const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    return JSON.parse(text);
}

async function seedTenant(tenantId: string, slug: string): Promise<string> {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: slug, slug } });
    const userId = `u-${slug}`;
    const email = `${slug}@example.test`;
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email, emailHash: hashForLookup(email) } });
    // The key's PRINCIPAL must be a live member of the tenant. `verifyApiKey`
    // derives the credential's role from its SCOPES, but as of Epic Agentic 2
    // `/api/mcp` also resolves `TenantApiKey.createdById` through the same
    // `resolveTenantContext` a signed-in human goes through and intersects the
    // two — a credential cannot exceed the person it speaks for, and a creator
    // who is not a member has no authority to lend. These fixtures minted keys
    // for a user with no membership at all, which used to work; the membership
    // is what the fixture was always implying.
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
    });
    // The agent-registration gate defaults to ENFORCING for a tenant with no
    // security-settings row, so a suite that mints a bare API key and calls
    // /api/mcp would now be refused. These fixtures predate the register and
    // test a different property; opt them out explicitly rather than
    // registering an agent they do not otherwise need. The gate's own
    // behaviour — both directions — is proved in
    // tests/integration/agent-registry-enforcement.test.ts.
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        update: { requireRegisteredAgent: false },
        create: { tenantId, requireRegisteredAgent: false },
    });
    return userId;
}

/** A second ACTIVE member of a tenant, so four-eyes has somebody to be. */
async function seedSecondReviewer(tenantId: string): Promise<string> {
    const userId = `u2-${tenantId}`;
    const email = `second-${tenantId}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { role: 'ADMIN', status: 'ACTIVE' },
        create: { tenantId, userId, role: 'ADMIN', status: 'ACTIVE' },
    });
    return userId;
}

const humanCtx = (tenantId: string, userId: string) =>
    makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId });

describeFn('MCP propose-not-commit (real route + approval)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        userA = await seedTenant(TENANT_A, TENANT_A);
        userB = await seedTenant(TENANT_B, TENANT_B);
        // A second reviewer in tenant A. These fixtures opt OUT of the
        // agent-registration gate (see `seedTenant`), so their proposals arrive
        // from a machine principal the register does not know — which
        // `resolveApprovalRequirement` scores at the strictest rung, two
        // approvers. That is deliberate: if turning the gate off also
        // DOWNGRADED the approval requirement, the gate would be a lever for
        // widening authority rather than narrowing it.
        userA2 = await seedSecondReviewer(TENANT_A);
        keyPropose = await mintKey(TENANT_A, userA, ['mcp:read', 'mcp:propose', 'risks:read']);
        keyReadOnly = await mintKey(TENANT_A, userA, ['mcp:read', 'risks:read']);
        keyProposeB = await mintKey(TENANT_B, userB, ['mcp:read', 'mcp:propose', 'risks:read']);
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentProposalApproval.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentProposal.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.risk.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: { in: [`u-${t}`, `u2-${t}`] } } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('propose_risks creates a PENDING proposal, NOT a real risk', async () => {
        const before = await prisma.risk.count({ where: { tenantId: TENANT_A } });
        const { status, json } = await proposeRisks(keyPropose, 1, [{ title: 'Proposed cloud-migration risk', description: 'x' }]);
        expect(status).toBe(200);
        const r = resultOf(json);
        expect(r.proposed).toBe(1);
        expect(r.proposalIds.length).toBe(1);

        // NO real risk was created.
        const after = await prisma.risk.count({ where: { tenantId: TENANT_A } });
        expect(after).toBe(before);
        // A PENDING proposal exists.
        const proposal = await prisma.agentProposal.findFirst({ where: { id: r.proposalIds[0] } });
        expect(proposal?.status).toBe('PENDING');
        expect(proposal?.kind).toBe('RISK');
    });

    it('human approval runs the REAL create-usecase → the risk now exists', async () => {
        const { json } = await proposeRisks(keyPropose, 2, [{ title: 'Risk to approve', description: 'y' }]);
        const id = resultOf(json).proposalIds[0];

        // The FIRST signature creates nothing — a proposal from an
        // unregistered machine principal needs two humans.
        const first = await approveAgentProposal(humanCtx(TENANT_A, userA), id);
        expect(first.status).toBe('AWAITING_APPROVAL');
        expect(first.createdEntityId).toBeNull();
        expect(await prisma.risk.findFirst({ where: { title: 'Risk to approve' } })).toBeNull();

        const result = await approveAgentProposal(humanCtx(TENANT_A, userA2), id);
        expect(result.createdEntityId).toBeTruthy();
        expect(result.status).toBe('ACCEPTED');

        // The real risk exists, linked from the proposal.
        // An approval that only RECORDED a signature applies nothing, so there is
        // no row to look for — narrow before reading the id.
        if (!wasApplied(result)) throw new Error('expected the proposal to be applied');
        const risk = await prisma.risk.findFirst({ where: { id: result.createdEntityId } });
        expect(risk?.tenantId).toBe(TENANT_A);
        const proposal = await prisma.agentProposal.findFirst({ where: { id } });
        expect(proposal?.status).toBe('ACCEPTED');
        expect(proposal?.createdEntityId).toBe(result.createdEntityId);
    });

    it('reject creates nothing', async () => {
        const { json } = await proposeRisks(keyPropose, 3, [{ title: 'Risk to reject', description: 'z' }]);
        const id = resultOf(json).proposalIds[0];
        const before = await prisma.risk.count({ where: { tenantId: TENANT_A } });

        await rejectAgentProposal(humanCtx(TENANT_A, userA), id);

        const after = await prisma.risk.count({ where: { tenantId: TENANT_A } });
        expect(after).toBe(before);
        const proposal = await prisma.agentProposal.findFirst({ where: { id } });
        expect(proposal?.status).toBe('REJECTED');
    });

    it('a malformed proposal is refused at the tool, never queued', async () => {
        const before = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });
        const { status, json } = await proposeRisks(keyPropose, 4, [{ description: 'no title!' }]);
        expect(status).toBe(200);
        const r = json as { error?: { message: string }; result?: unknown };
        expect(r.result).toBeUndefined();
        expect(r.error?.message).toMatch(/invalid|title/i);
        const after = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });
        expect(after).toBe(before);
    });

    it('a key WITHOUT mcp:propose is refused (scope)', async () => {
        const { status, json } = await proposeRisks(keyReadOnly, 5, [{ title: 'Should be blocked' }]);
        expect(status).toBe(200);
        const r = json as { error?: { message: string }; result?: unknown };
        expect(r.result).toBeUndefined();
        expect(r.error?.message).toMatch(/mcp:propose|capability/i);
    });

    it('cross-tenant: a human cannot approve another tenant\'s proposal (RLS)', async () => {
        const { json } = await proposeRisks(keyProposeB, 6, [{ title: 'Tenant B risk' }]);
        const bId = resultOf(json).proposalIds[0];
        // Tenant A admin tries to approve tenant B's proposal → not found (RLS).
        await expect(approveAgentProposal(humanCtx(TENANT_A, userA), bId)).rejects.toThrow();
        // And no risk leaked into A.
        const proposal = await prisma.agentProposal.findFirst({ where: { id: bId } });
        expect(proposal?.status).toBe('PENDING');
    });

    it('a prompt-injection payload is sanitised before entering the queue', async () => {
        const { json } = await proposeRisks(keyPropose, 7, [{
            title: '<script>alert(1)</script>Rogue risk',
            description: '<img src=x onerror=alert(1)>injected',
        }]);
        const id = resultOf(json).proposalIds[0];
        // Read back through the app path (decrypts) and confirm tags are stripped.
        const proposals = await listAgentProposals(humanCtx(TENANT_A, userA), {});
        const mine = proposals.find((p) => p.id === id);
        expect(mine).toBeDefined();
        expect(mine!.payloadJson).not.toMatch(/<script>/i);
        expect(mine!.payloadJson).not.toMatch(/onerror=/i);
    });
});
