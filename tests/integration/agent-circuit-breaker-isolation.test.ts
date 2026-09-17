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
 *
 *   4. SOMEBODY IS TOLD (#2562). The un-trip being manual assumes a human
 *      learns about the trip, and nothing used to tell them: breaker state is
 *      rendered on one tab of one agent's detail page, selected by local
 *      component state, so a latched agent was visible only to whoever was
 *      already looking at it. The bell is asserted here rather than against a
 *      fake emitter because the properties worth pinning are which ROW gets
 *      written and when — that an ARMED verdict writes none, that a trip which
 *      lost the race to a human close writes none, that a muted workspace
 *      writes none while the latch still flips, and that the one row a real
 *      trip writes is addressed to the agent's accountable owner.
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
    type BreakerLatch,
} from '@/lib/agentic/circuit-breaker-store';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'breaker-tenant-one';
const T2 = 'breaker-tenant-two';
// Three more, one agent each, for the bell cases (#2562). Separate tenants
// rather than separate agents in one: the dedupe key is
// `{tenantId}:{TYPE}:{agentId}:{userId}:{day}`, every case here runs on the
// same fixed clock day, and the mute is a per-TENANT setting — so sharing
// would let one case's row (or one case's mute) decide the next case's count,
// and a zero produced by a duplicate key is not the zero the assertion reads as.
const T3 = 'breaker-tenant-race';
const T4 = 'breaker-tenant-race-control';
const T5 = 'breaker-tenant-muted';
const ALL_TENANTS = [T1, T2, T3, T4, T5];

/** The member this file exists to prove is wired. */
const BREAKER_BELL = 'AGENT_CIRCUIT_BREAKER_TRIPPED' as const;

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
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentBehaviourWindow.deleteMany({ where: t });
    await prisma.agentCircuitBreaker.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    // `Notification` and `TenantNotificationSettings` are in neither
    // `RESET_TABLES` nor its cascade closure (`Tenant` and `User` are not
    // roots there), and both hold a RESTRICT-by-default FK to `Tenant` —
    // `Notification` one to `User` as well. So they come out here, ahead of
    // the rows they point at, or the teardown fails on a foreign key and
    // every re-run starts on the previous run's bells.
    await prisma.notification.deleteMany({ where: t });
    await prisma.tenantNotificationSettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: ALL_TENANTS.flatMap(seedEmailHashes) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

/** Both of a tenant's seeded people — see `seedTenantWithAgent`. */
function seedEmailHashes(tenantId: string): string[] {
    return [`owner@${tenantId}.test`, `agent-owner@${tenantId}.test`].map(hashForLookup);
}

const seeded: Record<
    string,
    { agentId: string; aiSystemId: string; ownerUserId: string; agentOwnerUserId: string }
> = {};

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

/**
 * One tenant, one agent — and TWO people, which is the part that matters.
 *
 * `resolveAgenticRecipients` prefers the agent's own `ownerUserId` and falls
 * back to the workspace's ACTIVE OWNERs. When one person holds both roles the
 * two arms produce an identical recipient list, so every assertion about WHO
 * was told passes under either and proves nothing about which one ran. The
 * agent's owner is therefore an EDITOR here: a bell addressed to that user
 * could only have come from the accountable-owner arm.
 */
async function seedTenantWithAgent(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });

    const ownerEmail = `owner@${tenantId}.test`;
    const owner = await prisma.user.create({
        data: { email: ownerEmail, emailHash: hashForLookup(ownerEmail) },
    });
    await prisma.tenantMembership.create({
        data: {
            tenantId,
            userId: owner.id,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        },
    });

    const agentOwnerEmail = `agent-owner@${tenantId}.test`;
    const agentOwner = await prisma.user.create({
        data: { email: agentOwnerEmail, emailHash: hashForLookup(agentOwnerEmail) },
    });
    await prisma.tenantMembership.create({
        data: {
            tenantId,
            userId: agentOwner.id,
            // ACTIVE, because `createRegisteredAgent` refuses an owner who is
            // not an active member — but NOT an OWNER, because the fallback
            // arm selects those.
            role: Role.EDITOR,
            status: MembershipStatus.ACTIVE,
        },
    });

    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId, name: `Agent host ${tenantId}`, ownerUserId: owner.id },
    });
    seeded[tenantId] = {
        agentId: '',
        aiSystemId: aiSystem.id,
        ownerUserId: owner.id,
        agentOwnerUserId: agentOwner.id,
    };

    const created = await createRegisteredAgent(ctxFor(tenantId), {
        aiSystemId: aiSystem.id,
        name: `Ops agent ${tenantId}`,
        autonomyLevel: 3,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: agentOwner.id,
    });
    seeded[tenantId].agentId = created.id;

    // The latch, and an epoch old enough that the seeded history is inside
    // it. In production the epoch is stamped on the agent's first observed
    // call, so it always precedes its own ledger; a test that seeded the
    // past without moving it would silently discard every window and then
    // assert about an empty baseline.
    await openBreakerGate(tenantId, created.id);
    await prisma.agentCircuitBreaker.update({
        where: { tenantId_agentId: { tenantId, agentId: created.id } },
        data: { baselineEpoch: at(-100) },
    });
}

/**
 * The twelve read-only windows plus the propose window that ARMS, returning
 * the still-CLOSED latch the trip evaluation will be handed.
 *
 * It stops one step short of the trip deliberately: the race case has to
 * change the row BETWEEN this read and that evaluation, and that gap is the
 * race it reproduces.
 */
async function armForTrip(tenantId: string): Promise<BreakerLatch> {
    const agentId = seeded[tenantId].agentId;
    // Exactly the minimum baseline, at five calls each, so the observation
    // floor is met too.
    for (let i = 0; i < 12; i++) await seedWindow(tenantId, -30 + i, { read: 5 });
    await seedWindow(tenantId, -3, {
        read: 4,
        propose: 1,
        tools: ['agent.framework_status', 'agent.propose_risk'],
    });

    const first = await readBreakerLatch(tenantId, agentId);
    const armed = await evaluateWindow(tenantId, agentId, at(-2), first!);
    // Asserted rather than assumed: if this fixture stopped arming, every
    // "zero bells" below would still be green for the wrong reason.
    expect(armed.verdict?.code).toBe('ARMED');

    await seedWindow(tenantId, -2, { read: 3, propose: 2, tools: ['agent.propose_risk'] });
    const latch = await readBreakerLatch(tenantId, agentId);
    return latch!;
}

/** Every breaker bell a tenant holds, newest last. */
async function breakerBells(tenantId: string) {
    return prisma.notification.findMany({
        where: { tenantId, type: BREAKER_BELL },
        orderBy: { createdAt: 'asc' },
        select: { userId: true, title: true, message: true, linkUrl: true, dedupeKey: true },
    });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenantWithAgent(t);
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

        // No bell for a streak in progress (#2562). The notification is about
        // an agent having been STOPPED; ARMED changes no latch, so there is
        // nothing to tell anybody yet, and a bell here would spend the
        // recipient's attention on the case that resolves itself.
        expect(await breakerBells(T2)).toEqual([]);
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

    it('…and the trip rings exactly one bell, at the agent’s accountable owner', async () => {
        const bells = await breakerBells(T2);
        expect(bells).toHaveLength(1);
        const [bell] = bells;

        // The AGENT's owner — an EDITOR in this fixture, and NOT the tenant's
        // ACTIVE OWNER. Both halves are asserted: the equality alone would
        // hold if one user held both roles, which is the shape that made the
        // original fixture unable to fail.
        expect(bell.userId).toBe(seeded[T2].agentOwnerUserId);
        expect(bell.userId).not.toBe(seeded[T2].ownerUserId);

        // The firing signal is IN the row. A bell that only says "something
        // stopped" sends the reader to the page to find out what, which is
        // the trip back this exists to save.
        expect(bell.message).toContain('TOOL_MIX');

        // The agent's OWN page. The register carries no breaker column and
        // the breaker tab is local component state, so a link to the register
        // would land the recipient somewhere that says nothing about this.
        expect(bell.linkUrl).toBe(`/t/${T2}/agents/${seeded[T2].agentId}`);

        // Keyed on the AGENT and on the trip's own clock, not on an
        // independent one: the latch plus day-granular dedupe is what makes
        // this at most one bell per trip cycle.
        const day = at(-1).toISOString().slice(0, 10);
        expect(bell.dedupeKey).toBe(
            `${T2}:${BREAKER_BELL}:${seeded[T2].agentId}:${seeded[T2].agentOwnerUserId}:${day}`,
        );
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

describe('the bell follows the latch, not the verdict', () => {
    it('a trip that lost the race to a human close notifies nobody', async () => {
        const latch = await armForTrip(T3);
        const agentId = seeded[T3].agentId;

        // The race, made deterministic. The verdict below is computed from a
        // latch read a moment ago; the ROW has since been latched OPEN by
        // somebody else. `applyVerdict`'s UPDATE is conditional on
        // `state: 'CLOSED'` for exactly this reason, so it matches nothing.
        await prisma.agentCircuitBreaker.update({
            where: { tenantId_agentId: { tenantId: T3, agentId } },
            data: {
                state: 'OPEN',
                trippedAt: at(-6),
                trippedWindow: 'raced-by-a-human',
                trippedSignals: ['TOOL_MIX'],
            },
        });

        const outcome = await evaluateWindow(T3, agentId, at(-1), latch);
        // The verdict IS a trip — this is not a case where nothing happened,
        // which is the reading a bare "zero bells" would otherwise allow.
        expect(outcome.verdict?.code).toBe('TRIP');
        // But no latch flipped, and a bell announcing a stop this evaluation
        // did not cause is the wrong thing to send about a stop control.
        expect(await breakerBells(T3)).toEqual([]);

        // The row that was already there is untouched by the lost race.
        const after = await readBreakerLatch(T3, agentId);
        expect(after?.trippedAt).toEqual(at(-6));
    });

    it('…and the positive control: the same fixture, un-raced, rings once', async () => {
        const latch = await armForTrip(T4);
        const agentId = seeded[T4].agentId;

        const outcome = await evaluateWindow(T4, agentId, at(-1), latch);
        expect(outcome.verdict?.code).toBe('TRIP');

        // Without this the case above is indistinguishable from a bell that
        // is not wired at all: zero is what an unwired emitter reads as too.
        const bells = await breakerBells(T4);
        expect(bells.map((b) => b.userId)).toEqual([seeded[T4].agentOwnerUserId]);
    });

    it('a workspace that muted the type gets no row, though the latch still flips', async () => {
        await prisma.tenantNotificationSettings.create({
            data: {
                tenantId: T5,
                // TRUE deliberately. `enabled` is the EMAIL switch; if the
                // emitter's guard were wired to it rather than to the mute
                // list, this case would still see a bell and say so.
                enabled: true,
                defaultFromEmail: `noreply@${T5}.test`,
                mutedInAppTypes: [BREAKER_BELL],
            },
        });

        const latch = await armForTrip(T5);
        const agentId = seeded[T5].agentId;

        const outcome = await evaluateWindow(T5, agentId, at(-1), latch);
        expect(outcome.verdict?.code).toBe('TRIP');
        expect(await breakerBells(T5)).toEqual([]);

        // The paired half, and the only thing that makes the zero above mean
        // SUPPRESSED rather than never-reached: the trip itself landed. Zero
        // is equally what this would read if the evaluation had thrown on the
        // way in, or if the agent had never resolved.
        const after = await readBreakerLatch(T5, agentId);
        expect(after?.state).toBe('OPEN');
        expect(after?.trippedSignals).toEqual(['TOOL_MIX']);
    });
});
