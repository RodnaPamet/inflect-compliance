/**
 * A WORKSPACE CHOOSES THE MANAGED AGENTS ENGINE ONLY WITH A CONNECTED ANTHROPIC
 * WORKSPACE (Step 5d of `docs/claude-managed-agents-design.md`, #4167).
 *
 * Against the real database and the real generated client:
 *
 *   • the value is in the physical enum and reads as itself through the typed
 *     client and the text reader (it was READ_ONLY in Step 5b, and is written
 *     now);
 *   • with NO enabled `anthropic-workspace` connection, a DISABLED one only, or
 *     TWO enabled ones, the writer refuses it by name and the stored value is
 *     unchanged;
 *   • with exactly one, the writer stores it, the read reports the workspace
 *     CONNECTED, and moving away again needs no workspace.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { hashForLookup } from '@/lib/security/encryption';
import { readStoredDriverMode } from '@/lib/agentic/agent-driver-stored-mode';
import { getAgentDriverSetting, setAgentDriverSetting } from '@/app-layer/usecases/agent-driver-setting';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = `driver-ma-${randomUUID().slice(0, 8)}`;
let ownerId = '';
const ctx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: ownerId });

async function connection(isEnabled: boolean): Promise<string> {
    const row = await prisma.integrationConnection.create({
        data: {
            tenantId: T,
            provider: 'anthropic-workspace',
            name: `Anthropic workspace ${randomUUID().slice(0, 8)}`,
            configJson: { workspaceId: `wrkspc_${randomUUID().slice(0, 8)}` },
            isEnabled,
        },
        select: { id: true },
    });
    return row.id;
}

async function refusalOf(p: Promise<unknown>): Promise<{ status?: number; reason?: string }> {
    try {
        await p;
    } catch (err) {
        const e = err as { status?: number; details?: { reason?: string } };
        return { status: e.status, reason: e.details?.reason };
    }
    throw new Error('expected a refusal');
}

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    ownerId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: ownerId, role: 'OWNER', status: 'ACTIVE' } });
    await prisma.tenantSecuritySettings.create({ data: { tenantId: T } });
});

afterAll(async () => {
    await prisma.integrationConnection.deleteMany({ where: { tenantId: T } });
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
    __resetAuditStreamForTests();
});

describe('choosing the Managed Agents engine needs exactly one connected workspace', () => {
    it('with no connection at all, it is refused by name and nothing is stored', async () => {
        expect((await getAgentDriverSetting(ctx())).managedAgents.workspace).toBe('NONE');
        expect(await refusalOf(setAgentDriverSetting(ctx(), 'MANAGED_AGENTS'))).toEqual({
            status: 409,
            reason: 'MANAGED_AGENTS_NO_WORKSPACE',
        });
        expect(await readStoredDriverMode(prisma, T)).toBe('STATIC');
    });

    it('a DISABLED connection (a removed one) does not count', async () => {
        await connection(false);
        expect((await getAgentDriverSetting(ctx())).managedAgents.workspace).toBe('NONE');
        expect((await refusalOf(setAgentDriverSetting(ctx(), 'MANAGED_AGENTS'))).reason).toBe('MANAGED_AGENTS_NO_WORKSPACE');
        expect(await readStoredDriverMode(prisma, T)).toBe('STATIC');
    });

    it('with two enabled connections, it is refused: a run never chooses between them', async () => {
        const a = await connection(true);
        const b = await connection(true);
        try {
            expect((await getAgentDriverSetting(ctx())).managedAgents.workspace).toBe('AMBIGUOUS');
            expect(await refusalOf(setAgentDriverSetting(ctx(), 'MANAGED_AGENTS'))).toEqual({
                status: 409,
                reason: 'MANAGED_AGENTS_AMBIGUOUS_WORKSPACE',
            });
            expect(await readStoredDriverMode(prisma, T)).toBe('STATIC');
        } finally {
            await prisma.integrationConnection.deleteMany({ where: { id: { in: [a, b] } } });
        }
    });

    it('with exactly one, it is stored and reads as itself through both readers', async () => {
        await connection(true);
        const after = await setAgentDriverSetting(ctx(), 'MANAGED_AGENTS');
        expect(after.mode).toBe('MANAGED_AGENTS');
        expect(after.managedAgents.workspace).toBe('CONNECTED');
        const row = await prisma.tenantSecuritySettings.findUnique({ where: { tenantId: T }, select: { agentDriver: true } });
        expect(row?.agentDriver).toBe('MANAGED_AGENTS');
        expect(await readStoredDriverMode(prisma, T)).toBe('MANAGED_AGENTS');
    });

    it('moving away needs no workspace, even once the connection is gone', async () => {
        await prisma.integrationConnection.updateMany({ where: { tenantId: T }, data: { isEnabled: false } });
        await setAgentDriverSetting(ctx(), 'STATIC');
        expect(await readStoredDriverMode(prisma, T)).toBe('STATIC');
    });
});
