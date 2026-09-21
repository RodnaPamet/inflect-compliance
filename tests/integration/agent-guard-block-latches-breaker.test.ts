/**
 * Repeated guard blocks latch the EXISTING circuit breaker.
 *
 * ── WHY THIS IS THE MISSING HALF OF THE GUARD ───────────────────────────────
 *
 * The output guard quarantines a proposal carrying injected content, and a bell
 * tells a human. Nothing stopped the AGENT. So an agent producing injected
 * content went on producing it, one quarantined row at a time, while the
 * evidence accumulated on a triage page with no inbound traffic.
 *
 * An OPEN breaker is refused at `assertCircuitBreakerClosed` in
 * `src/lib/mcp/authorize.ts` — the gate every MCP tool call already passes
 * through — so latching it is what turns "we noticed" into "it stopped".
 *
 * ── THE TWO WAYS THIS COULD BE WRONG, AND BOTH ARE TESTED ───────────────────
 *
 *   · TOO EAGER. One quarantine is the guard WORKING. Stopping the agent on
 *     the first one makes every successful defence an outage, which is how a
 *     control ends up switched off. So the sub-threshold case is asserted as
 *     hard as the threshold case.
 *   · TOO BROAD. The count must be this agent's, this tenant's, and this
 *     window's. Each of those is one wrong clause away from stopping an agent
 *     for somebody else's blocks.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { latchOnGuardBlock, openBreakerGate } from '@/lib/agentic/circuit-breaker-store';
import { GUARD_BLOCK_TRIP_THRESHOLD } from '@/lib/agentic/circuit-breaker';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const T1 = 'gbl-tenant-one';
const T2 = 'gbl-tenant-two';

/** Mid-window, so "an hour earlier" is reliably the previous window. */
const NOW = new Date('2026-09-21T12:30:00.000Z');
const LAST_WINDOW = new Date('2026-09-21T11:00:00.000Z');

/**
 * Real agents, because `AgentCircuitBreaker` and `AgentProposal` both carry a
 * composite FK to `RegisteredAgent` — a breaker row cannot exist for an agent
 * the register never issued, which is the invariant that makes the latch
 * meaningful in the first place.
 */
const seeded: Record<string, { ownerUserId: string; agentId: string; otherAgentId: string }> = {};

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

/**
 * Drop everything this suite seeded for one tenant.
 *
 * The membership delete needs `session_replication_role = 'replica'`, and that
 * is not a convenience: `seedTenant` creates an ACTIVE OWNER deliberately, and
 * the `tenant_membership_last_owner_guard` trigger raises P0001 on any DELETE
 * that would leave a tenant with zero active OWNERs — which the last one always
 * does. `SET LOCAL` keeps the bypass inside this transaction so it cannot leak
 * to a parallel jest worker.
 *
 * The owner USER is dropped too. `User.email` is unique and `seedTenant` calls
 * `create`, so a leaked row makes the second run against the same database fail
 * on a duplicate key rather than on anything this suite is about.
 */
async function purgeTenant(tenantId: string): Promise<void> {
    await prisma.agentProposal.deleteMany({ where: { tenantId } });
    await prisma.agentCircuitBreaker.deleteMany({ where: { tenantId } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId } });
    await prisma.aiSystem.deleteMany({ where: { tenantId } });
    // `notifyBreakerTrip` fans a row out per admin. Enumerated by querying
    // every table with a `tenantId` column for rows belonging to these two
    // tenants rather than by peeling one FK error at a time: AiSystem,
    // AuditLog, Notification, RegisteredAgent, TenantMembership (plus the two
    // agentic tables `beforeEach` already clears) is the complete set.
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
            tenantId,
        );
    });
    // `createRegisteredAgent` writes hash-chained audit rows, and
    // `AuditLog_tenantId_fkey` makes them block the tenant delete. The rows are
    // immutable by trigger, so the shared helper is the only way to drop them.
    await deleteAuditRowsForTenants(prisma, tenantId);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.user.deleteMany({ where: { email: `owner-${tenantId}@example.test` } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });

    const email = `owner-${tenantId}@example.test`;
    const owner = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    await prisma.tenantMembership.create({
        data: {
            tenantId,
            userId: owner.id,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        },
    });
    seeded[tenantId] = { ownerUserId: owner.id, agentId: '', otherAgentId: '' };

    for (const key of ['agentId', 'otherAgentId'] as const) {
        // ONE AiSystem PER AGENT: `RegisteredAgent.aiSystemId` is UNIQUE, so
        // two agents cannot share a host row.
        const host = await prisma.aiSystem.create({
            data: { tenantId, name: `${key} host ${tenantId}`, ownerUserId: owner.id },
        });
        const agent = await createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: host.id,
            name: `${key} ${tenantId}`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: owner.id,
        });
        seeded[tenantId][key] = agent.id;
    }
}

let seq = 0;
async function quarantined(tenantId: string, agentId: string, at: Date) {
    seq += 1;
    await prisma.agentProposal.create({
        data: {
            id: `gbl-p-${seq}`,
            tenantId,
            agentId,
            kind: 'RISK',
            payloadJson: '{}',
            status: 'QUARANTINED',
            guardVerdict: 'QUARANTINED',
            createdAt: at,
        },
    });
}

/** A CLEAN proposal — the guard let it through; it must not count. */
async function clean(tenantId: string, agentId: string, at: Date) {
    seq += 1;
    await prisma.agentProposal.create({
        data: {
            id: `gbl-p-${seq}`,
            tenantId,
            agentId,
            kind: 'RISK',
            payloadJson: '{}',
            status: 'PENDING',
            guardVerdict: 'CLEAN',
            createdAt: at,
        },
    });
}

const breakerState = async (tenantId: string, agentId: string) =>
    (await prisma.agentCircuitBreaker.findFirst({
        where: { tenantId, agentId },
        select: { state: true, trippedSignals: true },
    })) ?? null;

/**
 * The latch row, created the way production creates it.
 *
 * An OPEN row must carry its BASIS: the database CHECK
 * `AgentCircuitBreaker_open_has_basis` requires `trippedAt`, `trippedWindow`
 * and at least one `trippedSignals` entry whenever the state is OPEN. A stop
 * that cannot say why it stopped is not storable — which is the same reason
 * `latchOnGuardBlock` writes all three rather than just flipping the state.
 */
async function seedBreaker(tenantId: string, agentId: string, state = 'CLOSED') {
    await openBreakerGate(tenantId, agentId);
    if (state !== 'CLOSED') {
        await prisma.agentCircuitBreaker.updateMany({
            where: { tenantId, agentId },
            data: {
                state,
                trippedAt: LAST_WINDOW,
                trippedWindow: '2026-09-21T11',
                trippedSignals: ['PROPOSAL_RATE'],
            },
        });
    }
}

describeFn('guard blocks latch the breaker, at the right threshold', () => {
    beforeAll(async () => {
        for (const t of [T1, T2]) {
            await purgeTenant(t);
            await seedTenant(t);
        }
    });

    beforeEach(async () => {
        for (const t of [T1, T2]) {
            await prisma.agentProposal.deleteMany({ where: { tenantId: t } });
            await prisma.agentCircuitBreaker.deleteMany({ where: { tenantId: t } });
        }
    });

    afterAll(async () => {
        if (T1 && T2) {
            for (const t of [T1, T2]) {
                await purgeTenant(t);
            }
        }
        await prisma.$disconnect();
    });

    it('does NOT latch below the threshold — a caught attack is the guard working', async () => {
        // The assertion that keeps this control switched on. If one quarantine
        // stopped the agent, every successful defence would be an outage.
        await seedBreaker(T1, seeded[T1].agentId);
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD - 1; i++) {
            await quarantined(T1, seeded[T1].agentId, NOW);
        }

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out).toEqual({ blocksInWindow: GUARD_BLOCK_TRIP_THRESHOLD - 1, latched: false });
        expect((await breakerState(T1, seeded[T1].agentId))?.state).toBe('CLOSED');
    });

    it('latches AT the threshold, naming GUARD_BLOCK as the reason', async () => {
        await seedBreaker(T1, seeded[T1].agentId);
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD; i++) {
            await quarantined(T1, seeded[T1].agentId, NOW);
        }

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out).toEqual({ blocksInWindow: GUARD_BLOCK_TRIP_THRESHOLD, latched: true });
        expect(await breakerState(T1, seeded[T1].agentId)).toEqual({
            state: 'OPEN',
            // Named so an operator reading the stop knows it was the guard and
            // not a behavioural signal — different evidence, different response.
            trippedSignals: ['GUARD_BLOCK'],
        });
    });

    it('counts only QUARANTINED proposals, not clean ones', async () => {
        await seedBreaker(T1, seeded[T1].agentId);
        await quarantined(T1, seeded[T1].agentId, NOW);
        for (let i = 0; i < 10; i++) await clean(T1, seeded[T1].agentId, NOW);

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out).toEqual({ blocksInWindow: 1, latched: false });
    });

    it('counts only THIS window — an agent does not accrue blocks for ever', async () => {
        // A lifetime total would stop an agent that tripped the guard once a
        // month for a year, which has not earned a stop.
        await seedBreaker(T1, seeded[T1].agentId);
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD; i++) {
            await quarantined(T1, seeded[T1].agentId, LAST_WINDOW);
        }
        await quarantined(T1, seeded[T1].agentId, NOW);

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out).toEqual({ blocksInWindow: 1, latched: false });
        expect((await breakerState(T1, seeded[T1].agentId))?.state).toBe('CLOSED');
    });

    it('counts only THIS agent', async () => {
        await seedBreaker(T1, seeded[T1].agentId);
        await seedBreaker(T1, seeded[T1].otherAgentId);
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD; i++) {
            await quarantined(T1, seeded[T1].otherAgentId, NOW);
        }

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out.blocksInWindow).toBe(0);
        expect({
            mine: (await breakerState(T1, seeded[T1].agentId))?.state,
            theirs: (await breakerState(T1, seeded[T1].otherAgentId))?.state,
        }).toEqual({ mine: 'CLOSED', theirs: 'CLOSED' });
    });

    it('counts only THIS tenant', async () => {
        await seedBreaker(T1, seeded[T1].agentId);
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD; i++) {
            await quarantined(T2, seeded[T2].agentId, NOW);
        }

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out.blocksInWindow).toBe(0);
        expect((await breakerState(T1, seeded[T1].agentId))?.state).toBe('CLOSED');
    });

    it('does not re-latch an already OPEN breaker', async () => {
        // The write is conditional on CLOSED, exactly as `evaluateWindow`'s is.
        // Re-latching would move `trippedAt` forward and overwrite the signals
        // that actually stopped the agent with whatever stopped it last.
        await seedBreaker(T1, seeded[T1].agentId, 'OPEN');
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD; i++) {
            await quarantined(T1, seeded[T1].agentId, NOW);
        }

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out).toEqual({ blocksInWindow: GUARD_BLOCK_TRIP_THRESHOLD, latched: false });
    });

    it('is a no-op, not a crash, when the agent has no breaker row', async () => {
        // The latch row is created by `openBreakerGate` on an agent's first
        // tool call. An agent that has only ever proposed may not have one, and
        // that must not throw on a path that runs after a row is written.
        for (let i = 0; i < GUARD_BLOCK_TRIP_THRESHOLD; i++) {
            await quarantined(T1, seeded[T1].agentId, NOW);
        }

        const out = await latchOnGuardBlock(T1, seeded[T1].agentId, NOW);

        expect(out).toEqual({ blocksInWindow: GUARD_BLOCK_TRIP_THRESHOLD, latched: false });
    });
});
