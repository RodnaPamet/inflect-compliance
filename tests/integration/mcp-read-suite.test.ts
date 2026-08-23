/**
 * Integration coverage: the MCP read-tool SUITE end-to-end (real route + real
 * TenantApiKey + real RLS). Proves, for a representative entity tool
 * (`list_risks`):
 *   - returns the key's OWN tenant data;
 *   - a SECOND tenant's key sees ONLY its own data (cross-tenant isolation);
 *   - a key with `mcp:read` but NOT the tool's resource scope is refused in-band;
 *   - the tool is bounded (`limit` respected);
 * plus tools/list advertises the full suite and resources/list exposes the
 * framework catalogue + per-framework requirement resources.
 *
 * DB-backed; suite-unique ids keep it parallel-safe.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `mcprs-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ra-${SUITE}`;
const TENANT_B = `rb-${SUITE}`;

let keyRisksA = '';
let keyRisksB = '';
let keyControlsOnly = ''; // tenant A: mcp:read + controls:read (NO risks:read)
let keyFrameworksA = ''; // tenant A: mcp:read + frameworks:read

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

function toolResult(json: unknown): unknown {
    const text = (json as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    return JSON.parse(text);
}

async function seedTenant(tenantId: string, slug: string, riskCount: number): Promise<string> {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: slug, slug } });
    const userId = `u-${slug}`;
    const email = `${slug}@example.test`;
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email, emailHash: hashForLookup(email) } });
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

// A suite-unique GLOBAL framework + pack so `listInstallableFrameworks` (which
// backs the per-framework requirement resources) returns at least one entry —
// the CI integration DB is migrated but NOT globally seeded, so we can't rely on
// seeded frameworks existing.
const FW_KEY = `mcprs-fw-${SUITE}`;
let frameworkId = '';

describeFn('MCP read suite (real route, real key, real RLS)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const userA = await seedTenant(TENANT_A, TENANT_A, 3);
        const userB = await seedTenant(TENANT_B, TENANT_B, 0);
        keyRisksA = await mintKey(TENANT_A, userA, ['mcp:read', 'risks:read']);
        keyRisksB = await mintKey(TENANT_B, userB, ['mcp:read', 'risks:read']);
        keyControlsOnly = await mintKey(TENANT_A, userA, ['mcp:read', 'controls:read']);
        // `frameworks:read` alongside `mcp:read`, which is the documented model:
        // `mcp:read` gates the MCP surface, a RESOURCE scope gates the data.
        // Enumerating the catalogue goes through `assertCanViewFrameworks`,
        // which reads `appPermissions.frameworks.view` — derived from this
        // key's scopes by `scopesToPermissions`.
        keyFrameworksA = await mintKey(TENANT_A, userA, ['mcp:read', 'frameworks:read']);

        const fw = await prisma.framework.create({
            data: { key: FW_KEY, version: '1', name: 'MCP RS Test Framework', kind: 'NIST_FRAMEWORK', description: 'x' },
        });
        frameworkId = fw.id;
        await prisma.frameworkRequirement.create({
            data: { frameworkId: fw.id, code: 'R1', title: 'req 1', section: 'S1', sortOrder: 0 },
        });
        await prisma.frameworkPack.create({
            data: { key: `${FW_KEY}_PACK`, name: 'MCP RS Pack', frameworkId: fw.id, version: '1' },
        });
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.risk.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: `u-${t}` } }).catch(() => {});
        }
        if (frameworkId) {
            await prisma.frameworkPack.deleteMany({ where: { frameworkId } }).catch(() => {});
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } }).catch(() => {});
            await prisma.framework.delete({ where: { id: frameworkId } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('tools/list advertises the full tenant-inspection suite', async () => {
        const { json } = await rpc(keyRisksA, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const names = (json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
        for (const n of ['list_risks', 'list_controls', 'find_coverage_gaps', 'list_evidence_expiring', 'get_framework_status', 'list_findings', 'list_tasks', 'get_tenant_context', 'search_controls']) {
            expect(names).toContain(n);
        }
    });

    it('list_risks returns the key\'s OWN tenant risks (A: 3)', async () => {
        const { json } = await rpc(keyRisksA, {
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'list_risks', arguments: {} },
        });
        const risks = toolResult(json) as Array<{ title: string }>;
        expect(risks.length).toBe(3);
        expect(risks.every((r) => r.title.startsWith(TENANT_A))).toBe(true);
    });

    it('a SECOND tenant key sees ONLY its own risks (B: 0) — RLS isolation', async () => {
        const { json } = await rpc(keyRisksB, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'list_risks', arguments: {} },
        });
        const risks = toolResult(json) as Array<{ title: string }>;
        expect(risks.length).toBe(0);
    });

    it('a key without risks:read is refused in-band (scope)', async () => {
        const { status, json } = await rpc(keyControlsOnly, {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'list_risks', arguments: {} },
        });
        expect(status).toBe(200);
        const r = json as { error?: { message: string }; result?: unknown };
        expect(r.result).toBeUndefined();
        expect(r.error?.message).toMatch(/scope/i);
    });

    it('list_risks respects the limit bound', async () => {
        const { json } = await rpc(keyRisksA, {
            jsonrpc: '2.0', id: 5, method: 'tools/call',
            params: { name: 'list_risks', arguments: { limit: 1 } },
        });
        const risks = toolResult(json) as unknown[];
        expect(risks.length).toBe(1);
    });

    it('resources/list exposes the framework catalogue + per-framework requirements', async () => {
        const { json } = await rpc(keyFrameworksA, { jsonrpc: '2.0', id: 6, method: 'resources/list' });
        const uris = (json as { result: { resources: Array<{ uri: string }> } }).result.resources.map((r) => r.uri);
        expect(uris).toContain('inflect://frameworks');
        // The seeded installable framework produces a per-framework requirement resource.
        expect(uris).toContain(`inflect://frameworks/${FW_KEY}/requirements`);
    });

    it('resources/list refuses a key without frameworks:read', async () => {
        // The behaviour change from `assertCanViewFrameworks` reading the
        // permission instead of the role. `keyRisksA` holds `mcp:read` +
        // `risks:read`; `scopesToPermissions` maps `mcp:read` to an EMPTY
        // action list, so `frameworks.view` is false and enumeration is
        // refused where it previously succeeded.
        //
        // Paired with the test above deliberately: on its own a refusal proves
        // nothing, because a broken enumeration refuses every key. The two
        // together show the scope is what decides.
        const { json } = await rpc(keyRisksA, { jsonrpc: '2.0', id: 7, method: 'resources/list' });
        expect(JSON.stringify(json)).toMatch(/permission to view frameworks/i);
    });
});
