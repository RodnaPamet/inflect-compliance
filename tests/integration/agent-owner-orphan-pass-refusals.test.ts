/**
 * EVERY REFUSAL OF THE OWNER-ORPHAN PASS RECORDS A ROW (#3670) — the two paths
 * the main suite cannot reach without a mock.
 *
 *   MODE_ABOVE_CLAMP is unreachable today: `ORPHAN_PASS_MAX_MODE` sits on the
 *   ladder's top rung, so no stored mode is above it. It is kept as the brake —
 *   narrowing the constant is the change an incident would ship — and the brake
 *   must leave a row when it bites, or a tenant clamped this way would look,
 *   from inside the product, exactly like a dead worker. So the constant is
 *   narrowed HERE, by mock, and the row asserted.
 *
 *   ERROR is a pass that threw. It writes its own row through its own seam,
 *   names the cause, and still returns — the sweep goes on to the next tenant.
 *
 * Real database throughout; only the ceiling and one read are overridden.
 */
const mockState: { throwOnPolicyRead: boolean; clamp: string; failKill: boolean } = {
    throwOnPolicyRead: false,
    clamp: 'DRY_RUN',
    failKill: false,
};

jest.mock('@/lib/agentic/owner-orphan', () => {
    const actual = jest.requireActual('@/lib/agentic/owner-orphan');
    // A GETTER, so each test chooses the ceiling it runs under — defined with
    // `defineProperty`, because an object-literal getter beside a spread is
    // compiled to `Object.assign`, which reads it ONCE.
    const mod = { ...actual };
    Object.defineProperty(mod, 'ORPHAN_PASS_MAX_MODE', { get: () => mockState.clamp, enumerable: true });
    return mod;
});

jest.mock('@/app-layer/usecases/agent-kill-switch', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-kill-switch');
    return {
        ...actual,
        engageOwnerDepartedKill: (...args: unknown[]) =>
            mockState.failKill
                ? Promise.reject(new Error('simulated kill-switch write failure'))
                : actual.engageOwnerDepartedKill(...args),
    };
});

jest.mock('@/app-layer/usecases/agent-owner-orphan-policy', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-owner-orphan-policy');
    return {
        ...actual,
        getAgentOrphanPassPolicy: (...args: unknown[]) => {
            if (mockState.throwOnPolicyRead) {
                return Promise.reject(new Error('simulated settings read failure'));
            }
            return actual.getAgentOrphanPassPolicy(...args);
        },
    };
});

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { runAgentOwnerOrphanPass } from '@/app-layer/usecases/agent-owner-orphan-pass';
import { runAgentOwnerOrphanPassJob } from '@/app-layer/jobs/agent-owner-orphan-pass';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T = `orphan-refusals-${randomUUID().slice(0, 8)}`;
let ownerId = '';
let agentId = '';

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `departed@${T}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ownerId = user.id;
    // The owner's membership is DEACTIVATED: an orphan the pass would stop.
    await prisma.tenantMembership.create({
        data: { tenantId: T, userId: ownerId, role: 'EDITOR', status: 'DEACTIVATED' },
    });
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: 'refusal host', ownerUserId: ownerId } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T, aiSystemId: sys.id, name: 'refusal probe', autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA', reversibility: 'REVERSIBLE', provenance: 'FIRST_PARTY',
            ownerUserId: ownerId, status: 'ACTIVE', riskTier: 'LOW', riskTierScoredAt: new Date(),
        },
    });
    agentId = agent.id;
    await prisma.tenantSecuritySettings.create({ data: { tenantId: T, agentOrphanPassMode: 'AUTOMATIC' } });
});

afterEach(() => {
    mockState.throwOnPolicyRead = false;
    mockState.clamp = 'DRY_RUN';
    mockState.failKill = false;
});

afterAll(async () => {
    await prisma.notification.deleteMany({ where: { tenantId: T } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId: T } });
    await prisma.agentKillSwitch.deleteMany({ where: { tenantId: T } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: T } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: T } });
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

const rows = () =>
    prisma.integrationExecution.findMany({
        where: { tenantId: T, automationKey: 'agentic.owner_orphan_pass' },
        orderBy: { executedAt: 'asc' },
    });

describe('the clamp, narrowed, refuses on a row and stops nothing', () => {
    it('records MODE_ABOVE_CLAMP for a tenant stored above the ceiling', async () => {
        const result = await runAgentOwnerOrphanPass({ tenantId: T, tenantSlug: T });
        expect(result).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'MODE_ABOVE_CLAMP', mode: 'AUTOMATIC' });
        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('NOT_APPLICABLE');
        expect(all[0].resultJson).toMatchObject({ refusal: 'MODE_ABOVE_CLAMP', maxMode: 'DRY_RUN' });
        // The orphan is not stopped: the brake held.
        expect(await prisma.agentKillSwitch.count({ where: { tenantId: T } })).toBe(0);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId } })).status).toBe('ACTIVE');
    });
});

describe('a pass that throws', () => {
    it('writes an ERROR row naming the cause, and returns', async () => {
        mockState.throwOnPolicyRead = true;
        const result = await runAgentOwnerOrphanPass({ tenantId: T, tenantSlug: T });
        expect(result.status).toBe('ERROR');
        const last = (await rows()).at(-1);
        expect(last?.status).toBe('ERROR');
        expect((last?.resultJson as { detail: string }).detail).toMatch(/simulated settings read failure/);
    });

    it('does not fail the job: the tenant\'s failure is its own row', async () => {
        mockState.throwOnPolicyRead = true;
        const job = await runAgentOwnerOrphanPassJob({ tenantId: T });
        expect(job.success).toBe(true);
        expect(job.itemsSkipped).toBe(1);
    });
});

describe('a containment that fails half way is PARTIAL, and says so', () => {
    it('suspends the agent even when the kill cannot be engaged, and records which half did not land', async () => {
        mockState.clamp = 'AUTOMATIC';
        mockState.failKill = true;
        const result = await runAgentOwnerOrphanPass({ tenantId: T, tenantSlug: T });
        expect(result).toMatchObject({ status: 'PARTIAL', failed: 1, contained: 0 });
        const last = (await rows()).at(-1);
        expect(last?.status).toBe('PARTIAL');
        const [decision] = (last?.resultJson as { decisions: Record<string, unknown>[] }).decisions;
        expect(decision).toMatchObject({ outcome: 'FAILED', failedStep: 'KILL', suspended: true });
        expect((decision.error as string)).toMatch(/simulated kill-switch write failure/);
        // The suspension still landed: the agent is stopped by the register.
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId } })).status).toBe('SUSPENDED');
        expect(await prisma.agentKillSwitch.count({ where: { tenantId: T } })).toBe(0);
    });
});
