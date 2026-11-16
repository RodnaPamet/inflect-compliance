/**
 * `search_knowledge` THROUGH THE TOOL: the real `/api/mcp` route, a real key,
 * the real funnel (`runReadTool`), the real index job and the pgvector store
 * with RLS live (vector store Phase 3.3; G7: the two-tenant test at the TOOL
 * layer, not only the repository layer).
 *
 * Both tenants approve a policy about the same thing — signing-key rotation —
 * so a query for it would find the other tenant's passage if anything leaked:
 * the isolation is shown on text that would otherwise be the best match.
 *
 * Three seams, and why each is one:
 *   • the mount gate is reported OPEN for the stub embedder's revision — the
 *     gate itself is tested on its own (`tests/unit/knowledge-search-mount.test.ts`),
 *     and here it is the tool that is under test; the last case closes it;
 *   • the embedding route is the deterministic stub (no `tei-embed` here);
 *   • the store switch is on (`VECTOR_STORE_BACKEND` is unset in tests).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import type { KnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';

const DIMS = 384;

jest.mock('@/app-layer/repositories/vector-store-switch', () => ({ vectorStoreEnabled: () => true }));
jest.mock('@/lib/ai/embeddings', () => {
    const actual = jest.requireActual('@/lib/ai/embeddings');
    return {
        ...actual,
        getEmbeddingProvider: () => ({ ok: true, provider: new actual.StubEmbeddingProvider(384) }),
    };
});
let mockMount: KnowledgeSearchMount;
jest.mock('@/app-layer/services/knowledge-search-mount', () => {
    const actual = jest.requireActual('@/app-layer/services/knowledge-search-mount');
    return {
        ...actual,
        getKnowledgeSearchMount: () => mockMount,
        knowledgeSearchMounted: () => mockMount.state === 'MOUNTED',
    };
});

import { knowledgeRetrieverRevision } from '@/app-layer/services/knowledge-search-revision';
import { runKnowledgeIndexJob } from '@/app-layer/jobs/knowledge-index';
import { createPolicy, decidePolicyApproval, requestPolicyApproval } from '@/app-layer/usecases/policy';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { POST } from '@/app/api/mcp/route';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { STUB_EMBEDDING_MODEL } from '@/lib/ai/embeddings';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { prisma as appPrisma } from '@/lib/prisma';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `ksrch-${randomUUID().slice(0, 8)}`;
const A = `ta-${SUITE}`;
const B = `tb-${SUITE}`;
const TENANTS = [A, B];

const MOUNTED: KnowledgeSearchMount = {
    state: 'MOUNTED',
    revision: knowledgeRetrieverRevision({ model: STUB_EMBEDDING_MODEL, dimensions: DIMS }),
    record: { file: 'fixture.json', ranAt: '2026-11-16T00:00:00.000Z' },
    figures: { recallAt10VsExact: 1, recallScored: 1, p95LatencyMs: 10, latencySamples: 1 },
};

const POLICY_TEXT: Record<string, string> = {
    [A]: [
        'Tenant A rotates its signing keys every ninety days and records each rotation in the key register.',
        'Tenant A reviews privileged access quarterly.',
    ].join('\n\n'),
    [B]: [
        'Tenant B rotates its signing keys every thirty days, and the security lead approves each rotation.',
        'Tenant B assesses every supplier yearly.',
    ].join('\n\n'),
};

interface Fixture {
    ownerId: string;
    versionId: string;
    policyId: string;
    key: string;
}
const fx: Record<string, Fixture> = {};
const userIds: string[] = [];
let keyNoPolicyScopeA = '';

async function makeUser(tenantId: string, role: Role): Promise<string> {
    const email = `${role.toLowerCase()}-${tenantId}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: u.id, role, status: MembershipStatus.ACTIVE } });
    userIds.push(u.id);
    return u.id;
}

async function mintKey(tenantId: string, userId: string, scopes: string[]): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({ data: { tenantId, name: scopes.join('+'), keyPrefix, keyHash, scopes, createdById: userId } });
    return plaintext;
}

/** An editor writes the policy and asks; an owner approves; the index job indexes it. */
async function indexedTenant(tenantId: string): Promise<Fixture> {
    const ownerId = await makeUser(tenantId, Role.OWNER);
    const editorId = await makeUser(tenantId, Role.EDITOR);
    const ctxOwner = makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: ownerId });
    const ctxEditor = makeRequestContext('EDITOR', { tenantId, tenantSlug: tenantId, userId: editorId });
    const policy = await createPolicy(ctxEditor, { title: `Key management ${tenantId}`, content: POLICY_TEXT[tenantId] });
    const row = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id }, select: { currentVersionId: true } });
    const versionId = row.currentVersionId!;
    const approval = await requestPolicyApproval(ctxEditor, policy.id, versionId);
    await decidePolicyApproval(ctxOwner, policy.id, approval.id, { decision: 'APPROVED' });
    const r = await runKnowledgeIndexJob({ tenantId, sourceModel: 'PolicyVersion', sourceId: versionId });
    expect(r.outcome).toBe('INDEXED');
    // A bare key reaching /api/mcp needs the registration gate off (see mcp-read-suite).
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        update: { requireRegisteredAgent: false },
        create: { tenantId, requireRegisteredAgent: false },
    });
    const key = await mintKey(tenantId, ownerId, ['mcp:read', 'policies:read']);
    return { ownerId, versionId, policyId: policy.id, key };
}

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
        /* noop */
    }
    return { status: res.status, json };
}

interface Hit {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    text: string;
    citation: { kind: string; id: string; title: string };
}

async function search(token: string, query: string, k?: number): Promise<{ available: boolean; hits?: Hit[]; reason?: string }> {
    const { json } = await rpc(token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_knowledge', arguments: k === undefined ? { query } : { query, limit: k } },
    });
    const result = (json as { result?: { content: Array<{ text: string }>; isError?: boolean } }).result;
    if (!result || result.isError) throw new Error(`tool call failed: ${JSON.stringify(json)}`);
    return JSON.parse(result.content[0].text);
}

async function cleanup(): Promise<void> {
    const existing = await prisma.tenant.findMany({ where: { id: { in: TENANTS } }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    await deleteAuditRowsForTenants(prisma, TENANTS).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describeFn('search_knowledge through the tool keeps two tenants apart (real route, real funnel, RLS live)', () => {
    beforeAll(async () => {
        mockMount = MOUNTED;
        await prisma.$connect();
        await cleanup();
        for (const t of TENANTS) await createTenantWithDek({ id: t, name: t, slug: t });
        fx[A] = await indexedTenant(A);
        fx[B] = await indexedTenant(B);
        // A live member's key with the MCP capability and no policies scope.
        keyNoPolicyScopeA = await mintKey(A, fx[A].ownerId, ['mcp:read', 'risks:read']);
    });

    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    it("A's search for the shared subject returns A's passages only, cited to A's policy", async () => {
        const r = await search(fx[A].key, 'how often are signing keys rotated', 10);
        expect(r.available).toBe(true);
        expect(r.hits!.length).toBeGreaterThan(0);
        expect(new Set(r.hits!.map((h) => h.sourceId))).toEqual(new Set([fx[A].versionId]));
        expect(new Set(r.hits!.map((h) => h.citation.id))).toEqual(new Set([fx[A].policyId]));
        // The passage is decrypted text, not ciphertext.
        expect(r.hits!.some((h) => h.text.includes('ninety days'))).toBe(true);
        expect(r.hits!.some((h) => h.text.includes('thirty days'))).toBe(false);
    });

    it("B's search for the same subject returns B's passages only", async () => {
        const r = await search(fx[B].key, 'how often are signing keys rotated', 10);
        expect(new Set(r.hits!.map((h) => h.sourceId))).toEqual(new Set([fx[B].versionId]));
        expect(r.hits!.some((h) => h.text.includes('ninety days'))).toBe(false);
    });

    it('returns at most `limit` passages', async () => {
        const r = await search(fx[A].key, 'signing keys privileged access', 1);
        expect(r.hits!.length).toBe(1);
    });

    it('refuses a limit above 20 at the schema, before anything runs', async () => {
        const { json } = await rpc(fx[A].key, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'search_knowledge', arguments: { query: 'signing keys', limit: 21 } },
        });
        expect(JSON.stringify(json)).toMatch(/Invalid arguments|too_big|21/);
        expect((json as { result?: { isError?: boolean } }).result?.isError ?? true).toBe(true);
    });

    it('a key without the policies scope is not offered the tool and is refused it', async () => {
        const list = await rpc(keyNoPolicyScopeA, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const names = ((list.json as { result: { tools: Array<{ name: string }> } }).result.tools ?? []).map((t) => t.name);
        expect(names).not.toContain('search_knowledge');
        const { json } = await rpc(keyNoPolicyScopeA, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'search_knowledge', arguments: { query: 'signing keys' } },
        });
        expect(JSON.stringify(json)).not.toContain('ninety days');
    });

    it('with the mount gate closed the tool is absent from tools/list and a call to it is an unknown tool', async () => {
        mockMount = { state: 'UNMOUNTED', reason: 'NO_RECORD', detail: 'no record', revision: MOUNTED.revision };
        try {
            const list = await rpc(fx[A].key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
            const names = (list.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
            expect(names).not.toContain('search_knowledge');
            const { json } = await rpc(fx[A].key, {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'search_knowledge', arguments: { query: 'signing keys' } },
            });
            expect(JSON.stringify(json)).toContain('Unknown MCP tool: search_knowledge');
            expect(JSON.stringify(json)).not.toContain('ninety days');
        } finally {
            mockMount = MOUNTED;
        }
    });
});
