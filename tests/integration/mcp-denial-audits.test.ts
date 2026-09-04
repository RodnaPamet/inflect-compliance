/**
 * Every agent denial leaves exactly one hash-chained row, and the 403 says
 * nothing the caller did not already know.
 *
 * ## Why the ROW is the assertion and the status code is not
 *
 * An agent denial is the primary rogue-agent signal — the thing a reviewer
 * filters for when asking whether an autonomous credential has been probing for
 * reach it does not have. Before this change most of these paths produced a 403
 * and NO audit row at all: `enforceApiKeyScope` throws without auditing,
 * `enforceMcpCapability` throws without auditing, and a bare `assertCanRead`
 * inside a usecase throws without auditing. The refusal reached the caller and
 * nobody else. Undoing exactly that shape, one layer up, was the whole of Epic
 * D.3, which is why this suite asserts the row rather than the status.
 *
 * ## Exactly ONE, and why the count matters in both directions
 *
 * Zero rows means the denial is invisible. TWO rows means the same refusal is
 * counted twice, and a signal that inflates is a signal an operator learns to
 * discount — the alert threshold gets raised, and the next real one is under it.
 * So every case here brackets the call with a count.
 *
 * ## The chain
 *
 * A denial row that is not chained is a denial row somebody can delete. The
 * chain is verified after the whole run, once, over every row this suite caused.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { verifyAuditChain } from '@/lib/audit/audit-writer';
import { POST } from '@/app/api/mcp/route';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `deny-${randomUUID().slice(0, 8)}`;
const TENANT = `td-${SUITE}`;

/**
 * Every permission key the MCP tool surface can demand. NONE of these may
 * appear in a response body: the key namespace is enumerable from a 403 that
 * echoes it, which is why `requirePermission` has always thrown the generic
 * string and why the same rule has to hold here.
 */
const PERMISSION_KEYS = [
    'risks.view', 'risks.create',
    'controls.view', 'controls.create',
    'policies.create',
    'tasks.view',
    'evidence.view',
    'frameworks.view',
    'audits.view',
];

let ownerId = '';
let readerId = '';
let deactivatedId = '';
let agentId = '';

/** OWNER principal, wide scopes, but the agent is granted no tools. */
let keyUngranted = '';
/** OWNER principal, `mcp:read` only — no domain scope. */
let keyNoScope = '';
/** OWNER principal, `mcp:read` (not propose) but granted a propose tool. */
let keyNoCapability = '';
/** READER principal — holds `audits.view`, does NOT hold canWrite. */
let keyReaderPropose = '';
/** OWNER principal narrowed by a custom role that denies `risks.view`. */
let keyRiskBlind = '';
/** Minted by a member who is later DEACTIVATED. */
let keyDeadPrincipal = '';

async function rpc(token: string, body: unknown): Promise<{ status: number; raw: string }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let raw = '';
    try {
        raw = await res.text();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, raw };
}

function callTool(token: string, name: string, args: unknown = {}) {
    return rpc(token, {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    });
}

async function denialRows() {
    return prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
        orderBy: { createdAt: 'asc' },
    });
}

/**
 * Run one refusal and return the single row it wrote. Fails loudly on zero rows
 * (invisible denial) and on more than one (an inflated signal).
 */
async function denialFor(
    call: () => Promise<{ status: number; raw: string }>,
): Promise<{ row: Awaited<ReturnType<typeof denialRows>>[number]; raw: string; status: number }> {
    const before = (await denialRows()).length;
    const res = await call();
    const rows = await denialRows();
    expect(rows.length - before).toBe(1);
    return { row: rows[rows.length - 1], raw: res.raw, status: res.status };
}

function reasonOf(row: { detailsJson: unknown }): string | undefined {
    return (row.detailsJson as { reason?: string } | null)?.reason;
}

async function mintKey(userId: string, scopes: string[], boundAgent: string | null) {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: `k-${randomUUID().slice(0, 6)}`,
            keyPrefix,
            keyHash,
            scopes,
            createdById: userId,
            agentId: boundAgent,
        },
    });
    return plaintext;
}

async function seedUser(suffix: string): Promise<string> {
    const userId = `u-${SUITE}-${suffix}`;
    const email = `${userId}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    return userId;
}

describeFn('every agent denial writes exactly one hash-chained AUTHZ_DENIED row', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });

        ownerId = await seedUser('owner');
        readerId = await seedUser('reader');
        deactivatedId = await seedUser('gone');
        for (const [userId, role] of [
            [ownerId, 'OWNER'],
            [readerId, 'READER'],
            [deactivatedId, 'EDITOR'],
        ] as const) {
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: TENANT, userId } },
                update: { role, status: 'ACTIVE' },
                create: { tenantId: TENANT, userId, role, status: 'ACTIVE' },
            });
        }

        const blindRole = await prisma.tenantCustomRole.create({
            data: {
                tenantId: TENANT,
                name: `blind-${SUITE}`,
                baseRole: 'OWNER',
                permissionsJson: { risks: { view: false, create: false, edit: false } },
            },
        });
        const blindId = await seedUser('blind');
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: blindId } },
            update: { role: 'OWNER', status: 'ACTIVE', customRoleId: blindRole.id },
            create: {
                tenantId: TENANT, userId: blindId, role: 'OWNER',
                status: 'ACTIVE', customRoleId: blindRole.id,
            },
        });

        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: 'denial host', ownerUserId: ownerId },
        });
        agentId = (
            await prisma.registeredAgent.create({
                data: {
                    tenantId: TENANT,
                    aiSystemId: aiSystem.id,
                    name: 'denial subject',
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: ownerId,
                    status: 'ACTIVE',
                },
            })
        ).id;
        for (const toolName of ['list_risks', 'propose_finding', 'get_compliance_posture']) {
            await prisma.registeredAgentTool.create({
                data: { tenantId: TENANT, agentId, toolName, grantedByUserId: ownerId },
            });
        }

        const wide = ['mcp:read', 'mcp:propose', 'risks:read', 'controls:read', 'audits:read'];
        keyUngranted = await mintKey(ownerId, wide, agentId);
        keyNoScope = await mintKey(ownerId, ['mcp:read'], agentId);
        keyNoCapability = await mintKey(ownerId, ['mcp:read', 'audits:read'], agentId);
        keyReaderPropose = await mintKey(readerId, ['mcp:propose', 'audits:read'], agentId);
        keyRiskBlind = await mintKey(blindId, wide, agentId);
        keyDeadPrincipal = await mintKey(deactivatedId, wide, agentId);

        // Deactivated AFTER the key was minted — the exact production shape:
        // a live integration whose human is offboarded and whose credential
        // nobody thought to revoke.
        await prisma.tenantMembership.update({
            where: { tenantId_userId: { tenantId: TENANT, userId: deactivatedId } },
            data: { status: 'DEACTIVATED' },
        });
    });

    afterAll(async () => {
        await prisma
            .$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT,
                );
            })
            .catch(() => {});
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.tenantCustomRole.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('a tool the agent is not granted', async () => {
        const { row } = await denialFor(() => callTool(keyUngranted, 'list_tasks'));
        expect(row.action).toBe('AUTHZ_DENIED');
        expect(row.actorType).toBe('API_KEY');
        expect(row.entity).toBe('McpTool');
        expect(row.entityId).toBe('list_tasks');
        expect(reasonOf(row)).toBe('tool_not_granted');
    });

    it('a credential missing the tool resource scope', async () => {
        const { row } = await denialFor(() => callTool(keyNoScope, 'list_risks'));
        expect(row.entity).toBe('McpTool');
        expect(reasonOf(row)).toBe('scope_denied');
    });

    it('a credential missing the mcp:propose capability', async () => {
        const { row } = await denialFor(() =>
            callTool(keyNoCapability, 'propose_finding', { items: [{ title: 'x' }] }),
        );
        expect(reasonOf(row)).toBe('capability_denied');
    });

    it('a principal whose permission key is denied', async () => {
        // Routed through `assertPermission`, so the row is the SAME shape a
        // denied human route writes — `entity: 'Permission'`, the key in
        // `entityId`. That sameness is the point: a reviewer filtering for
        // denied access should not need to know agents have their own
        // vocabulary.
        const { row } = await denialFor(() => callTool(keyRiskBlind, 'list_risks'));
        expect(row.entity).toBe('Permission');
        expect(row.entityId).toBe('risks.view');
        expect((row.detailsJson as { event?: string }).event).toBe('authz_denied');
    });

    it('a principal who holds the domain key but not the write policy', async () => {
        // A READER holds `audits.view`, so the key check passes and the
        // refusal comes from the shared `assertCanWrite` the human
        // `POST /findings` route relies on — the path that threw silently
        // before today.
        const { row } = await denialFor(() =>
            callTool(keyReaderPropose, 'propose_finding', { items: [{ title: 'x' }] }),
        );
        expect(row.entity).toBe('McpTool');
        expect(row.entityId).toBe('propose_finding');
        expect(reasonOf(row)).toBe('policy_denied');
    });

    it('a credential whose principal was deactivated after it was minted', async () => {
        const { row, status } = await denialFor(() =>
            rpc(keyDeadPrincipal, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        );
        expect(status).toBe(403);
        // The KEY is the entity, not the person: the credential is what an
        // operator has to act on, and the user is already in `userId`.
        expect(row.entity).toBe('TenantApiKey');
        expect(reasonOf(row)).toBe('principal_deactivated');
        expect((row.detailsJson as { gate?: string }).gate).toBe('agent_principal');
    });

    it('no response body echoes a permission key', async () => {
        // The 403 must not be a way to enumerate the key namespace. Checked
        // over every refusal this suite can produce, not one of them.
        const bodies: string[] = [];
        bodies.push((await callTool(keyUngranted, 'list_tasks')).raw);
        bodies.push((await callTool(keyNoScope, 'list_risks')).raw);
        bodies.push((await callTool(keyRiskBlind, 'list_risks')).raw);
        bodies.push(
            (await callTool(keyReaderPropose, 'propose_finding', { items: [{ title: 'x' }] })).raw,
        );
        bodies.push(
            (await rpc(keyDeadPrincipal, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).raw,
        );

        // Anti-vacuity: the bodies are real refusals, not empty strings.
        expect(bodies.every((b) => b.length > 20)).toBe(true);
        // Joined into one resolvable binding rather than asserted inside the
        // loop: `expect(body)` over a loop variable is a subject the Class D
        // assertion-reach analyser cannot resolve, and an un-analysable
        // assertion is a blind spot whose ceiling this repo ratchets.
        const everyRefusal = bodies.join('\n');
        for (const key of PERMISSION_KEYS) {
            expect(everyRefusal).not.toContain(key);
        }
    });

    it('a successful call writes NO denial row', async () => {
        // The paired negative for every count above. Without it, "exactly one
        // more row" is equally consistent with a writer that fires on every
        // request.
        const before = (await denialRows()).length;
        const res = await callTool(keyUngranted, 'list_risks');
        expect(res.raw).not.toContain('error');
        expect((await denialRows()).length).toBe(before);
    });

    it('the tenant audit chain still verifies over every row this suite wrote', async () => {
        const rows = await denialRows();
        // Anti-vacuity: a chain over zero rows verifies trivially.
        expect(rows.length).toBeGreaterThanOrEqual(6);
        const result = await verifyAuditChain(TENANT);
        expect(result.valid).toBe(true);
    });
});
