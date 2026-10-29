/**
 * A key the connect wizard mints reaches what its agent is granted, and nothing
 * else (Step 3a, #4155).
 *
 * The key is minted by the REAL `createApiKey`, under a real tenant context,
 * with the scopes the wizard computes (`connectKeyScopes`) for the agent's
 * grants, bound to that agent at its own level. It is then used against the
 * REAL `/api/mcp` route:
 *
 *   • the granted read tool answers (the positive control, which keeps the
 *     refusal below honest);
 *   • an ungranted tool is refused, with one hash-chained `AUTHZ_DENIED` row
 *     naming the tool;
 *   • a ceiling above the agent's own level is refused at the mint, so the
 *     wizard's "may only be lowered" is the usecase's rule too, not only the
 *     picker's.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createApiKey } from '@/app-layer/usecases/api-keys';
import { connectKeyScopes } from '@/lib/agentic/connect-wizard';
import { POST } from '@/app/api/mcp/route';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `connect-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-owner-${SUITE}`;
const GRANTED = 'list_risks';
const UNGRANTED = 'list_controls';

let agentId = '';
let key = '';

const ownerCtx = () => makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: OWNER });

async function callTool(name: string): Promise<unknown> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    return res.json();
}

const contentOf = (json: unknown) => (json as { result?: { content?: unknown[] } })?.result?.content;
const errorOf = (json: unknown) => (json as { error?: { message?: string } })?.error?.message;

async function denials(): Promise<Record<string, unknown>[]> {
    const rows = await prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
        orderBy: { createdAt: 'asc' },
        select: { detailsJson: true },
    });
    return rows.map((r) => r.detailsJson as Record<string, unknown>);
}

describeFn('a key minted by the connect wizard reaches only its agent\'s grants (#4155)', () => {
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
                name: 'Risk reviewer',
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
        await prisma.registeredAgentTool.create({ data: { tenantId: TENANT, agentId, toolName: GRANTED, grantedByUserId: OWNER } });

        const minted = await createApiKey(ownerCtx(), {
            name: 'Risk reviewer connector',
            scopes: connectKeyScopes([GRANTED]),
            expiresAt: null,
            agentId,
            maxAutonomyLevel: agent.autonomyLevel,
        });
        key = minted.plaintext;
    });

    afterAll(async () => {
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
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

    it('the key carries the grant\'s scopes and is bound to the agent at its own level', async () => {
        const row = await prisma.tenantApiKey.findFirstOrThrow({ where: { tenantId: TENANT }, select: { scopes: true, agentId: true, maxAutonomyLevel: true } });
        expect(row).toEqual({ scopes: ['mcp:read', 'risks:read'], agentId, maxAutonomyLevel: 2 });
    });

    it('reaches the granted tool (the positive control)', async () => {
        const json = await callTool(GRANTED);
        expect(errorOf(json)).toBeUndefined();
        expect(contentOf(json)).toBeDefined();
    });

    it('is refused a tool the agent is not granted, with one AUTHZ_DENIED row naming it', async () => {
        const before = (await denials()).length;
        const json = await callTool(UNGRANTED);
        expect(contentOf(json)).toBeUndefined();
        expect(errorOf(json)).toBeDefined();
        const after = await denials();
        expect(after).toHaveLength(before + 1);
        expect(after[after.length - 1]).toMatchObject({ tool: UNGRANTED, agentId });
    });

    it('a ceiling above the agent\'s own level is refused at the mint', async () => {
        await expect(
            createApiKey(ownerCtx(), {
                name: 'too high',
                scopes: connectKeyScopes([GRANTED]),
                expiresAt: null,
                agentId,
                maxAutonomyLevel: 3,
            }),
        ).rejects.toThrow(/exceeds the agent's own registered level/);
        expect(await prisma.tenantApiKey.count({ where: { tenantId: TENANT } })).toBe(1);
    });
});
