/**
 * A least-privilege key reaches an external tool over `/api/mcp` (#4485).
 *
 * The funnel checked an external tool's key scope as `external_tools:read`, a
 * resource the api-keys route has never minted, while its permission check
 * needed `admin:external_tools`. Only a `*` key satisfied both, so a key minted
 * with exactly the scopes its agent needs was refused every external tool.
 *
 * Driven through the REAL `/api/mcp` route with REAL `TenantApiKey` rows, a
 * real connection, a real manifest pin and a real grant. Only the far end is
 * faked: `listTools` advertises one read-only tool and `callTool` answers it.
 *
 *   • `mcp:read` + `admin:external_tools` reaches the tool, and the far end is
 *     called (the cell the defect failed);
 *   • `mcp:read` alone is refused, with one `AUTHZ_DENIED` row, and nothing is
 *     sent;
 *   • `*` reaches it, as before.
 */
const listToolsMock = jest.fn();
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    listTools: (...a: unknown[]) => listToolsMock(...a),
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer far-end-token'),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { hashForLookup } from '@/lib/security/encryption';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { POST } from '@/app/api/mcp/route';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `extscope-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-owner-${SUITE}`;

const READ_DEF = {
    name: 'get_worker',
    description: 'Read a worker.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
};

let agentId = '';
let TOOL = '';

async function mintKey(scopes: string[]): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId: TENANT, name: scopes.join('+'), keyPrefix, keyHash, scopes, createdById: OWNER, agentId },
    });
    return plaintext;
}

async function callTool(token: string): Promise<unknown> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: { id: 'w-1' } } }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    return res.json();
}

const contentOf = (json: unknown) => (json as { result?: { content?: Array<{ text: string }> } })?.result?.content;
const errorOf = (json: unknown) => (json as { error?: { message?: string } })?.error?.message;

async function scopeDenials(): Promise<Record<string, unknown>[]> {
    const rows = await prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
        orderBy: { createdAt: 'asc' },
        select: { detailsJson: true },
    });
    return rows.map((r) => r.detailsJson as Record<string, unknown>);
}

describeFn('an external tool on /api/mcp takes the scope a key can carry (#4485)', () => {
    beforeAll(async () => {
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${OWNER}@example.test`;
        await prisma.user.create({ data: { id: OWNER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: OWNER, role: 'OWNER', status: 'ACTIVE' } });
        const aiSystem = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: 'host', ownerUserId: OWNER } });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: 'external-scope-probe',
                // An external tool is rung 2, so the agent is registered at it.
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: OWNER,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        agentId = agent.id;
        const conn = await prisma.integrationConnection.create({
            data: {
                tenantId: TENANT,
                provider: 'mcp-server',
                name: 'HRM',
                isEnabled: true,
                configJson: { url: 'https://hrm-mcp.example.test/mcp' },
                externalWriteMode: 'DRY_RUN',
            },
        });
        TOOL = externalToolName(conn.id, READ_DEF.name);
        const h = hashToolManifest(READ_DEF);
        await prisma.mcpToolManifestPin.create({
            data: {
                tenantId: TENANT,
                toolName: TOOL,
                descriptionHash: h.descriptionHash,
                schemaHash: h.schemaHash,
                manifestHash: h.manifestHash,
                annotationsHash: h.annotationsHash,
                approvalSource: 'APPROVED',
                approvedByUserId: OWNER,
                revision: 1,
            },
        });
        await prisma.registeredAgentTool.create({ data: { tenantId: TENANT, agentId, toolName: TOOL, grantedByUserId: OWNER } });
    });

    beforeEach(() => {
        listToolsMock.mockReset().mockResolvedValue({ tools: [READ_DEF], refusedNames: 0 });
        callToolMock.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'worker w-1' }], isError: false });
    });

    afterAll(async () => {
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: TENANT } });
        await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.user.deleteMany({ where: { id: OWNER } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('a key with mcp:read and admin:external_tools reaches the tool, and the far end is called', async () => {
        const json = await callTool(await mintKey(['mcp:read', 'admin:external_tools']));
        expect(errorOf(json)).toBeUndefined();
        expect(contentOf(json)?.[0]?.text).toContain('worker w-1');
        expect(callToolMock).toHaveBeenCalledTimes(1);
        expect(callToolMock.mock.calls[0][1]).toBe(READ_DEF.name);
    });

    it('a key with mcp:read alone is refused, with one denial row, and nothing is sent', async () => {
        const before = (await scopeDenials()).length;
        const json = await callTool(await mintKey(['mcp:read']));
        expect(contentOf(json)).toBeUndefined();
        expect(errorOf(json)).toBeDefined();
        expect(callToolMock).not.toHaveBeenCalled();
        const denials = await scopeDenials();
        expect(denials).toHaveLength(before + 1);
        expect(denials[denials.length - 1]).toMatchObject({ tool: TOOL });
    });

    it('a * key reaches it, as before', async () => {
        const json = await callTool(await mintKey(['*']));
        expect(errorOf(json)).toBeUndefined();
        expect(callToolMock).toHaveBeenCalledTimes(1);
    });
});
