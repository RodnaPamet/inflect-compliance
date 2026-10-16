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
let keyEveryDomainA = ''; // tenant A: mcp:read + every domain read scope

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
        // Every domain, so `tools/list` can advertise the whole suite. As of
        // Epic Agentic 2 the catalogue is filtered to what THIS caller could
        // actually call — an agent plans against tools/list, and advertising
        // tools that will 403 turns ordinary planning into a stream of
        // AUTHZ_DENIED rows and buries the signal they exist for.
        keyEveryDomainA = await mintKey(TENANT_A, userA, [
            'mcp:read', 'risks:read', 'controls:read', 'frameworks:read',
            'evidence:read', 'audits:read', 'tasks:read',
        ]);

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
        const { json } = await rpc(keyEveryDomainA, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const names = (json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
        for (const n of ['list_risks', 'list_controls', 'find_coverage_gaps', 'list_evidence_expiring', 'get_framework_status', 'list_findings', 'list_tasks', 'get_tenant_context', 'search_controls']) {
            expect(names).toContain(n);
        }
    });

    it('tools/list advertises only what THIS caller could call', async () => {
        // The paired negative for the assertion above: a risks-only key sees
        // the risks tool and nothing from the domains it is not scoped for. A
        // filter nobody proves narrows is indistinguishable from no filter.
        const { json } = await rpc(keyRisksA, { jsonrpc: '2.0', id: 11, method: 'tools/list' });
        const names = (json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
        expect(names).toContain('list_risks');
        for (const n of ['list_controls', 'list_tasks', 'get_framework_status', 'list_evidence_expiring']) {
            expect(names).not.toContain(n);
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

    /**
     * THE WORK TOOLS ARE REACHABLE THROUGH THE PROTOCOL (#3617).
     *
     * Callability only, and deliberately nothing more. This suite seeds no
     * findings and no tasks, so every assertion about a page SIZE here is
     * vacuous: measured, `take: 999` in place of the bound reddens nothing at
     * all, because both tools return an empty array whatever the limit says.
     *
     * The page-size default has teeth in
     * `tests/unit/mcp-work-tools-bound.test.ts`, which asserts the exact value
     * handed to the usecase. Coverage of this file went from 0 of 8 branches to
     * 8 of 8 on the strength of two assertions that could not fail; that is why
     * the bound is asserted where the value is visible instead.
     */
    it('list_findings and list_tasks answer through tools/call', async () => {
        for (const name of ['list_findings', 'list_tasks'] as const) {
            const { json } = await rpc(keyEveryDomainA, {
                jsonrpc: '2.0', id: 30, method: 'tools/call',
                params: { name, arguments: { limit: 1 } },
            });
            // The tool resolved and returned a list — the scope held and the
            // funnel routed. What it contains is this tenant's business.
            expect(Array.isArray(toolResult(json))).toBe(true);
        }
    });

    /**
     * READING a resource, as distinct from enumerating them (#3617).
     *
     * `resources/list` was covered; `resources/read` was not, leaving
     * `src/lib/mcp/resources.ts` at 1 of 10 branches. The read path is where the
     * URI is parsed, and a URI from a caller is untrusted input: the suite
     * enumerated what exists and never asked what happens when somebody asks
     * for something else.
     */
    it('resources/read returns the framework catalogue', async () => {
        const { json } = await rpc(keyFrameworksA, {
            jsonrpc: '2.0', id: 20, method: 'resources/read',
            params: { uri: 'inflect://frameworks' },
        });
        const r = json as { result?: { contents?: Array<{ uri: string; text: string }> } };
        expect(r.result?.contents?.[0].uri).toBe('inflect://frameworks');
        // JSON, and parseable — the contents are a text block carrying a payload.
        expect(() => JSON.parse(r.result!.contents![0].text)).not.toThrow();
    });

    it('resources/read returns per-framework coverage', async () => {
        const { json } = await rpc(keyFrameworksA, {
            jsonrpc: '2.0', id: 21, method: 'resources/read',
            params: { uri: `inflect://frameworks/${FW_KEY}/requirements` },
        });
        const r = json as { result?: { contents?: Array<{ text: string }> } };
        const body = JSON.parse(r.result!.contents![0].text) as {
            summary?: { total?: number; coveragePercent?: number };
        };
        // The shape the resource promises, not merely a 200.
        expect(body.summary).toBeDefined();
        expect(typeof body.summary?.total).toBe('number');
    });

    it('refuses a requirements uri with an EMPTY framework key', async () => {
        // `inflect://frameworks//requirements` matches both the prefix and the
        // suffix, so the shape check passes and the key is the empty string. The
        // explicit emptiness check is what stops that reaching `computeCoverage`
        // as a framework nobody named.
        const { json } = await rpc(keyFrameworksA, {
            jsonrpc: '2.0', id: 22, method: 'resources/read',
            params: { uri: 'inflect://frameworks//requirements' },
        });
        const r = json as { error?: { message: string }; result?: unknown };
        expect(r.result).toBeUndefined();
        expect(r.error?.message).toMatch(/invalid framework requirements uri/i);
    });

    it('refuses an unknown resource uri', async () => {
        const { json } = await rpc(keyFrameworksA, {
            jsonrpc: '2.0', id: 23, method: 'resources/read',
            params: { uri: 'inflect://something-else-entirely' },
        });
        const r = json as { error?: { message: string }; result?: unknown };
        expect(r.result).toBeUndefined();
        expect(r.error?.message).toMatch(/unknown mcp resource/i);
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
