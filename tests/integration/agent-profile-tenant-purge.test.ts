/**
 * A tenant purge removes agent profiles with the tenant (Step 1H of
 * `docs/claude-agent-sdk-design.md`, #4145).
 *
 * `docs/data-retention.md` classes `AgentProfile` as Configuration and
 * `AgentProfileVersion` as a Business record, and says both are purged with the
 * tenant: the instructions are the tenant's own text, the runs that pin a
 * version are purged with it too, and the hash-chained `AGENT_PROFILE_*` audit
 * rows, which carry each version's hash, are what survive. This proves the
 * purge does exactly that, through the real `purgeSoftDeletedTenants`, on rows
 * written by the real usecases (a version in force, a rejected one with its
 * reason, and an open draft), and leaves another tenant's profile untouched.
 */
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (key === 'AGENT_PROFILES' ? '1' : Reflect.get(target, key)),
        }),
    };
});

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { purgeSoftDeletedTenants, TENANT_PURGE_RETAINED } from '@/app-layer/usecases/tenant-purge';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    createAgentProfileVersion,
    rejectAgentProfileVersion,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import type { RequestContext } from '@/app-layer/types';
import { prisma as appPrisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `appurge-${randomUUID().slice(0, 8)}`;
const PURGED = `tp-${SUITE}`;
const KEPT = `tk-${SUITE}`;
const TENANTS = [PURGED, KEPT];
const PROFILE_TABLES = ['AgentProfile', 'AgentProfileVersion'] as const;

const author = (tenantId: string) => `${tenantId}-author`;
const reviewer = (tenantId: string) => `${tenantId}-reviewer`;
const agentOf = (tenantId: string) => `${tenantId}-agent`;
const ctx = (tenantId: string, userId: string, role: Role): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId });

const version = (instructions: string): AgentProfileVersionInput => ({
    instructions,
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN'],
});

/** Profile rows of one tenant, by table. */
async function profileRows(tenantId: string): Promise<Record<(typeof PROFILE_TABLES)[number], number>> {
    return {
        AgentProfile: await prisma.agentProfile.count({ where: { tenantId } }),
        AgentProfileVersion: await prisma.agentProfileVersion.count({ where: { tenantId } }),
    };
}

/** A tenant with an agent whose profile has a version in force, a rejected one and an open draft. */
async function seedTenant(tenantId: string): Promise<void> {
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    for (const [id, role] of [[author(tenantId), 'OWNER'], [reviewer(tenantId), 'ADMIN']] as const) {
        const email = `${id}@example.test`;
        await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId, userId: id, role, status: 'ACTIVE' } });
    }
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${tenantId}` } });
    await prisma.registeredAgent.create({
        data: {
            id: agentOf(tenantId),
            tenantId,
            aiSystemId: sys.id,
            name: `agent ${tenantId}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: author(tenantId),
            status: 'ACTIVE',
        },
    });
    await prisma.registeredAgentTool.create({
        data: { tenantId, agentId: agentOf(tenantId), toolName: 'list_risks', grantedByUserId: author(tenantId) },
    });

    const a = ctx(tenantId, author(tenantId), 'OWNER');
    const r = ctx(tenantId, reviewer(tenantId), 'ADMIN');
    const agentId = agentOf(tenantId);
    const v1 = await createAgentProfile(a, agentId, version('Summarise the open risks for the weekly review.'));
    await submitAgentProfileVersion(a, agentId, 1);
    await approveAgentProfileVersion(r, agentId, 1, { instructionsHash: v1.instructionsHash });
    await createAgentProfileVersion(a, agentId, version('Summarise the open risks, grouped by owner.'));
    await submitAgentProfileVersion(a, agentId, 2);
    await rejectAgentProfileVersion(r, agentId, 2, { reason: 'Say what to do when a risk has no owner.' });
    await createAgentProfileVersion(a, agentId, version('Summarise the open risks, and name any without an owner.'));
}

/** The purge leaves a tombstone tenant and the retained tables; clear them so the suite leaks nothing. */
async function cleanup(): Promise<void> {
    const existing = await prisma.tenant.findMany({ where: { id: { in: TENANTS } }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    await deleteAuditRowsForTenants(prisma, TENANTS).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: TENANTS.flatMap((t) => [author(t), reviewer(t)]) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

describeFn('a tenant purge removes agent profiles with the tenant (real DB)', () => {
    let purgedBefore: Record<string, number>;
    let keptBefore: Record<string, number>;
    let result: Awaited<ReturnType<typeof purgeSoftDeletedTenants>>;

    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await seedTenant(PURGED);
        await seedTenant(KEPT);
        purgedBefore = await profileRows(PURGED);
        keptBefore = await profileRows(KEPT);
        await prisma.tenant.update({ where: { id: PURGED }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        result = await purgeSoftDeletedTenants({ tenantId: PURGED });
    });

    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    it('the fixture is what it claims: a profile with three versions in each tenant', () => {
        // A positive control: "nothing left" is vacuous over empty tables.
        expect(purgedBefore).toEqual({ AgentProfile: 1, AgentProfileVersion: 3 });
        expect(keptBefore).toEqual({ AgentProfile: 1, AgentProfileVersion: 3 });
    });

    it('neither table is retained, as docs/data-retention.md classes them', () => {
        for (const table of PROFILE_TABLES) expect(TENANT_PURGE_RETAINED.has(table)).toBe(false);
    });

    it('deletes every profile row of the purged tenant, and says so in its result', async () => {
        expect(await profileRows(PURGED)).toEqual({ AgentProfile: 0, AgentProfileVersion: 0 });
        const [mine] = result.filter((r) => r.tenantId === PURGED);
        expect(mine.dryRun).toBe(false);
        // Children first, so each table is deleted by the purge itself, not by
        // a cascade from a parent, and reports exactly the rows it held.
        expect({ AgentProfile: mine.deleted.AgentProfile, AgentProfileVersion: mine.deleted.AgentProfileVersion }).toEqual(purgedBefore);
    });

    it('leaves another tenant\'s profile untouched', async () => {
        expect(await profileRows(KEPT)).toEqual(keptBefore);
    });

    it('keeps the hash-chained audit rows that carry each version\'s hash', async () => {
        const actions = await prisma.auditLog.findMany({
            where: { tenantId: PURGED, action: { startsWith: 'AGENT_PROFILE_' } },
            select: { action: true },
        });
        expect(actions.map((a) => a.action).sort()).toEqual(
            expect.arrayContaining(['AGENT_PROFILE_APPROVED', 'AGENT_PROFILE_REJECTED', 'AGENT_PROFILE_SUBMITTED']),
        );
    });
});
