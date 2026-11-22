/**
 * `get_agent_recertification_evidence` through the MCP funnel (#3674, #5376).
 *
 * The usecase behind this tool is proved in
 * `access-review-agent-campaign.test.ts`, called DIRECTLY with a hand-built
 * context. That leaves the half that only exists on the wire unproved: the
 * credential's resource scope, the agent identity the funnel derives from the
 * key, and argument validation, all of which `runReadTool` performs before the
 * usecase runs. So this drives the REAL `/api/mcp` route with REAL
 * agent-bound `TenantApiKey` credentials:
 *
 *   - SCOPE. The tool's `resourceScope` is `access_reviews:read`. A key with
 *     `mcp:read` but not that scope is refused in-band (`scope_denied`), writes
 *     exactly one `AUTHZ_DENIED` row naming the tool, and is never offered the
 *     tool in `tools/list`.
 *   - THE AUDITOR IS NOT THE AUDITEE (roadmap rule 8). An agent naming its OWN
 *     id as `onlyAgentId` is refused `SELF_PACK_REFUSED` — with the agent id
 *     taken from the key's binding, never from anything the caller sent. The
 *     same call naming another agent passes that check (and reaches the
 *     campaign lookup), so the refusal is about self and nothing else.
 *   - ARGUMENTS. The schema is `.strict()`: an unknown member, a wrong type, an
 *     out-of-range page and a missing `accessReviewId` are each a JSON-RPC
 *     `InvalidParams` (-32602, the funnel's 400) and the usecase never runs.
 *   - A positive control: a correctly scoped key reads a real AGENT campaign.
 *
 * Suite-unique ids keep it parallel-safe.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';
import { RpcErrorCode } from '@/lib/mcp/protocol';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL as TOOL } from '@/lib/agentic/agent-recertification';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `recev-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-${SUITE}-owner`;

let agentSelf = '';
let agentOther = '';
let keyScoped = ''; // bound to agentSelf: mcp:read + access_reviews:read
let keyUnscoped = ''; // bound to agentSelf: mcp:read only
let reviewId = '';

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
        /* empty */
    }
    return { status: res.status, json };
}

const callTool = (token: string, args: unknown) =>
    rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: args } });

type RpcReply = { result?: { content?: Array<{ text: string }> }; error?: { code: number; message: string } };
const reply = (json: unknown) => json as RpcReply;
const resultOf = (json: unknown) => {
    const text = reply(json).result?.content?.[0]?.text;
    return text === undefined ? undefined : JSON.parse(text);
};

async function mintKey(scopes: string[], agentId: string): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId: TENANT, name: `${scopes.join('+')}-${randomUUID().slice(0, 6)}`, keyPrefix, keyHash, scopes, createdById: OWNER, agentId },
    });
    return plaintext;
}

async function seedAgent(name: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `${name} host`, ownerUserId: OWNER } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: OWNER,
            status: 'ACTIVE',
            // Scored, so the risk-tier ceiling is never what refuses here.
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    await prisma.registeredAgentTool.create({
        data: { tenantId: TENANT, agentId: agent.id, toolName: TOOL, grantedByUserId: OWNER },
    });
    return agent.id;
}

const scopeDenials = () =>
    prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED', entity: 'McpTool' },
        select: { detailsJson: true },
        take: 50,
    });

describeFn('get_agent_recertification_evidence through /api/mcp', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${SUITE}-owner@example.test`;
        await prisma.user.create({ data: { id: OWNER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId: TENANT, userId: OWNER, role: 'OWNER', status: 'ACTIVE' } });

        agentSelf = await seedAgent('Recert preparer');
        agentOther = await seedAgent('Recert subject');
        keyScoped = await mintKey(['mcp:read', 'access_reviews:read'], agentSelf);
        keyUnscoped = await mintKey(['mcp:read'], agentSelf);

        // The key's principal is the campaign's reviewer, so the usecase's
        // narrowing (reviewer or admin.agent_registry) admits the positive control.
        const review = await prisma.accessReview.create({
            data: {
                tenantId: TENANT,
                name: `${SUITE} agent campaign`,
                scope: 'AGENT',
                reviewerUserId: OWNER,
                createdByUserId: OWNER,
                preparerAgentId: agentSelf,
            },
        });
        reviewId = review.id;
    });

    afterAll(async () => {
        // Audit rows first: `AuditLog` holds a foreign key to the tenant.
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.accessReview.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.user.deleteMany({ where: { id: OWNER } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('a correctly scoped key reads the campaign (the positive control)', async () => {
        const { status, json } = await callTool(keyScoped, { accessReviewId: reviewId });
        expect(status).toBe(200);
        expect(reply(json).error).toBeUndefined();
        expect(resultOf(json)).toMatchObject({ accessReviewId: reviewId, page: 0, total: 0, subjects: [] });
    });

    describe('the resource scope: access_reviews:read', () => {
        it('a key without it is refused in-band, with one AUTHZ_DENIED row naming the tool', async () => {
            const before = (await scopeDenials()).length;
            const { status, json } = await callTool(keyUnscoped, { accessReviewId: reviewId });
            expect(status).toBe(200);
            expect(resultOf(json)).toBeUndefined();
            expect(reply(json).error?.message).toMatch(/scope/i);

            const denials = await scopeDenials();
            expect(denials.length - before).toBe(1);
            expect(denials.map((d) => d.detailsJson)).toContainEqual(
                expect.objectContaining({ tool: TOOL, reason: 'scope_denied', agentId: agentSelf }),
            );
        });

        it('the scope is checked before the arguments: an unscoped key with bad arguments is still a scope refusal', async () => {
            const { json } = await callTool(keyUnscoped, { accessReviewId: reviewId, unexpected: true });
            expect(reply(json).error?.message).toMatch(/scope/i);
            expect(reply(json).error?.code).not.toBe(RpcErrorCode.InvalidParams);
        });

        it('tools/list never offers the tool to a key without it, and does to a key with it', async () => {
            const names = async (token: string) =>
                ((await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json as {
                    result: { tools: Array<{ name: string }> };
                }).result.tools.map((t) => t.name);
            expect(await names(keyUnscoped)).not.toContain(TOOL);
            expect(await names(keyScoped)).toContain(TOOL);
        });
    });

    describe('the auditor is not the auditee', () => {
        it('an agent naming its own id is refused SELF_PACK_REFUSED, from the key\'s binding', async () => {
            const { status, json } = await callTool(keyScoped, { accessReviewId: reviewId, onlyAgentId: agentSelf });
            expect(status).toBe(200);
            expect(resultOf(json)).toBeUndefined();
            expect(reply(json).error?.message).toMatch(/^SELF_PACK_REFUSED:/);
        });

        it('the same call naming ANOTHER agent passes that check', async () => {
            const { json } = await callTool(keyScoped, { accessReviewId: reviewId, onlyAgentId: agentOther });
            expect(reply(json).error).toBeUndefined();
            expect(resultOf(json)).toMatchObject({ accessReviewId: reviewId, total: 0 });
        });

        it('the self check precedes the campaign lookup: it holds for a campaign that does not exist', async () => {
            const { json } = await callTool(keyScoped, { accessReviewId: 'no-such-review', onlyAgentId: agentSelf });
            expect(reply(json).error?.message).toMatch(/^SELF_PACK_REFUSED:/);
            const other = await callTool(keyScoped, { accessReviewId: 'no-such-review', onlyAgentId: agentOther });
            expect(reply(other.json).error?.message).toMatch(/not found/i);
        });
    });

    describe('arguments are validated before the usecase runs', () => {
        it.each([
            // An `agentId` member cannot stand in for the key's binding: it is refused outright.
            ['an unknown member', { accessReviewId: 'r', agentId: 'smuggled' }],
            ['a missing accessReviewId', {}],
            ['an accessReviewId that is not a string', { accessReviewId: 42 }],
            ['a negative page', { accessReviewId: 'r', page: -1 }],
            ['a fractional page', { accessReviewId: 'r', page: 1.5 }],
            ['a page past the bound', { accessReviewId: 'r', page: 1001 }],
            ['an empty onlyAgentId', { accessReviewId: 'r', onlyAgentId: '' }],
            ['an over-long accessReviewId', { accessReviewId: 'x'.repeat(65) }],
        ])('%s is InvalidParams', async (_label, args) => {
            const { status, json } = await callTool(keyScoped, args);
            expect(status).toBe(200);
            expect(resultOf(json)).toBeUndefined();
            expect(reply(json).error?.code).toBe(RpcErrorCode.InvalidParams);
            expect(reply(json).error?.message).toMatch(new RegExp(`^Invalid arguments for tool "${TOOL}"`));
        });
    });
});
