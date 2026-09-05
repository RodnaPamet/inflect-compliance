/**
 * Integration coverage: the MCP server end-to-end, through the REAL route +
 * REAL TenantApiKey auth + REAL RLS — no mocks. Proves the load-bearing
 * security properties:
 *   - a scoped TenantApiKey authenticates an MCP JSON-RPC call;
 *   - a tool returns data scoped to the key's tenant (RLS);
 *   - a SECOND tenant's key sees ONLY its own data (cross-tenant isolation);
 *   - a key without `mcp:read` is refused at the transport (HTTP 403);
 *   - a key with `mcp:read` but not the tool's resource scope is refused
 *     in-band (JSON-RPC error);
 *   - every successful call writes an `MCP_TOOL_INVOKED` audit row (API_KEY).
 *
 * DB-backed (integration tests never mock Prisma). Suite-unique ids keep it
 * parallel-safe (TenantApiKey.keyHash is globally unique).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST, GET } from '@/app/api/mcp/route';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `mcp-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ta-${SUITE}`;
const TENANT_B = `tb-${SUITE}`;

// Minted below in beforeAll.
// `risks:read` alongside `controls:read` because the posture payload spans
// domains and Epic Agentic 2 redacts the sections the CREDENTIAL is not scoped
// for as well as the ones the principal cannot see. This suite's subject is RLS
// isolation on the risk counts, so the key has to be scoped to read them; the
// redaction itself is proved in mcp-tool-authz-per-invocation.test.ts.
let keyFull = ''; // tenant A: [mcp:read, controls:read, risks:read]
let keyB = ''; // tenant B: [mcp:read, controls:read, risks:read]
let keyNoMcp = ''; // tenant A: [controls:read] only (no mcp gate)
let keyNoResource = ''; // tenant A: [mcp:read] only (no controls:read)

async function mintKey(tenantId: string, userId: string, scopes: string[]): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId, name: `${scopes.join('+')}`, keyPrefix, keyHash, scopes, createdById: userId },
    });
    return plaintext;
}

function mcpRequest(token: string, body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
}

/** POST a JSON-RPC message and return { status, json }. */
async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    // The route ignores the second (route-context) arg; pass an empty params ctx.
    const res = await POST(mcpRequest(token, body), { params: Promise.resolve({}) } as never);
    const status = res.status;
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* 202 no-body etc. */
    }
    return { status, json };
}

async function seedTenant(tenantId: string, slug: string, riskCount: number): Promise<string> {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: slug, slug } });
    const userId = `u-${slug}`;
    const email = `${slug}@example.test`;
    await prisma.user.upsert({
        where: { id: userId }, update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
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
    for (let i = 0; i < riskCount; i++) {
        await prisma.risk.create({
            data: {
                tenantId, title: `${slug}-risk-${i}`, description: 'x', category: 'Cybersecurity',
                impact: 3, likelihood: 3, score: 9, inherentScore: 9, status: 'OPEN', createdByUserId: userId,
            },
        });
    }
    return userId;
}

describeFn('MCP server (real route, real key, real RLS)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        // Tenant A: 2 risks. Tenant B: 0 risks. riskCount is strictly
        // tenant-scoped (no global bleed) → a clean cross-tenant assertion.
        const userA = await seedTenant(TENANT_A, TENANT_A, 2);
        const userB = await seedTenant(TENANT_B, TENANT_B, 0);
        keyFull = await mintKey(TENANT_A, userA, ['mcp:read', 'controls:read', 'risks:read']);
        keyB = await mintKey(TENANT_B, userB, ['mcp:read', 'controls:read', 'risks:read']);
        keyNoMcp = await mintKey(TENANT_A, userA, ['controls:read']);
        keyNoResource = await mintKey(TENANT_A, userA, ['mcp:read']);
    });

    afterAll(async () => {
        // Best-effort teardown. AuditLog is immutable (append-only,
        // hash-chained) and cannot be deleted, so the suite-unique tenant +
        // its audit rows remain as harmless leftovers. Every delete is
        // catch-swallowed so an FK/immutability block never fails the suite.
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.risk.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: `u-${t}` } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('initialize returns the IC MCP server info', async () => {
        const { status, json } = await rpc(keyFull, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        expect(status).toBe(200);
        const r = json as { result: { serverInfo: { name: string }; capabilities: unknown } };
        expect(r.result.serverInfo.name).toBe('inflect-compliance-mcp');
        expect(r.result.capabilities).toHaveProperty('tools');
    });

    it('tools/list advertises get_compliance_posture', async () => {
        const { json } = await rpc(keyFull, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const tools = (json as { result: { tools: Array<{ name: string }> } }).result.tools;
        expect(tools.map((t) => t.name)).toContain('get_compliance_posture');
    });

    it('a scoped key gets its OWN tenant posture (tenant A: 2 risks)', async () => {
        const { status, json } = await rpc(keyFull, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'get_compliance_posture', arguments: {} },
        });
        expect(status).toBe(200);
        const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0].text;
        const posture = JSON.parse(text) as { stats: { risks: number } };
        expect(posture.stats.risks).toBe(2);
    });

    it('a SECOND tenant key sees ONLY its own data (tenant B: 0 risks) — RLS isolation', async () => {
        const { json } = await rpc(keyB, {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'get_compliance_posture', arguments: {} },
        });
        const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0].text;
        const posture = JSON.parse(text) as { stats: { risks: number } };
        // B must NOT see A's 2 risks.
        expect(posture.stats.risks).toBe(0);
    });

    it('a key WITHOUT mcp:read is refused at the transport (HTTP 403)', async () => {
        const { status } = await rpc(keyNoMcp, {
            jsonrpc: '2.0', id: 5, method: 'tools/call',
            params: { name: 'get_compliance_posture', arguments: {} },
        });
        expect(status).toBe(403);
    });

    it('a key WITHOUT the tool resource scope is refused in-band (JSON-RPC error)', async () => {
        const { status, json } = await rpc(keyNoResource, {
            jsonrpc: '2.0', id: 6, method: 'tools/call',
            params: { name: 'get_compliance_posture', arguments: {} },
        });
        expect(status).toBe(200); // transport OK (has mcp:read)
        const r = json as { error?: { message: string }; result?: unknown };
        expect(r.error).toBeDefined();
        expect(r.result).toBeUndefined();
        expect(r.error!.message).toMatch(/scope/i);
    });

    it('every successful tool call writes an MCP_TOOL_INVOKED audit row (API_KEY)', async () => {
        // Fire a call, then assert the audit row exists for tenant A.
        await rpc(keyFull, {
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: 'get_compliance_posture', arguments: {} },
        });
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: TENANT_A, action: 'MCP_TOOL_INVOKED' },
        });
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0].actorType).toBe('API_KEY');
        expect(rows[0].entityId).toBe('get_compliance_posture');
    });

    it('GET is not allowed (no server-initiated stream)', async () => {
        const res = GET();
        expect(res.status).toBe(405);
    });
});
