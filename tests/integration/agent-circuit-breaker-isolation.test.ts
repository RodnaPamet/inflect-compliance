/**
 * The agent behavioural circuit breaker — tenant isolation, and the three
 * properties only a real database can establish.
 *
 *   1. ISOLATION. The ledger is a behavioural profile of one customer's agent:
 *      when it runs, how hard, and what kinds of tool it reaches for. A
 *      cross-tenant read of it is a description of how another customer operates,
 *      and a cross-tenant read of the LATCH would say whether their agent is
 *      currently stopped. Driven through the real usecase under two tenant
 *      contexts, plus raw reads under `app_user` with and without a tenant bound.
 *
 *   2. THE PER-CALL UPSERT IS ONE STATEMENT. The counter increment and the
 *      tool-name append happen inside one `INSERT … ON CONFLICT DO UPDATE`
 *      precisely so concurrent calls cannot both read an array and both write it
 *      back. A unit test with a mocked client proves nothing about that; only
 *      concurrent statements against a real Postgres do.
 *
 *   3. THE LATCH, END TO END. `evaluateCircuitBreaker` is unit-tested on
 *      fixtures. This asserts the store actually assembles that argument from
 *      rows, that a TRIP reaches the latch column, and that the accountability
 *      CHECK refuses a close nobody's name is against — the last of which is the
 *      entire reason an un-trip is manual.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    closeAgentCircuitBreaker,
    getAgentCircuitBreaker,
} from '@/app-layer/usecases/agent-circuit-breaker';
import {
    evaluateWindow,
    observeToolCall,
    openBreakerGate,
    readBreakerLatch,
} from '@/lib/agentic/circuit-breaker-store';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'breaker-tenant-one';
const T2 = 'breaker-tenant-two';

/** A fixed clock. Hour 0 is "now" for every case below. */
const HOUR = 3_600_000;
const ORIGIN = Date.parse('2026-09-01T00:00:00.000Z');
const at = (hour: number): Date => new Date(ORIGIN + hour * HOUR);

async function asAppUserWithNoTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * `resetDatabase` truncates a fixed table list that includes none of these, so
 * this suite clears its own rows — otherwise it passes exactly once on a fresh
 * database and fails every re-run, and CI always starts clean, which is what
 * would hide it.
 *
 * The AuditLog / TenantMembership deletes go through `session_replication_role
 * = 'replica'`: the immutable-audit-log trigger and the last-OWNER guard both
 * fire on an ordinary DELETE and would take the teardown down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agentBehaviourWindow.deleteMany({ where: t });
    await prisma.agentCircuitBreaker.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((x) => hashForLookup(`owner@${x}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { agentId: string; aiSystemId: string; ownerUserId: string }> = {};

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

/** A completed window, written straight to the ledger. */
async function seedWindow(
    tenantId: string,
    hour: number,
    counts: { read?: number; propose?: number; tools?: string[] },
): Promise<void> {
    await prisma.agentBehaviourWindow.create({
        data: {
            tenantId,
            agentId: seeded[tenantId].agentId,
            windowStart: at(hour),
            readCalls: counts.read ?? 0,
            proposeCalls: counts.propose ?? 0,
            toolNames: counts.tools ?? ['agent.framework_status'],
        },
    });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: id, name: `Agent host ${id}`, ownerUserId: user.id },
        });
        seeded[id] = { agentId: '', aiSystemId: aiSystem.id, ownerUserId: user.id };
    }

    for (const t of [T1, T2]) {
        const created = await createRegisteredAgent(ctxFor(t), {
            aiSystemId: seeded[t].aiSystemId,
            name: `Ops agent ${t}`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: seeded[t].ownerUserId,
        });
        seeded[t].agentId = created.id;

        // The latch, and an epoch old enough that the seeded history is inside
        // it. In production the epoch is stamped on the agent's first observed
        // call, so it always precedes its own ledger; a test that seeded the
        // past without moving it would silently discard every window and then
        // assert about an empty baseline.
        await openBreakerGate(t, created.id);
        await prisma.agentCircuitBreaker.update({
            where: { tenantId_agentId: { tenantId: t, agentId: created.id } },
            data: { baselineEpoch: at(-100) },
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a behavioural ledger belongs to exactly one tenant', () => {
    beforeAll(async () => {
        // Both tenants observed, so a leak between them would be legible rather
        // than looking like an empty table.
        for (const t of [T1, T2]) {
            await observeToolCall(t, seeded[t].agentId, 'read', `agent.${t}_only`, at(-50));
        }
    });

    it('BOTH tenants really have ledger rows — otherwise every assertion below is vacuous', async () => {
        const rows = await prisma.agentBehaviourWindow.findMany({
            where: { tenantId: { in: [T1, T2] } },
            select: { tenantId: true },
        });
        expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([T1, T2]));
    });

    it('the usecase refuses another tenant’s agent outright', async () => {
        await expect(
            getAgentCircuitBreaker(ctxFor(T2), seeded[T1].agentId),
        ).rejects.toThrow(/not found/i);
    });

    it('app_user bound to tenant two sees none of tenant one’s windows', async () => {
        const rows = await asTenant(T2, (tx) =>
            tx.agentBehaviourWindow.findMany({ where: { tenantId: T1 } }),
        );
        expect(rows).toEqual([]);
    });

    it('app_user bound to tenant two sees none of tenant one’s latches', async () => {
        const rows = await asTenant(T2, (tx) =>
            tx.agentCircuitBreaker.findMany({ where: { tenantId: T1 } }),
        );
        expect(rows).toEqual([]);
    });

    it('app_user with NO tenant bound sees nothing at all', async () => {
        const windows = await asAppUserWithNoTenant((tx) => tx.agentBehaviourWindow.findMany({}));
        const latches = await asAppUserWithNoTenant((tx) => tx.agentCircuitBreaker.findMany({}));
        expect(windows).toEqual([]);
        expect(latches).toEqual([]);
    });

    it('and the positive control: tenant one, bound to itself, does see its own', async () => {
        // The paired positive. Every assertion above is satisfied by a policy
        // that denies EVERYONE, which is a different (and useless) system.
        const rows = await asTenant(T1, (tx) =>
            tx.agentBehaviourWindow.findMany({ where: { tenantId: T1 } }),
        );
        expect(rows.length).toBeGreaterThan(0);
    });
});

describe('the per-call observation is one statement', () => {
    it('concurrent calls in the same window lose neither a count nor a tool name', async () => {
        // The read-modify-write this upsert exists to avoid: eight concurrent
        // calls, each appending a DIFFERENT tool name to the same array. Done in
        // application code, some of those appends would read the same array and
        // overwrite each other, and the loss would be invisible — a slightly
        // shorter tool list is not an error anybody notices.
        const tools = Array.from({ length: 8 }, (_unused, i) => `agent.concurrent_${i}`);
        await Promise.all(
            tools.map((tool) => observeToolCall(T1, seeded[T1].agentId, 'read', tool, at(-40))),
        );

        const row = await prisma.agentBehaviourWindow.findUnique({
            where: {
                tenantId_agentId_windowStart: {
                    tenantId: T1,
                    agentId: seeded[T1].agentId,
                    windowStart: at(-40),
                },
            },
            select: { readCalls: true, toolNames: true },
        });

        expect(row?.readCalls).toBe(8);
        expect([...(row?.toolNames ?? [])].sort()).toEqual([...tools].sort());
    });

    it('the same tool called twice appears once', async () => {
        await observeToolCall(T1, seeded[T1].agentId, 'read', 'agent.repeat', at(-39));
        await observeToolCall(T1, seeded[T1].agentId, 'read', 'agent.repeat', at(-39));

        const row = await prisma.agentBehaviourWindow.findUnique({
            where: {
                tenantId_agentId_windowStart: {
                    tenantId: T1,
                    agentId: seeded[T1].agentId,
                    windowStart: at(-39),
                },
            },
            select: { readCalls: true, toolNames: true },
        });

        expect(row?.readCalls).toBe(2);
        expect(row?.toolNames).toEqual(['agent.repeat']);
    });
});

describe('a read-only agent that starts proposing latches OPEN, and a human closes it', () => {
    beforeAll(async () => {
        // Twelve complete read-only windows: exactly the minimum baseline, at
        // five calls each, so the observation floor is met too.
        for (let i = 0; i < 12; i++) await seedWindow(T2, -30 + i, { read: 5 });
    });

    it('the first propose window ARMS but does not trip', async () => {
        await seedWindow(T2, -3, {
            read: 4,
            propose: 1,
            tools: ['agent.framework_status', 'agent.propose_risk'],
        });

        const latch = await readBreakerLatch(T2, seeded[T2].agentId);
        const outcome = await evaluateWindow(T2, seeded[T2].agentId, at(-2), latch!);

        expect(outcome.evaluated).toBe(true);
        expect(outcome.verdict?.code).toBe('ARMED');
        expect(outcome.verdict?.firing).toEqual(['TOOL_MIX']);

        const after = await readBreakerLatch(T2, seeded[T2].agentId);
        expect(after?.state).toBe('CLOSED');
        expect(after?.anomalousStreak).toBe(1);
    });

    it('the second one trips it, and the anomalous window did not become the baseline', async () => {
        await seedWindow(T2, -2, { read: 3, propose: 2, tools: ['agent.propose_risk'] });

        const latch = await readBreakerLatch(T2, seeded[T2].agentId);
        const outcome = await evaluateWindow(T2, seeded[T2].agentId, at(-1), latch!);

        expect(outcome.verdict?.code).toBe('TRIP');

        const after = await readBreakerLatch(T2, seeded[T2].agentId);
        expect(after?.state).toBe('OPEN');
        expect(after?.trippedSignals).toEqual(['TOOL_MIX']);
        expect(after?.trippedAt).not.toBeNull();

        // The window that armed it is flagged, which is what kept `propose` a
        // class this agent has never used. Without it the signal would have
        // extinguished itself between the two assertions above.
        const armed = await prisma.agentBehaviourWindow.findUnique({
            where: {
                tenantId_agentId_windowStart: {
                    tenantId: T2,
                    agentId: seeded[T2].agentId,
                    windowStart: at(-3),
                },
            },
            select: { anomalous: true, verdict: true },
        });
        expect(armed?.anomalous).toBe(true);
        expect(armed?.verdict).toBe('ARMED');
    });

    it('the usecase surfaces the trip with the baseline it judged against', async () => {
        const view = await getAgentCircuitBreaker(ctxFor(T2), seeded[T2].agentId);
        expect(view.breaker?.state).toBe('OPEN');
        expect(view.breaker?.trippedSignals).toEqual(['TOOL_MIX']);

        // The surface counts the ACCEPTED history, not every row — the same
        // population the detector judged against. Computed from the returned
        // rows rather than hard-coded, so the assertion says "the anomalous
        // windows are excluded" rather than restating whatever total the tests
        // above happened to leave behind.
        const anomalous = view.windows.filter((w) => w.anomalous).length;
        expect(anomalous).toBe(2);
        // Why the equality below survives the newest-window exclusion, spelled
        // out because it is not luck. The fixture drives `evaluateWindow` with
        // a clock in 2026-09-01 while the panel reads the real one, so as far
        // as this payload is concerned the current hour has NOT been judged and
        // the newest row is the subject of the next verdict — excluded from the
        // figures. It is also the anomalous window that tripped the breaker, so
        // it was already excluded, and the two exclusions overlap exactly.
        expect(view.pendingVerdictWindowStart).toEqual(view.windows[0].windowStart);
        expect(view.windows[0].anomalous).toBe(true);
        expect(view.baseline.windows).toBe(view.windows.length - anomalous);
        expect(view.baseline.windows).toBeGreaterThanOrEqual(view.baseline.requiredWindows);
    });

    it('closing it as RESOLVED keeps the baseline and clears the streak', async () => {
        const before = await prisma.agentCircuitBreaker.findUnique({
            where: { tenantId_agentId: { tenantId: T2, agentId: seeded[T2].agentId } },
            select: { baselineEpoch: true },
        });

        const result = await closeAgentCircuitBreaker(ctxFor(T2), seeded[T2].agentId, 'RESOLVED');
        expect(result.rebaselined).toBe(false);

        const after = await prisma.agentCircuitBreaker.findUnique({
            where: { tenantId_agentId: { tenantId: T2, agentId: seeded[T2].agentId } },
            select: {
                state: true,
                closedByUserId: true,
                closeReason: true,
                anomalousStreak: true,
                baselineEpoch: true,
            },
        });
        expect(after?.state).toBe('CLOSED');
        expect(after?.closedByUserId).toBe(seeded[T2].ownerUserId);
        expect(after?.closeReason).toBe('RESOLVED');
        expect(after?.anomalousStreak).toBe(0);
        // RESOLVED means "I fixed the agent", so the history it should return to
        // is kept. Re-baselining here would adopt the rogue behaviour as normal.
        expect(after?.baselineEpoch).toEqual(before?.baselineEpoch);
    });

    it('closing an already-closed breaker is refused rather than silently accepted', async () => {
        // Not idempotent on purpose: a success here would put a name and a
        // reason into the audit trail against a decision nobody made.
        await expect(
            closeAgentCircuitBreaker(ctxFor(T2), seeded[T2].agentId, 'RESOLVED'),
        ).rejects.toThrow(/not open/i);
    });
});

describe('the database refuses a latch nobody is accountable for', () => {
    it('a close with no actor and no reason is rejected', async () => {
        await expect(
            prisma.$executeRaw`
                UPDATE "AgentCircuitBreaker"
                   SET "closedAt" = NOW()
                 WHERE "tenantId" = ${T1} AND "agentId" = ${seeded[T1].agentId}`,
        ).rejects.toThrow(/close_accountability/);
    });

    it('an OPEN latch with no basis is rejected', async () => {
        // A latch with nothing behind it is a latch nobody can argue with, which
        // is how a security control becomes something operators route around.
        await expect(
            prisma.$executeRaw`
                UPDATE "AgentCircuitBreaker"
                   SET "state" = 'OPEN'
                 WHERE "tenantId" = ${T1} AND "agentId" = ${seeded[T1].agentId}`,
        ).rejects.toThrow(/open_has_basis/);
    });

    it('an unknown state is rejected', async () => {
        await expect(
            prisma.$executeRaw`
                UPDATE "AgentCircuitBreaker"
                   SET "state" = 'HALF_OPEN'
                 WHERE "tenantId" = ${T1} AND "agentId" = ${seeded[T1].agentId}`,
        ).rejects.toThrow(/state_known/);
    });
});
