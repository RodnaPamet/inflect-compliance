/**
 * The agent behaviour fingerprint, end to end against a real database
 * (Morpheus roadmap Phase 1, sub-phase 1.4).
 *
 * A month of ordinary ledger activity is seeded for one agent in each of two
 * tenants, and the nightly pass is walked day by day exactly as the schedule
 * would run it. Then one tenant's agent triples its reads. Each claim below is
 * the invariant it is named for:
 *
 *   - the seeded anomaly raises a finding AND latches the existing breaker
 *     with BEHAVIOUR_ANOMALY; none of the 30 baseline days is flagged;
 *   - the other tenant, with the same history and no anomaly, gets nothing,
 *     and cannot read the first tenant's rows (RLS, as app_user);
 *   - a second run of the same night writes nothing;
 *   - without the operator's keys nothing is read or written (G9), and
 *     without the latch key threshold B raises the finding and stops nothing.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { runAgentBehaviourFingerprint } from '@/app-layer/usecases/agent-behaviour-fingerprint';
import { runAgentFingerprintSweep } from '@/app-layer/jobs/agent-fingerprint';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { buildSystemContext } from '@/app-layer/context-system';
import { runInTenantContext } from '@/lib/db-context';
import {
    BEHAVIOUR_ANOMALY_FINDING_SOURCE_KIND,
    behaviourAnomalySourceRef,
    BASELINE_MIN_DAYS,
} from '@/lib/agentic/behaviour-fingerprint';
import { BEHAVIOUR_ANOMALY_TRIP } from '@/lib/agentic/circuit-breaker';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const T1 = 'abf-tenant-one';
const T2 = 'abf-tenant-two';
const DAY_MS = 86_400_000;
/** Day 0 of the seeded month, UTC midnight. */
const DAY0 = Date.UTC(2026, 8, 1);
const BASELINE_DAYS = 30;
/** The run that scores day `i` happens at 01:53 the next day. */
const runAt = (i: number) => new Date(DAY0 + (i + 1) * DAY_MS + (1 * 60 + 53) * 60_000);

const seeded: Record<string, { ownerUserId: string; agentId: string }> = {};

async function purgeTenant(tenantId: string): Promise<void> {
    await prisma.agentBehaviourAnomaly.deleteMany({ where: { tenantId } });
    await prisma.agentBehaviourBaseline.deleteMany({ where: { tenantId } });
    await prisma.agentBehaviourWindow.deleteMany({ where: { tenantId } });
    await prisma.agentCircuitBreaker.deleteMany({ where: { tenantId } });
    await prisma.finding.deleteMany({ where: { tenantId } });
    await prisma.integrationExecution.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId } });
    await prisma.aiSystem.deleteMany({ where: { tenantId } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
    });
    await deleteAuditRowsForTenants(prisma, tenantId);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.user.deleteMany({ where: { email: `owner-${tenantId}@example.test` } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const email = `owner-${tenantId}@example.test`;
    const owner = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: owner.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const host = await prisma.aiSystem.create({ data: { tenantId, name: `host ${tenantId}`, ownerUserId: owner.id } });
    const ctx = makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: owner.id });
    const agent = await createRegisteredAgent(ctx, {
        aiSystemId: host.id,
        name: `agent ${tenantId}`,
        autonomyLevel: 3,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: owner.id,
    });
    seeded[tenantId] = { ownerUserId: owner.id, agentId: agent.id };
}

/** Deterministic daily reads around 120, spread over 8 active hours. */
function readsOn(i: number): number {
    return 120 + (((i * 37) % 51) - 25);
}

async function seedDay(tenantId: string, i: number, reads: number): Promise<void> {
    const perHour = Math.floor(reads / 8);
    await prisma.agentBehaviourWindow.createMany({
        data: Array.from({ length: 8 }, (_, h) => ({
            tenantId,
            agentId: seeded[tenantId].agentId,
            windowStart: new Date(DAY0 + i * DAY_MS + (9 + h) * 3_600_000),
            readCalls: h === 7 ? reads - perHour * 7 : perHour,
            proposeCalls: 1,
        })),
    });
}

const keysOn = (latch: boolean) => ({ detector: '1', tenants: `${T1},${T2}`, latch: latch ? '1' : undefined });

describeFn('the agent behaviour fingerprint', () => {
    beforeAll(async () => {
        for (const t of [T1, T2]) {
            await purgeTenant(t);
            await seedTenant(t);
            for (let i = 0; i < BASELINE_DAYS; i++) await seedDay(t, i, readsOn(i));
        }
        // T1's agent triples its reads on day 30; T2's carries on as before.
        await seedDay(T1, BASELINE_DAYS, readsOn(BASELINE_DAYS) * 3);
        await seedDay(T2, BASELINE_DAYS, readsOn(BASELINE_DAYS));
    });

    afterAll(async () => {
        for (const t of [T1, T2]) await purgeTenant(t);
        await prisma.$disconnect();
    });

    it('is off without the operator keys: nothing is read or written', async () => {
        const r = await runAgentFingerprintSweep({}, 'abf-off', { detector: undefined, tenants: `${T1},${T2}`, latch: '1' }, runAt(0));
        expect(r).toEqual({ disabled: true, tenants: 0, results: [] });
        const r2 = await runAgentFingerprintSweep({ tenantId: T1 }, 'abf-off2', { detector: '1', tenants: T2, latch: '1' }, runAt(0));
        expect(r2.disabled).toBe(true);
        expect(await prisma.agentBehaviourBaseline.count({ where: { tenantId: { in: [T1, T2] } } })).toBe(0);
        expect(await prisma.integrationExecution.count({ where: { tenantId: { in: [T1, T2] } } })).toBe(0);
    });

    it('learns the baseline without flagging a single baseline day', async () => {
        for (let i = 0; i < BASELINE_DAYS; i++) {
            const sweep = await runAgentFingerprintSweep({}, `abf-${i}`, keysOn(true), runAt(i));
            expect(sweep.tenants).toBe(2);
            for (const res of sweep.results) expect(res.status).toBe('PASSED');
        }
        for (const t of [T1, T2]) {
            const rows = await prisma.agentBehaviourBaseline.findMany({
                where: { tenantId: t },
                select: { verdict: true, inBaseline: true },
                orderBy: { day: 'asc' },
            });
            expect(rows).toHaveLength(BASELINE_DAYS);
            expect(rows.filter((r) => r.verdict === 'LEARNING')).toHaveLength(BASELINE_MIN_DAYS);
            expect(rows.filter((r) => r.verdict === 'ANOMALOUS')).toEqual([]);
            expect(rows.every((r) => r.inBaseline)).toBe(true);
        }
        expect(await prisma.finding.count({ where: { tenantId: { in: [T1, T2] } } })).toBe(0);
    });

    it('the seeded anomaly raises a finding and latches the existing breaker; the other tenant gets nothing', async () => {
        const sweep = await runAgentFingerprintSweep({}, 'abf-anomaly', keysOn(true), runAt(BASELINE_DAYS));
        const byTenant = new Map(sweep.results.map((r) => [r.tenantId, r]));

        const one = byTenant.get(T1)!;
        expect(one.anomalous).toBe(1);
        expect(one.latched).toBe(1);
        expect(one.agents[0]).toMatchObject({ verdict: 'ANOMALOUS', tier: 'LATCH', findingAction: 'OPENED', latched: true });

        const anomaly = await prisma.agentBehaviourAnomaly.findFirst({ where: { tenantId: T1 } });
        expect(anomaly?.tier).toBe('LATCH');
        expect(anomaly?.latchedAt).not.toBeNull();
        const drivers = anomaly?.driversJson as { feature: string }[];
        expect(drivers.map((d) => d.feature)).toEqual(['readCalls']);

        const finding = await prisma.finding.findFirst({
            where: { tenantId: T1, sourceKind: BEHAVIOUR_ANOMALY_FINDING_SOURCE_KIND },
            select: { id: true, sourceRef: true, status: true, assigneeUserId: true },
        });
        expect(finding).toMatchObject({
            sourceRef: behaviourAnomalySourceRef(seeded[T1].agentId),
            status: 'OPEN',
            assigneeUserId: seeded[T1].ownerUserId,
        });
        expect(anomaly?.findingId).toBe(finding?.id);

        const breaker = await prisma.agentCircuitBreaker.findFirst({ where: { tenantId: T1, agentId: seeded[T1].agentId } });
        expect(breaker?.state).toBe('OPEN');
        expect(breaker?.trippedSignals).toEqual([BEHAVIOUR_ANOMALY_TRIP]);

        // The other tenant: same history, no anomaly — and nothing of T1's.
        const two = byTenant.get(T2)!;
        expect(two).toMatchObject({ anomalous: 0, latched: 0, steady: 1 });
        expect(await prisma.finding.count({ where: { tenantId: T2 } })).toBe(0);
        expect(await prisma.agentBehaviourAnomaly.count({ where: { tenantId: T2 } })).toBe(0);
        expect(await prisma.agentCircuitBreaker.count({ where: { tenantId: T2, state: 'OPEN' } })).toBe(0);
    });

    it('RLS: one tenant cannot read the other tenant\'s fingerprint rows', async () => {
        const ctx2 = buildSystemContext({ tenantId: T2, job: 'abf-rls' });
        const seen = await runInTenantContext(ctx2, async (db) => ({
            baselines: await db.agentBehaviourBaseline.count({ where: { tenantId: T1 } }),
            anomalies: await db.agentBehaviourAnomaly.count({ where: { tenantId: T1 } }),
            own: await db.agentBehaviourBaseline.count({ where: { tenantId: T2 } }),
        }));
        expect(seen).toEqual({ baselines: 0, anomalies: 0, own: BASELINE_DAYS + 1 });
    });

    it('a second run of the same night writes nothing', async () => {
        const before = {
            baselines: await prisma.agentBehaviourBaseline.count({ where: { tenantId: T1 } }),
            anomalies: await prisma.agentBehaviourAnomaly.count({ where: { tenantId: T1 } }),
            findings: await prisma.finding.count({ where: { tenantId: T1 } }),
        };
        const again = await runAgentBehaviourFingerprint({ tenantId: T1, tenantSlug: T1, latch: true, now: runAt(BASELINE_DAYS) });
        expect(again).toMatchObject({ status: 'PASSED', evaluated: 0, alreadyScored: 1, anomalous: 0, latched: 0 });
        expect({
            baselines: await prisma.agentBehaviourBaseline.count({ where: { tenantId: T1 } }),
            anomalies: await prisma.agentBehaviourAnomaly.count({ where: { tenantId: T1 } }),
            findings: await prisma.finding.count({ where: { tenantId: T1 } }),
        }).toEqual(before);
    });

    it('without the latch key, threshold B raises the finding and stops nothing', async () => {
        // A fresh anomalous day for T2's agent, scored with the latch key off.
        await seedDay(T2, BASELINE_DAYS + 1, readsOn(BASELINE_DAYS + 1) * 3);
        const r = await runAgentBehaviourFingerprint({ tenantId: T2, tenantSlug: T2, latch: false, now: runAt(BASELINE_DAYS + 1) });
        expect(r.agents[0]).toMatchObject({ verdict: 'ANOMALOUS', tier: 'LATCH', findingAction: 'OPENED', latched: false });
        expect(await prisma.agentCircuitBreaker.count({ where: { tenantId: T2, state: 'OPEN' } })).toBe(0);
        const anomaly = await prisma.agentBehaviourAnomaly.findFirst({ where: { tenantId: T2 } });
        expect(anomaly?.latchedAt).toBeNull();
    });

    it('a day with no activity is not a sample: NOT_APPLICABLE, never PASSED', async () => {
        const r = await runAgentBehaviourFingerprint({ tenantId: T1, tenantSlug: T1, latch: true, now: runAt(BASELINE_DAYS + 5) });
        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_ACTIVITY', evaluated: 0 });
    });
});
