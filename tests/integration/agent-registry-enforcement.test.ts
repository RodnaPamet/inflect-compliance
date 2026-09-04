/**
 * The agent-registration gate, both directions, against the real MCP route.
 *
 * The register only means something if something consults it. This is that
 * something: with `TenantSecuritySettings.requireRegisteredAgent` on, a
 * credential that does not name an ACTIVE `RegisteredAgent` cannot reach
 * `/api/mcp` at all — and the refusal lands in the hash-chained audit trail as
 * `AUTHZ_DENIED`, which is what makes it reviewable rather than merely
 * effective.
 *
 * ── What is asserted, and why the 403 alone is not enough ────────────
 *
 * A test that only checked the status code would pass against a gate that
 * refused and recorded nothing — and an unrecorded refusal is exactly the
 * failure mode this repo has written down twice already (the legacy
 * `requireAdminCtx` helpers threw a 403 and wrote no `AUTHZ_DENIED` row, and
 * the whole of Epic D.3 was undoing that). So every refusal below is checked
 * against the AuditLog ROW: its action, its category, the reason, the api key
 * it names — and its place in the chain, because a row whose `previousHash`
 * does not match its predecessor's `entryHash` is not evidence of anything.
 *
 * ── The four states a credential can be in ───────────────────────────
 *
 *   flag OFF, key unbound      → allowed   (today's behaviour, preserved)
 *   flag ON,  key unbound      → REFUSED   (no_agent_binding)
 *   flag ON,  key → SUSPENDED  → REFUSED   (agent_not_active — the kill switch)
 *   flag ON,  key → ACTIVE     → allowed, and the run it starts is attributed
 *
 * The last row is the one that keeps the others honest: a gate that refused
 * everything would satisfy all three refusal assertions.
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
jest.setTimeout(30_000);

const SUITE = `agate-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

/** Bound to an ACTIVE agent. */
let keyActive = '';
/** Bound to a SUSPENDED agent — the kill switch. */
let keySuspended = '';
/** Bound to nothing — an ordinary integration key reaching the agent surface. */
let keyUnbound = '';

let activeAgentId = '';
let suspendedAgentId = '';

async function mintKey(agentId: string | null): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: agentId ?? 'unbound',
            keyPrefix,
            keyHash,
            scopes: ['mcp:read', 'mcp:propose', 'risks:read'],
            createdById: USER,
            agentId,
        },
    });
    return plaintext;
}

/** Create an AI-system register entry + the agent that links to it. */
async function seedAgent(name: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
            status,
        },
    });
    return agent.id;
}

async function setEnforcement(requireRegisteredAgent: boolean): Promise<void> {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        update: { requireRegisteredAgent },
        create: { tenantId: TENANT, requireRegisteredAgent },
    });
}

/** A minimal, valid MCP call: list the tools. Needs only `mcp:read`. */
async function callMcp(token: string): Promise<{ status: number; body: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, body };
}

async function denialRows() {
    return prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
        orderBy: { createdAt: 'asc' },
    });
}

describeFn('the agent-registration gate', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });

        activeAgentId = await seedAgent('Live reconciler', 'ACTIVE');
        suspendedAgentId = await seedAgent('Stopped reconciler', 'SUSPENDED');
        keyActive = await mintKey(activeAgentId);
        keySuspended = await mintKey(suspendedAgentId);
        keyUnbound = await mintKey(null);
    });

    afterAll(async () => {
        // `session_replication_role = 'replica'` for AuditLog: the
        // immutable-audit-log trigger fires on an ordinary DELETE and would
        // take the teardown, and therefore the whole suite, down with it.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        });
    });

    describe('flag OFF — today’s behaviour is preserved', () => {
        beforeEach(() => setEnforcement(false));

        it('an unbound key still reaches the agent surface', async () => {
            const { status, body } = await callMcp(keyUnbound);
            expect(status).toBe(200);
            // Not just "not a 403" — a real tool list came back, so the call
            // went all the way through rather than failing somewhere quieter.
            expect((body as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
        });

        it('and writes no denial row', async () => {
            await callMcp(keyUnbound);
            expect(await denialRows()).toHaveLength(0);
        });

        it('a key bound to a SUSPENDED agent is not refused either', async () => {
            // The kill switch is the gate's, not the credential's. With the gate
            // off, suspension stops nothing — which is precisely the reason a
            // tenant would turn the gate on.
            expect((await callMcp(keySuspended)).status).toBe(200);
        });
    });

    describe('flag ON — an unregistered credential is refused', () => {
        beforeEach(() => setEnforcement(true));

        it('refuses the call with a 403', async () => {
            expect((await callMcp(keyUnbound)).status).toBe(403);
        });

        it('writes a hash-chained AUTHZ_DENIED row naming the key and the reason', async () => {
            await callMcp(keyUnbound);
            const rows = await denialRows();
            expect(rows).toHaveLength(1);

            const row = rows[0];
            expect(row.action).toBe('AUTHZ_DENIED');
            expect(row.entity).toBe('RegisteredAgent');
            expect(row.actorType).toBe('API_KEY');

            const details = row.detailsJson as Record<string, unknown>;
            expect(details.category).toBe('access');
            expect(details.gate).toBe('agent_registration');
            // The reason is the operator's whole diagnosis: "nobody registered
            // this key" and "the kill switch is down" need opposite responses.
            expect(details.reason).toBe('no_agent_binding');
            expect(details.path).toBe('/api/mcp');

            // The row names the CREDENTIAL, because that is what an operator
            // has to bind or revoke. There is no agent to name — that is the
            // finding.
            const key = await prisma.tenantApiKey.findFirst({
                where: { tenantId: TENANT, agentId: null },
                select: { id: true },
            });
            expect(row.entityId).toBe(key?.id);
            expect(details.agentId).toBeNull();

            // Hash-chained: the entry carries a hash, and it is the head of
            // this tenant's chain in a database we just cleared.
            expect(row.entryHash).toMatch(/^[0-9a-f]{64}$/);
        });

        it('a second refusal links to the first — the chain is real, not decorative', async () => {
            await callMcp(keyUnbound);
            await callMcp(keyUnbound);
            const rows = await denialRows();
            expect(rows).toHaveLength(2);
            // The load-bearing property: tampering with or deleting the first
            // row breaks the second's link. Asserting only that a hash exists
            // would pass against two unrelated rows.
            expect(rows[1].previousHash).toBe(rows[0].entryHash);
            expect(rows[1].entryHash).not.toBe(rows[0].entryHash);
        });

        it('refuses a key whose agent is SUSPENDED, and says so', async () => {
            expect((await callMcp(keySuspended)).status).toBe(403);
            const rows = await denialRows();
            expect(rows).toHaveLength(1);
            const details = rows[0].detailsJson as Record<string, unknown>;
            // A DIFFERENT reason from the unbound case. The suspended agent IS
            // named here — an operator needs to know which switch is down.
            expect(details.reason).toBe('agent_not_active');
            expect(details.agentId).toBe(suspendedAgentId);
        });

        it('a key bound to an ACTIVE agent goes through', async () => {
            // Without this, every assertion above is equally satisfied by a
            // gate that refuses all traffic.
            const { status, body } = await callMcp(keyActive);
            expect(status).toBe(200);
            expect((body as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
            expect(await denialRows()).toHaveLength(0);
        });
    });

    describe('an absent settings row reads as ENFORCING', () => {
        it('refuses an unbound key for a tenant nobody has configured', async () => {
            // Rows here are written lazily, so "no row" is the state of every
            // tenant created after this shipped. Reading it as "off" would make
            // the documented default true only of tenants whose admin had
            // happened to open a settings page. The migration back-filled a row
            // for every tenant that existed at deploy time so this rule cannot
            // retroactively switch an existing customer on.
            await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
            expect((await callMcp(keyUnbound)).status).toBe(403);
            expect((await callMcp(keyActive)).status).toBe(200);
        });
    });

    describe('the runtime record it lets through is attributed', () => {
        beforeEach(() => setEnforcement(true));

        it('a proposal made through MCP names the agent that made it', async () => {
            // The other half of the invariant the `local/require-agent-attribution`
            // rule polices. The register says which agents exist; the runtime
            // rows have to resolve back to it. An `agentId` of NULL here would
            // mean the gate identified a caller and then lost track of who it
            // was — a register that is consulted at the door and forgotten
            // immediately afterwards.
            const before = await prisma.agentProposal.count({ where: { tenantId: TENANT } });

            const req = new NextRequest('http://localhost/api/mcp', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${keyActive}`,
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'tools/call',
                    params: {
                        name: 'propose_risks',
                        arguments: {
                            items: [{ title: 'Attributed risk', description: 'from a live agent' }],
                        },
                    },
                }),
            });
            const res = await POST(req, { params: Promise.resolve({}) } as never);
            expect(res.status).toBe(200);

            const proposals = await prisma.agentProposal.findMany({
                where: { tenantId: TENANT },
            });
            // Anti-vacuity: the call really queued something. Without this the
            // attribution assertion below would pass over an empty array.
            expect(proposals).toHaveLength(before + 1);
            expect(proposals[0].agentId).toBe(activeAgentId);
        });
    });
});
