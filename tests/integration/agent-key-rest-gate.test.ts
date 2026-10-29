/**
 * An agent-bound key on the REST API stops when its agent is stopped (#4481).
 *
 * Before this, only the MCP funnel read the agent behind a key, and an `iflk_`
 * key is admitted at every `/api/t/**` route (#2224). A key bound to a killed
 * or suspended agent kept reading over REST. These cells drive a real route,
 * `GET /api/t/<slug>/risks`, with a real key, against a real database:
 *
 *   • an ACTIVE, unkilled agent's key is served (the positive control, and the
 *     one that keeps every refusal below honest);
 *   • an AGENT-scope kill, and a TENANT-scope kill, refuse it, and lifting the
 *     kill serves it again;
 *   • a SUSPENDED agent's key is refused;
 *   • a key bound to no agent is not this gate's concern: a tenant kill does
 *     not touch it.
 *
 * Every refusal is checked against its hash-chained `AUTHZ_DENIED` row, not
 * only the 403. A PLATFORM-scope kill is not engaged here: it is one row for
 * the whole deployment and would stop every other suite's agents on a shared
 * database. It is read by the same `resolveKillState` as the other two.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { hashForLookup } from '@/lib/security/encryption';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `krest-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const OWNER = `u-owner-${SUITE}`;

let agentId = '';
let agentKey = '';
let unboundKey = '';

async function mintKey(name: string, boundTo: string | null): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId: TENANT, name, keyPrefix, keyHash, scopes: ['risks:read'], createdById: OWNER, agentId: boundTo },
    });
    return plaintext;
}

/** `GET /api/t/<slug>/risks` with a bearer key. */
async function listRisks(token: string): Promise<number> {
    const { GET } = await import('@/app/api/t/[tenantSlug]/risks/route');
    const req = new NextRequest(`http://localhost/api/t/${TENANT}/risks`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
    });
    const res = await GET(req, { params: Promise.resolve({ tenantSlug: TENANT }) });
    return res.status;
}

async function gateDenials(): Promise<Record<string, unknown>[]> {
    const rows = await prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
        orderBy: { createdAt: 'asc' },
        select: { detailsJson: true },
    });
    return rows
        .map((r) => r.detailsJson as Record<string, unknown>)
        .filter((d) => d.gate === 'agent_key_rest');
}

async function engageKill(scopeAgentId: string | null): Promise<string> {
    const kill = await prisma.agentKillSwitch.create({
        data: { tenantId: TENANT, agentId: scopeAgentId, reason: 'gate test', engagedByUserId: OWNER },
    });
    return kill.id;
}

async function liftKill(id: string): Promise<void> {
    await prisma.agentKillSwitch.update({ where: { id }, data: { liftedAt: new Date(), liftedByUserId: OWNER, liftReason: 'gate test' } });
}

async function setStatus(status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    await prisma.registeredAgent.update({ where: { id: agentId }, data: { status } });
}

describeFn('an agent-bound key stops at the REST door when its agent is stopped (#4481)', () => {
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
                name: 'rest-gate-probe',
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
        agentKey = await mintKey('agent-bound', agentId);
        unboundKey = await mintKey('unbound', null);
    });

    afterAll(async () => {
        await prisma.agentKillSwitch.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
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

    it('serves an ACTIVE, unkilled agent\'s key, and writes no denial (the positive control)', async () => {
        expect(await listRisks(agentKey)).toBe(200);
        expect(await gateDenials()).toEqual([]);
    });

    it('refuses the key while an AGENT-scope kill is in force, with one denial row, and serves it once lifted', async () => {
        const killId = await engageKill(agentId);
        try {
            expect(await listRisks(agentKey)).toBe(403);
            const denials = await gateDenials();
            expect(denials).toHaveLength(1);
            expect(denials[0]).toMatchObject({
                category: 'access',
                reason: 'agent_killed',
                killScope: 'AGENT',
                killSwitchId: killId,
                agentId,
                method: 'GET',
                path: `/api/t/${TENANT}/risks`,
            });
        } finally {
            await liftKill(killId);
        }
        expect(await listRisks(agentKey)).toBe(200);
    });

    it('refuses the key while a TENANT-scope kill is in force, and leaves a key bound to no agent alone', async () => {
        const before = (await gateDenials()).length;
        const killId = await engageKill(null);
        try {
            expect(await listRisks(agentKey)).toBe(403);
            expect(await listRisks(unboundKey)).toBe(200);
            const denials = await gateDenials();
            expect(denials).toHaveLength(before + 1);
            expect(denials[denials.length - 1]).toMatchObject({ reason: 'agent_killed', killScope: 'TENANT', killSwitchId: killId });
        } finally {
            await liftKill(killId);
        }
    });

    it('refuses a SUSPENDED agent\'s key, naming the status, and serves it once the agent is ACTIVE again', async () => {
        const before = (await gateDenials()).length;
        await setStatus('SUSPENDED');
        try {
            expect(await listRisks(agentKey)).toBe(403);
            const denials = await gateDenials();
            expect(denials).toHaveLength(before + 1);
            expect(denials[denials.length - 1]).toMatchObject({ reason: 'agent_not_active', agentStatus: 'SUSPENDED', killScope: null });
        } finally {
            await setStatus('ACTIVE');
        }
        expect(await listRisks(agentKey)).toBe(200);
    });
});
