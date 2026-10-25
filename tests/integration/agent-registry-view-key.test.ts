/**
 * THE AGENT INVENTORY VIEW KEY, END TO END (#3710).
 *
 * Two claims, both against a real database:
 *
 *   1. AN AGENT KEY READS ONE DISCOVERED AGENT THROUGH `get_discovered_agent`
 *      only when it carries `admin:agent_registry_view` AND its agent is granted
 *      the tool — of its own tenant, never another's. Driven through the REAL
 *      `/api/mcp` route with REAL `TenantApiKey` rows, so the whole funnel is in
 *      the path: the `mcp:read` capability, the deny-by-default grant list, the
 *      named scope, the principal's own permission, and the provenance label.
 *      Every refusal writes exactly one `AUTHZ_DENIED` row.
 *
 *   2. AN AUDITOR READS THE INVENTORY AND WRITES NOTHING. The register list and
 *      one agent's row, the scans, the matrix and one discovered agent's facts
 *      are read under the AUDITOR role, per tenant; every register write it
 *      attempts is refused and the row count does not move.
 *
 * Suite-unique ids keep it parallel-safe (`TenantApiKey.keyHash` is globally
 * unique).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    activateRegisteredAgent,
    createRegisteredAgent,
    getRegisteredAgent,
    listRegisteredAgents,
    retireRegisteredAgent,
    suspendRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { listHarnessScans } from '@/app-layer/usecases/agent-harness-scans';
import { getHarnessMatrix, getHarnessScannerKeysView } from '@/app-layer/usecases/agent-harness-matrix';
import { getDiscoveredAgentFacts } from '@/app-layer/usecases/agent-harness-facts';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { ForbiddenError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `view-${randomUUID().slice(0, 8)}`;
const TENANT_A = `va-${SUITE}`;
const TENANT_B = `vb-${SUITE}`;
const TOOL = 'get_discovered_agent';
const OWNER_REF = (t: string) => `usr_source_owner_${t}`;

const ids: Record<
    string,
    { owner: string; auditor: string; reader: string; agent: string; ungranted: string; auditorOwned: string; discovered: string; linked: string }
> = {};
const keys: Record<string, string> = {};

async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, json };
}

const callTool = (token: string, args: unknown) =>
    rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: args } });
const listTools = (token: string) => rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

function contentOf(json: unknown): Array<{ text: string }> | undefined {
    return (json as { result?: { content?: Array<{ text: string }> } })?.result?.content;
}
const errorOf = (json: unknown) => (json as { error?: { message?: string } })?.error?.message;

async function denials(tenantId: string) {
    return prisma.auditLog.count({ where: { tenantId, action: 'AUTHZ_DENIED' } });
}

/** Run one call that must be refused, and return how many AUTHZ_DENIED rows it wrote. */
async function refusedWithRows(tenantId: string, call: () => Promise<{ json: unknown }>): Promise<number> {
    const before = await denials(tenantId);
    const { json } = await call();
    expect(contentOf(json)).toBeUndefined();
    expect(errorOf(json)).toBeDefined();
    return (await denials(tenantId)) - before;
}

async function mintKey(tenantId: string, userId: string, scopes: string[], agentId: string | null): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId, name: `${scopes.join('+')}-${randomUUID().slice(0, 6)}`, keyPrefix, keyHash, scopes, createdById: userId, agentId },
    });
    return plaintext;
}

async function seedUser(suffix: string): Promise<string> {
    const userId = `u-${suffix}`;
    const email = `${suffix}@example.test`;
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email, emailHash: hashForLookup(email) } });
    return userId;
}

async function member(tenantId: string, userId: string, role: 'OWNER' | 'AUDITOR' | 'READER'): Promise<void> {
    await prisma.tenantMembership.create({ data: { tenantId, userId, role, status: 'ACTIVE' } });
}

async function seedAgent(tenantId: string, ownerUserId: string, name: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: `${name} host`, ownerUserId } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status: 'ACTIVE',
            // Scored, so the tier ceiling is never what refuses here.
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return agent.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const owner = await seedUser(`${tenantId}-owner`);
    const auditor = await seedUser(`${tenantId}-auditor`);
    const reader = await seedUser(`${tenantId}-reader`);
    await member(tenantId, owner, 'OWNER');
    await member(tenantId, auditor, 'AUDITOR');
    await member(tenantId, reader, 'READER');
    const agent = await seedAgent(tenantId, owner, `Reviewer ${tenantId}`);
    const ungranted = await seedAgent(tenantId, owner, `Ungranted ${tenantId}`);
    await prisma.registeredAgentTool.create({ data: { tenantId, agentId: agent, toolName: TOOL, grantedByUserId: owner } });
    const now = new Date();
    const discovered = await prisma.discoveredAgent.create({
        data: {
            tenantId,
            discoveredId: `entra:sp:${tenantId}`,
            discoveredVia: ['entra-sp'],
            ownerKind: 'user',
            ownerRef: OWNER_REF(tenantId),
            firstSeenAt: now,
            lastSeenAt: now,
            lastScanId: `scan-${tenantId}`,
            lastLevel: 'H1',
            lastReach: 'READ_ONLY',
        },
    });
    // A registered agent the AUDITOR owns, linked to a discovered agent below
    // its bar (H1 at READ_ONLY reach, bar H2), with an acceptance in force — the
    // exact row on which the owner would be offered RENEW, had they the key.
    const auditorOwned = await seedAgent(tenantId, auditor, `Auditor-owned ${tenantId}`);
    const linked = await prisma.discoveredAgent.create({
        data: {
            tenantId,
            discoveredId: `entra:sp:linked-${tenantId}`,
            discoveredVia: ['entra-sp'],
            registeredAgentId: auditorOwned,
            firstSeenAt: now,
            lastSeenAt: now,
            lastScanId: `scan-${tenantId}`,
            lastLevel: 'H1',
            lastReach: 'READ_ONLY',
        },
    });
    await prisma.agentHarnessAcceptance.create({
        data: {
            tenantId,
            discoveredAgentId: linked.id,
            acceptedLevel: 'H1',
            justification: 'accepted for the suite',
            acceptedByUserId: auditor,
            expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
    });
    ids[tenantId] = { owner, auditor, reader, agent, ungranted, auditorOwned, discovered: discovered.id, linked: linked.id };
}

const ctxOf = (tenantId: string, role: 'AUDITOR' | 'OWNER'): RequestContext =>
    makeRequestContext(role, {
        tenantId,
        tenantSlug: tenantId,
        userId: role === 'AUDITOR' ? ids[tenantId].auditor : ids[tenantId].owner,
    });

describeFn('admin.agent_registry_view, end to end', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await seedTenant(TENANT_A);
        await seedTenant(TENANT_B);
        const a = ids[TENANT_A];
        const VIEW_SCOPES = ['mcp:read', 'admin:agent_registry_view'];
        keys.view = await mintKey(TENANT_A, a.owner, VIEW_SCOPES, a.agent);
        keys.viewB = await mintKey(TENANT_B, ids[TENANT_B].owner, VIEW_SCOPES, ids[TENANT_B].agent);
        keys.auditorView = await mintKey(TENANT_A, a.auditor, VIEW_SCOPES, a.agent);
        keys.noScope = await mintKey(TENANT_A, a.owner, ['mcp:read'], a.agent);
        keys.adminRead = await mintKey(TENANT_A, a.owner, ['mcp:read', 'admin:read'], a.agent);
        keys.adminWildcard = await mintKey(TENANT_A, a.owner, ['mcp:read', 'admin:*'], a.agent);
        keys.star = await mintKey(TENANT_A, a.owner, ['*'], a.agent);
        keys.noGrant = await mintKey(TENANT_A, a.owner, VIEW_SCOPES, a.ungranted);
        keys.readerPrincipal = await mintKey(TENANT_A, a.reader, VIEW_SCOPES, a.agent);
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await deleteAuditRowsForTenants(prisma, t).catch(() => {});
            await prisma
                .$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                    await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t);
                })
                .catch(() => {});
            await prisma.agentHarnessAcceptance.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.discoveredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgentTool.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentHarnessScannerKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } });
        }
        await prisma.user.deleteMany({ where: { id: { contains: SUITE } } });
        await prisma.$disconnect();
    });

    describe('an agent key with the view scope, granted the tool', () => {
        it('reads ONE discovered agent of its own tenant — owner reference included — labelled untrusted', async () => {
            const { json } = await callTool(keys.view, { discoveredAgentId: ids[TENANT_A].discovered });
            const content = contentOf(json);
            expect(errorOf(json)).toBeUndefined();
            const facts = JSON.parse(content![0].text) as { discoveredAgentId: string; sourceOwner: { ref: string } | null };
            expect(facts.discoveredAgentId).toBe(ids[TENANT_A].discovered);
            expect(facts.sourceOwner?.ref).toBe(OWNER_REF(TENANT_A));
            // The provenance block rides beside the payload: data, never instruction.
            expect(JSON.parse(content![1].text)).toMatchObject({
                kind: 'content-provenance',
                tool: TOOL,
                provenance: 'THIRD_PARTY_INGESTED',
                mayCarryInstruction: false,
            });
        });

        it('is offered the tool in tools/list', async () => {
            const { json } = await listTools(keys.view);
            const names = ((json as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((t) => t.name);
            expect(names).toContain(TOOL);
        });

        it('cannot read ANOTHER tenant’s discovered agent — not found, and nothing of it returned', async () => {
            const { json } = await callTool(keys.view, { discoveredAgentId: ids[TENANT_B].discovered });
            expect(contentOf(json)).toBeUndefined();
            expect(JSON.stringify(json)).not.toContain(OWNER_REF(TENANT_B));
            expect(errorOf(json)).toMatch(/not found/i);
        });

        it('and the other tenant’s own key reads its own row, and never tenant A’s', async () => {
            const own = await callTool(keys.viewB, { discoveredAgentId: ids[TENANT_B].discovered });
            expect(JSON.parse(contentOf(own.json)![0].text).discoveredAgentId).toBe(ids[TENANT_B].discovered);
            const foreign = await callTool(keys.viewB, { discoveredAgentId: ids[TENANT_A].discovered });
            expect(contentOf(foreign.json)).toBeUndefined();
            expect(JSON.stringify(foreign.json)).not.toContain(OWNER_REF(TENANT_A));
        });

        it('an AUDITOR’s key reads it too — the principal holds the view key', async () => {
            const { json } = await callTool(keys.auditorView, { discoveredAgentId: ids[TENANT_A].discovered });
            expect(errorOf(json)).toBeUndefined();
            expect(JSON.parse(contentOf(json)![0].text).discoveredAgentId).toBe(ids[TENANT_A].discovered);
        });
    });

    describe('every other credential is refused, and each refusal writes exactly one AUTHZ_DENIED row', () => {
        const args = () => ({ discoveredAgentId: ids[TENANT_A].discovered });

        it.each([
            ['no view scope (mcp:read alone)', 'noScope'],
            ['admin:read, which is the admin console and not the inventory', 'adminRead'],
            ['admin:*, which no longer reaches the named group', 'adminWildcard'],
            ['*, which subtracts the view key', 'star'],
            ['the view scope, on an agent NOT granted the tool', 'noGrant'],
            ['the view scope, minted by a READER who does not hold the key', 'readerPrincipal'],
        ])('%s', async (_label, key) => {
            expect(await refusedWithRows(TENANT_A, () => callTool(keys[key], args()))).toBe(1);
        });

        it('none of the refused keys is offered the tool', async () => {
            for (const key of ['noScope', 'adminRead', 'adminWildcard', 'star', 'noGrant', 'readerPrincipal']) {
                const { json } = await listTools(keys[key]);
                const names = ((json as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((t) => t.name);
                expect({ key, offered: names.includes(TOOL) }).toEqual({ key, offered: false });
            }
        });
    });

    describe('an AUDITOR reads the inventory and writes nothing', () => {
        it('reads the register list and one agent’s row — its own tenant’s only', async () => {
            const list = await listRegisteredAgents(ctxOf(TENANT_A, 'AUDITOR'));
            expect(list.map((r) => r.id).sort()).toEqual(
                [ids[TENANT_A].agent, ids[TENANT_A].ungranted, ids[TENANT_A].auditorOwned].sort(),
            );
            await expect(getRegisteredAgent(ctxOf(TENANT_A, 'AUDITOR'), ids[TENANT_A].agent)).resolves.toMatchObject({
                id: ids[TENANT_A].agent,
            });
            await expect(getRegisteredAgent(ctxOf(TENANT_A, 'AUDITOR'), ids[TENANT_B].agent)).rejects.toThrow(/not found/i);
        });

        it('reads the scans, the matrix and one discovered agent’s facts — and not the scanner keys', async () => {
            const ctx = ctxOf(TENANT_A, 'AUDITOR');
            await expect(listHarnessScans(ctx)).resolves.toEqual([]);
            const matrix = await getHarnessMatrix(ctx);
            expect(matrix.shadow.rows.map((r) => r.discoveredAgentId)).toContain(ids[TENANT_A].discovered);
            expect(matrix.shadow.rows.map((r) => r.discoveredAgentId)).not.toContain(ids[TENANT_B].discovered);
            // The AUDITOR OWNS this agent, and is offered no renewal: accepting
            // takes the register key, which the view key is not.
            const row = matrix.acceptances.rows.find((r) => r.discoveredAgentId === ids[TENANT_A].linked);
            expect(row?.acceptAffordance).toBe('NONE');
            await expect(getDiscoveredAgentFacts(ctx, ids[TENANT_A].discovered)).resolves.toMatchObject({
                discoveredAgentId: ids[TENANT_A].discovered,
            });
            await expect(getDiscoveredAgentFacts(ctx, ids[TENANT_B].discovered)).rejects.toThrow(/not found/i);
            // The key register stays on the register key.
            await expect(getHarnessScannerKeysView(ctx)).rejects.toBeInstanceOf(ForbiddenError);
        });

        it('every register write is refused, and the register does not move', async () => {
            const ctx = ctxOf(TENANT_A, 'AUDITOR');
            const before = await prisma.registeredAgent.findMany({ where: { tenantId: TENANT_A }, select: { id: true, status: true, name: true } });
            const attempts: Array<[string, () => Promise<unknown>]> = [
                ['create', () => createRegisteredAgent(ctx, { name: 'x' })],
                ['update', () => updateRegisteredAgent(ctx, ids[TENANT_A].agent, { name: 'renamed' })],
                ['suspend', () => suspendRegisteredAgent(ctx, ids[TENANT_A].agent)],
                ['activate', () => activateRegisteredAgent(ctx, ids[TENANT_A].ungranted)],
                ['retire', () => retireRegisteredAgent(ctx, ids[TENANT_A].agent)],
                ['scanner key', () => addHarnessScannerKey(ctx, { agentId: ids[TENANT_A].agent, publicKey: 'ab'.repeat(32) })],
            ];
            for (const [label, attempt] of attempts) {
                await expect({ label, outcome: await attempt().then(() => 'ADMITTED', (e) => (e instanceof ForbiddenError ? 'FORBIDDEN' : String(e))) })
                    .toEqual({ label, outcome: 'FORBIDDEN' });
            }
            const after = await prisma.registeredAgent.findMany({ where: { tenantId: TENANT_A }, select: { id: true, status: true, name: true } });
            expect(after).toEqual(before);
            expect(await prisma.agentHarnessScannerKey.count({ where: { tenantId: TENANT_A } })).toBe(0);
        });

        it('the paired positive: an OWNER reads the scanner keys the AUDITOR may not, and is told who may renew', async () => {
            await expect(getHarnessScannerKeysView(ctxOf(TENANT_A, 'OWNER'))).resolves.toBeDefined();
            const matrix = await getHarnessMatrix(ctxOf(TENANT_A, 'OWNER'));
            const row = matrix.acceptances.rows.find((r) => r.discoveredAgentId === ids[TENANT_A].linked);
            // The OWNER holds the key and is not the agent's owner: the note,
            // not NONE — so NONE above is the view key's doing.
            expect(row?.acceptAffordance).toBe('OWNER_ONLY');
        });
    });
});
