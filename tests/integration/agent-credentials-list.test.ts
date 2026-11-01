/**
 * #4879 — `listAgentCredentials` lists what can act for an agent, and says
 * whether it can act right now.
 *
 * Against a real database because the population is a JSON-array filter
 * (`scopes @> ["mcp:read"]`, one per `MCP_ENDPOINT_SCOPES` entry) and the kill
 * state is read from the kill-switch table — neither is worth mocking.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { makeRequestContext } from '../helpers/make-context';
import { AGENT_CREDENTIALS_CAP, listAgentCredentials } from '@/app-layer/usecases/api-keys';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `acred-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const BIG_TENANT = `t-${SUITE}-big`;
const USER = `u-${SUITE}`;

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});

const ctx = (tenantId = TENANT) =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: USER });

async function seedAgent(name: string, status: 'ACTIVE' | 'SUSPENDED' | 'DRAFT'): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
            status,
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return agent.id;
}

async function mintKey(
    name: string,
    opts: { agentId?: string | null; scopes: string[]; revoked?: boolean; tenantId?: string },
): Promise<string> {
    const { keyHash, keyPrefix } = generateApiKey();
    const row = await prisma.tenantApiKey.create({
        data: {
            tenantId: opts.tenantId ?? TENANT,
            name,
            keyPrefix,
            keyHash,
            scopes: opts.scopes,
            createdById: USER,
            agentId: opts.agentId ?? null,
            revokedAt: opts.revoked ? new Date() : null,
        },
    });
    return row.id;
}

async function setEnforcement(requireRegisteredAgent: boolean): Promise<void> {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        update: { requireRegisteredAgent },
        create: { tenantId: TENANT, requireRegisteredAgent },
    });
}

describeFn('the agent credentials list', () => {
    const ids: Record<string, string> = {};

    beforeAll(async () => {
        await prisma.$connect();
        for (const id of [TENANT, BIG_TENANT]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        for (const tenantId of [TENANT, BIG_TENANT]) {
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId, userId: USER } },
                update: { role: 'OWNER', status: 'ACTIVE' },
                create: { tenantId, userId: USER, role: 'OWNER', status: 'ACTIVE' },
            });
        }

        const active = await seedAgent('active-agent', 'ACTIVE');
        const suspended = await seedAgent('suspended-agent', 'SUSPENDED');
        const killed = await seedAgent('killed-agent', 'ACTIVE');
        await prisma.agentKillSwitch.create({
            data: { tenantId: TENANT, agentId: killed, engagedByUserId: USER, reason: 'incident drill' },
        });

        ids.active = await mintKey('active', { agentId: active, scopes: ['mcp:read'] });
        ids.suspended = await mintKey('suspended', { agentId: suspended, scopes: ['mcp:read'] });
        ids.killed = await mintKey('killed', { agentId: killed, scopes: ['mcp:read'] });
        ids.revoked = await mintKey('revoked', { agentId: active, scopes: ['mcp:read'], revoked: true });
        ids.unboundMcp = await mintKey('unbound-mcp', { scopes: ['mcp:read', 'risks:read'] });
        ids.unboundWildcard = await mintKey('unbound-wildcard', { scopes: ['*'] });
        ids.integration = await mintKey('ci-pipeline', { scopes: ['risks:read', 'controls:read'] });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, [TENANT, BIG_TENANT]);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" IN ($1, $2)`,
                TENANT,
                BIG_TENANT,
            );
        });
        await prisma.agentKillSwitch.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: { in: [TENANT, BIG_TENANT] } } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, BIG_TENANT] } } });
        await prisma.$disconnect();
    });

    it('lists agent-bound keys and unbound keys the agent tools admit, and no other key', async () => {
        await setEnforcement(true);
        const { credentials, truncated } = await listAgentCredentials(ctx());
        const listed = new Set(credentials.map((c) => c.id));

        for (const name of ['active', 'suspended', 'killed', 'revoked', 'unboundMcp', 'unboundWildcard']) {
            expect(listed.has(ids[name])).toBe(true);
        }
        expect(listed.has(ids.integration)).toBe(false);
        expect(truncated).toBe(false);
    });

    it('says which keys can act, and why the others cannot', async () => {
        await setEnforcement(true);
        const { credentials } = await listAgentCredentials(ctx());
        const standing = (id: string) => credentials.find((c) => c.id === id)?.standing;

        expect(standing(ids.active)).toEqual({ kind: 'governed' });
        expect(standing(ids.suspended)).toEqual({ kind: 'stopped', reason: 'AGENT_SUSPENDED' });
        expect(standing(ids.killed)).toEqual({ kind: 'stopped', reason: 'KILL_AGENT' });
        expect(standing(ids.revoked)).toEqual({ kind: 'inactive' });
        expect(standing(ids.unboundMcp)).toEqual({ kind: 'stopped', reason: 'NOT_REGISTERED' });
    });

    it('an unbound key in a workspace that does not require registration acts with no agent controls', async () => {
        await setEnforcement(false);
        const { credentials } = await listAgentCredentials(ctx());
        const unbound = credentials.find((c) => c.id === ids.unboundMcp);

        expect(unbound?.standing).toEqual({ kind: 'ungoverned', reason: 'NO_AGENT' });
        // No agent term narrows it: its ceiling is the key's own, unclamped.
        expect(unbound?.effectiveAutonomy).toBe(6);
        await setEnforcement(true);
    });

    it('a workspace kill stops every live key', async () => {
        const kill = await prisma.agentKillSwitch.create({
            data: { tenantId: TENANT, agentId: null, engagedByUserId: USER, reason: 'incident drill' },
        });
        try {
            const { credentials } = await listAgentCredentials(ctx());
            expect(credentials.find((c) => c.id === ids.active)?.standing).toEqual({
                kind: 'stopped',
                reason: 'KILL_TENANT',
            });
        } finally {
            await prisma.agentKillSwitch.update({
                where: { id: kill.id },
                data: { liftedAt: new Date(), liftedByUserId: USER, liftReason: 'drill over' },
            });
        }
    });

    it(`stops at ${AGENT_CREDENTIALS_CAP} and says so`, async () => {
        const rows = Array.from({ length: AGENT_CREDENTIALS_CAP + 1 }, (_, i) => {
            const { keyHash, keyPrefix } = generateApiKey();
            return {
                tenantId: BIG_TENANT,
                name: `bulk-${i}`,
                keyPrefix,
                keyHash,
                scopes: ['mcp:read'],
                createdById: USER,
            };
        });
        await prisma.tenantApiKey.createMany({ data: rows });

        const { credentials, truncated } = await listAgentCredentials(ctx(BIG_TENANT));
        expect(credentials).toHaveLength(AGENT_CREDENTIALS_CAP);
        expect(truncated).toBe(true);
    });
});
