/**
 * A STORED `MANAGED_AGENTS` READS AS ITSELF, AND NO WRITER ACCEPTS IT
 * (Step 5b of `docs/claude-managed-agents-design.md`, #4165, deploy 1 of 2).
 *
 * Against the real database and the real generated client: the value is in the
 * physical enum (the migration), a row carrying it is readable by the typed
 * client and by the text reader, the settings read reports it as the tenant's
 * mode while the effective engine stays static, and the settings writer refuses
 * to write it and leaves the stored value as it was.
 *
 * The row is put there by raw SQL, standing in for a later build that wrote it:
 * in this build there is no other way.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { readStoredDriverMode } from '@/lib/agentic/agent-driver-stored-mode';
import { resolveAgentDriver } from '@/lib/agentic/agent-driver';
import { getAgentDriverSetting, setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = `driver-ma-${randomUUID().slice(0, 8)}`;
let ownerId = '';
const ctx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: ownerId });

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    ownerId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: ownerId, role: 'OWNER', status: 'ACTIVE' } });
    await prisma.tenantSecuritySettings.create({ data: { tenantId: T } });
    await prisma.$executeRawUnsafe(
        `UPDATE "TenantSecuritySettings" SET "agentDriver" = 'MANAGED_AGENTS'::"AgentDriverMode" WHERE "tenantId" = $1`,
        T,
    );
});

afterAll(async () => {
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
});

describe('MANAGED_AGENTS is a READ_ONLY driver mode', () => {
    it('the typed client and the text reader both read the stored value as itself', async () => {
        const row = await prisma.tenantSecuritySettings.findUnique({ where: { tenantId: T }, select: { agentDriver: true } });
        expect(row?.agentDriver).toBe('MANAGED_AGENTS');
        expect(await readStoredDriverMode(prisma, T)).toBe('MANAGED_AGENTS');
    });

    it('the settings read reports it as the tenant\'s mode, and the engine in force is static', async () => {
        const setting = await getAgentDriverSetting(ctx());
        expect(setting.mode).toBe('MANAGED_AGENTS');
        expect(setting.effective.driver).toBe('static');
        // Every switch on: still static, because the build does not implement it.
        expect(
            resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: true, managedAgentsEnvEnabled: true, tenantSetting: await readStoredDriverMode(prisma, T) }),
        ).toEqual({ driver: 'static', reason: 'DRIVER_NOT_IMPLEMENTED' });
    });

    it('the settings writer refuses to write it, and the stored value is unchanged', async () => {
        await setAgentDriverSetting(ctx(), 'STATIC');
        expect(await readStoredDriverMode(prisma, T)).toBe('STATIC');
        await expect(setAgentDriverSetting(ctx(), 'MANAGED_AGENTS' as never)).rejects.toThrow();
        expect(await readStoredDriverMode(prisma, T)).toBe('STATIC');
    });
});
