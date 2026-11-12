/**
 * The behaviour fingerprint's human side, against a real database (Morpheus
 * roadmap 1.3): the read the Overview card and the reports view render, and a
 * person's acceptance of a changed behaviour as the agent's new normal.
 *
 * The case 1.3 closes: an anomaly that did NOT latch (here the operator's latch
 * key is off, the default once the detector is on). Before this, the only
 * re-baseline was closing an OPEN breaker `ACCEPTED_NEW_BASELINE`, so a
 * deliberate step change at that tier was re-scored ANOMALOUS every night with
 * nothing a person could do but switch the detector off. Each claim below is
 * the invariant it is named for.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { runAgentBehaviourFingerprint } from '@/app-layer/usecases/agent-behaviour-fingerprint';
import {
    acceptAgentBehaviourBaseline,
    getAgentBehaviourFingerprint,
    listAgentBehaviourAnomalies,
} from '@/app-layer/usecases/agent-behaviour-fingerprint-read';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { openBreakerGate, latchOnBehaviourAnomaly } from '@/lib/agentic/circuit-breaker-store';
import { closeAgentCircuitBreaker } from '@/app-layer/usecases/agent-circuit-breaker';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const T1 = 'abfs-tenant-one';
const T2 = 'abfs-tenant-two';
const DAY_MS = 86_400_000;
const DAY0 = Date.UTC(2026, 8, 1);
const BASELINE_DAYS = 20;
const runAt = (i: number) => new Date(DAY0 + (i + 1) * DAY_MS + (1 * 60 + 53) * 60_000);

const seeded: Record<string, { ownerUserId: string; agentId: string }> = {};
const ENV_KEYS = ['AGENT_BEHAVIOUR_DETECTOR', 'AGENT_BEHAVIOUR_DETECTOR_TENANTS', 'AGENT_BEHAVIOUR_DETECTOR_LATCH'] as const;
const savedEnv: Record<string, string | undefined> = {};

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
    // The breaker row, through the funnel's own seam — every agent that makes
    // a funnel call has one.
    await openBreakerGate(tenantId, agent.id);
}

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

/** Score day `i` for a tenant with the latch key OFF. */
const score = (tenantId: string, i: number) =>
    runAgentBehaviourFingerprint({ tenantId, tenantSlug: tenantId, latch: false, now: runAt(i) });

const ownerOf = (tenantId: string) =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

describeFn('the behaviour fingerprint surface and the accepted baseline', () => {
    beforeAll(async () => {
        for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
        process.env.AGENT_BEHAVIOUR_DETECTOR = '1';
        process.env.AGENT_BEHAVIOUR_DETECTOR_TENANTS = `${T1},${T2}`;
        delete process.env.AGENT_BEHAVIOUR_DETECTOR_LATCH;
        for (const t of [T1, T2]) {
            await purgeTenant(t);
            await seedTenant(t);
            for (let i = 0; i < BASELINE_DAYS; i++) await seedDay(t, i, readsOn(i));
            for (let i = 0; i < BASELINE_DAYS; i++) await score(t, i);
        }
        // T1's owner deliberately triples the agent's workload from day 20.
        await seedDay(T1, BASELINE_DAYS, readsOn(BASELINE_DAYS) * 3);
        await score(T1, BASELINE_DAYS);
    });

    afterAll(async () => {
        for (const t of [T1, T2]) await purgeTenant(t);
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        await prisma.$disconnect();
    });

    it('the read carries the anomaly, the features that drove it, and the detector state', async () => {
        const view = await getAgentBehaviourFingerprint(ownerOf(T1), seeded[T1].agentId);
        expect(view.detector).toEqual({ on: true, basis: 'ON', latch: false });
        expect(view.lastScoredDay).toBe('2026-09-21');
        expect(view.days[0]).toMatchObject({ day: '2026-09-21', verdict: 'ANOMALOUS', inBaseline: false });
        expect(view.anomalies).toHaveLength(1);
        expect(view.anomalies[0]).toMatchObject({ day: '2026-09-21', tier: 'LATCH', latchedAt: null });
        expect(view.anomalies[0].drivers.map((d) => d.feature)).toEqual(['readCalls']);
        expect(view.anomalies[0].drivers[0].observed).toBe(readsOn(BASELINE_DAYS) * 3);
        expect(view.acceptBaseline).toEqual({ allowed: true, refusal: null });
    });

    it('the tenant view lists only its own tenant\'s anomalies, named', async () => {
        const one = await listAgentBehaviourAnomalies(ownerOf(T1), runAt(BASELINE_DAYS));
        expect(one.anomalies.map((a) => [a.agentId, a.agentName])).toEqual([[seeded[T1].agentId, `agent ${T1}`]]);
        expect(one.truncated).toBe(false);
        const two = await listAgentBehaviourAnomalies(ownerOf(T2), runAt(BASELINE_DAYS));
        expect(two.anomalies).toEqual([]);
        expect(two.lastScoredDay).toBe('2026-09-20');
    });

    it('another tenant cannot read this agent\'s fingerprint, nor accept for it', async () => {
        await expect(getAgentBehaviourFingerprint(ownerOf(T2), seeded[T1].agentId)).rejects.toThrow(/not found/i);
        await expect(acceptAgentBehaviourBaseline(ownerOf(T2), seeded[T1].agentId)).rejects.toThrow(/not found/i);
    });

    it('a reader without the register key is refused the read', async () => {
        const reader = makeRequestContext('READER', { tenantId: T1, tenantSlug: T1 });
        await expect(getAgentBehaviourFingerprint(reader, seeded[T1].agentId)).rejects.toThrow(/permission/i);
        await expect(listAgentBehaviourAnomalies(reader)).rejects.toThrow(/permission/i);
    });

    it('an API key or an agent cannot declare the behaviour normal', async () => {
        const viaKey = makeRequestContext('OWNER', { tenantId: T1, tenantSlug: T1, apiKeyId: 'key-1' });
        const viaAgent = makeRequestContext('OWNER', { tenantId: T1, tenantSlug: T1, agentId: seeded[T1].agentId });
        for (const c of [viaKey, viaAgent]) {
            await expect(acceptAgentBehaviourBaseline(c, seeded[T1].agentId)).rejects.toMatchObject({
                status: 403,
                details: { reason: 'NOT_A_PERSON' },
            });
            const view = await getAgentBehaviourFingerprint(c, seeded[T1].agentId);
            expect(view.acceptBaseline).toEqual({ allowed: false, refusal: 'NOT_A_PERSON' });
        }
    });

    it('without an acceptance, the intended change is re-scored anomalous the next night (the gap 1.3 closes)', async () => {
        await seedDay(T1, BASELINE_DAYS + 1, readsOn(BASELINE_DAYS + 1) * 3);
        const r = await score(T1, BASELINE_DAYS + 1);
        expect(r.agents[0]).toMatchObject({ verdict: 'ANOMALOUS', latched: false });
        // Nothing latched, so the breaker close — the only re-baseline before
        // 1.3 — is not available: it refuses a breaker that is not open.
        await expect(closeAgentCircuitBreaker(ownerOf(T1), seeded[T1].agentId, 'ACCEPTED_NEW_BASELINE')).rejects.toThrow(
            /not open/i,
        );
    });

    it('a person accepts the new normal: the breaker epoch moves, it is audited, and the next night re-learns', async () => {
        const agentId = seeded[T1].agentId;
        const before = await prisma.agentCircuitBreaker.findFirstOrThrow({ where: { tenantId: T1, agentId } });
        const res = await acceptAgentBehaviourBaseline(ownerOf(T1), agentId);
        const after = await prisma.agentCircuitBreaker.findFirstOrThrow({ where: { tenantId: T1, agentId } });
        expect(after.state).toBe('CLOSED');
        expect(after.baselineEpoch.getTime()).toBeGreaterThan(before.baselineEpoch.getTime());
        expect(after.baselineEpoch.toISOString()).toBe(res.baselineEpoch);
        // Nothing about a close was invented: no closer, no close reason.
        expect(after.closedByUserId).toBe(before.closedByUserId);
        expect(after.closeReason).toBe(before.closeReason);

        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: T1, action: 'AGENT_BEHAVIOUR_BASELINE_ACCEPTED', entityId: agentId },
            select: { userId: true },
        });
        expect(audit?.userId).toBe(seeded[T1].ownerUserId);

        await seedDay(T1, BASELINE_DAYS + 2, readsOn(BASELINE_DAYS + 2) * 3);
        const r = await score(T1, BASELINE_DAYS + 2);
        expect(r.agents[0]).toMatchObject({ verdict: 'LEARNING', baselineDays: 0, findingAction: null });

        const view = await getAgentBehaviourFingerprint(ownerOf(T1), agentId);
        expect(view.baselineEpoch).toBe(res.baselineEpoch);
        expect(view.acceptBaseline).toEqual({ allowed: false, refusal: 'NOTHING_TO_ACCEPT' });
    });

    it('with nothing new to accept, a second acceptance is refused and writes nothing', async () => {
        const agentId = seeded[T1].agentId;
        const before = await prisma.agentCircuitBreaker.findFirstOrThrow({ where: { tenantId: T1, agentId } });
        await expect(acceptAgentBehaviourBaseline(ownerOf(T1), agentId)).rejects.toMatchObject({
            status: 409,
            details: { reason: 'NOTHING_TO_ACCEPT' },
        });
        const after = await prisma.agentCircuitBreaker.findFirstOrThrow({ where: { tenantId: T1, agentId } });
        expect(after.baselineEpoch).toEqual(before.baselineEpoch);
        // An agent that has never been anomalous has nothing to accept either.
        await expect(acceptAgentBehaviourBaseline(ownerOf(T2), seeded[T2].agentId)).rejects.toMatchObject({
            details: { reason: 'NOTHING_TO_ACCEPT' },
        });
    });

    it('an OPEN breaker is decided by its close, never by the acceptance', async () => {
        const agentId = seeded[T2].agentId;
        await seedDay(T2, BASELINE_DAYS, readsOn(BASELINE_DAYS) * 3);
        await score(T2, BASELINE_DAYS);
        const { latched } = await latchOnBehaviourAnomaly(T2, agentId, new Date());
        expect(latched).toBe(true);
        const before = await prisma.agentCircuitBreaker.findFirstOrThrow({ where: { tenantId: T2, agentId } });
        expect(before.state).toBe('OPEN');

        const view = await getAgentBehaviourFingerprint(ownerOf(T2), agentId);
        expect(view.acceptBaseline).toEqual({ allowed: false, refusal: 'BREAKER_OPEN' });
        await expect(acceptAgentBehaviourBaseline(ownerOf(T2), agentId)).rejects.toMatchObject({
            status: 409,
            details: { reason: 'BREAKER_OPEN' },
        });
        const after = await prisma.agentCircuitBreaker.findFirstOrThrow({ where: { tenantId: T2, agentId } });
        expect(after.baselineEpoch).toEqual(before.baselineEpoch);
        expect(after.state).toBe('OPEN');
    });

    it('with the detector off for the workspace, the read says so rather than reporting a steady agent', async () => {
        process.env.AGENT_BEHAVIOUR_DETECTOR_TENANTS = T2;
        try {
            const view = await getAgentBehaviourFingerprint(ownerOf(T1), seeded[T1].agentId);
            expect(view.detector).toEqual({ on: false, basis: 'TENANT_NOT_NAMED', latch: false });
        } finally {
            process.env.AGENT_BEHAVIOUR_DETECTOR_TENANTS = `${T1},${T2}`;
        }
    });
});
