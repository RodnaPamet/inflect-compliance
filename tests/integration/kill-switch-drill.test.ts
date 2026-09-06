/**
 * THE DRILL — the scheduled proof that the kill switch still stops an agent, and
 * the Finding it raises when it does not.
 *
 * An untested stop control is an assumption. Every other signal this subsystem
 * emits fires when a control ACTS; a stop control that has quietly stopped
 * working emits nothing and looks exactly like a quiet week. So the drill has to
 * be REAL — it engages a committed kill and drives the actual gate — and its
 * record has to be legible as evidence rather than as a log line, because
 * Agentic 10/10 reads it as evidence.
 *
 * ## What is faked here, and what is deliberately not
 *
 * Only `resolveKillState` is overridable, and only to SIMULATE A BROKEN
 * BOUNDARY. Everything else is real: the real `AgentKillSwitch` write, the real
 * transaction rollback, the real `Evidence` / `Finding` / `FindingEvidence`
 * chain, the real RLS.
 *
 * That the tool GATE calls `resolveKillState`, and calls it first, is a
 * different claim and is asserted in `agent-kill-switch.test.ts` against the
 * real MCP funnel. It is not asserted here because the drill cannot make it —
 * see `probeBoundaryDecision`'s docstring for why a job module may not import
 * the gate.
 *
 * The override is the only way to test the FAILING half at all, and it is
 * pointed at the exact function whose removal is the regression the drill
 * exists for. A drill that could only be observed passing would be a drill
 * nobody could show works.
 *
 * ## Three outcomes, and the reason `ERROR` is not `FAILED`
 *
 * `FAILED` means a kill was in force and the boundary let a call through, or
 * refused it for the wrong reason. `ERROR` means the drill could not run, which
 * proves nothing either way. Only FAILED raises a Finding — reporting an ERROR
 * as "the control is broken" would raise a CRITICAL Finding about a database
 * timeout and teach people to close them in bulk.
 */
const mockKillState: { impl: null | ((...args: unknown[]) => Promise<unknown>) } = { impl: null };
jest.mock('@/lib/agentic/kill-switch', () => {
    const actual = jest.requireActual('@/lib/agentic/kill-switch');
    return {
        ...actual,
        resolveKillState: (...args: unknown[]) =>
            mockKillState.impl ? mockKillState.impl(...args) : actual.resolveKillState(...args),
    };
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { KILL_SWITCH_DRILL_AGENT_ID } from '@/lib/agentic/kill-switch';
import {
    runKillSwitchDrill,
    runAgentKillSwitchDrillJob,
} from '@/app-layer/jobs/agent-kill-switch-drill';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { listKillSwitches } from '@/app-layer/usecases/agent-kill-switch';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `dr-${randomUUID().slice(0, 8)}`;
const TENANT_A = `da-${SUITE}`;
const TENANT_B = `db-${SUITE}`;

async function seedTenantWithAgent(tenantId: string): Promise<void> {
    await prisma.tenant.upsert({
        where: { id: tenantId },
        update: {},
        create: { id: tenantId, name: tenantId, slug: tenantId },
    });
    const userId = `u-${tenantId}-owner`;
    const email = `${tenantId}-owner@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
    });
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId, name: `${tenantId} host`, ownerUserId: userId },
    });
    await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name: `${tenantId} agent`,
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: userId,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

const ownerCtx = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: `u-${tenantId}-owner`,
    });

describeFn('the kill-switch drill runs, records, and raises (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await seedTenantWithAgent(TENANT_A);
        await seedTenantWithAgent(TENANT_B);
    });

    afterEach(() => {
        mockKillState.impl = null;
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.findingEvidence.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.finding.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentKillSwitchDrill.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentKillSwitch.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.evidence.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, t);
                await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t);
            }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => {});
        }
        await prisma.platformAgentKillSwitch.deleteMany({}).catch(() => {});
        await prisma.$disconnect();
    });

    // ── It is actually scheduled ────────────────────────────────────

    it('is on the schedule, with a cron pattern and a single attempt', () => {
        // Asserted against the DATA the scheduler reads, not against prose.
        // Declaration ORDER in SCHEDULED_JOBS is not execution order — only the
        // pattern is — so the pattern is what this pins.
        const entry = SCHEDULED_JOBS.find((j) => j.name === 'agent-kill-switch-drill');
        expect(entry).toBeDefined();
        expect(entry?.pattern).toMatch(/^\d+ \d+ \* \* \*$/);
        // ONE attempt. Three would raise three CRITICAL Findings for one fault
        // in 35 seconds, which is how a real signal becomes noise.
        expect(JOB_DEFAULTS['agent-kill-switch-drill'].attempts).toBe(1);
    });

    // ── The passing drill ───────────────────────────────────────────

    it('executes against the REAL boundary, records the outcome, and raises nothing', async () => {
        const result = await runKillSwitchDrill(TENANT_A, `job-${SUITE}-1`);

        expect(result.outcome).toBe('PASSED');
        expect(result.boundaryRefusalReason).toBe('agent_killed');
        expect(result.toolCallsAfterKill).toBe(0);
        // ALL THREE scopes reported, sorted-insensitively. A drill that silently
        // exercised one arm and reported a pass would be the truncation this
        // subsystem refuses everywhere else.
        expect([...result.scopesHonoured].sort()).toEqual(['AGENT', 'PLATFORM', 'TENANT']);
        expect(result.scopesFailed).toEqual([]);

        const row = await prisma.agentKillSwitchDrill.findFirstOrThrow({
            where: { id: result.drillId ?? '' },
        });
        expect(row.outcome).toBe('PASSED');
        expect(row.completedAt).not.toBeNull();
        expect(row.jobRunId).toBe(`job-${SUITE}-1`);
        // The record is EVIDENCE, not a log line: it points at an Evidence row.
        expect(row.evidenceId).not.toBeNull();
        expect(row.findingId).toBeNull();

        const evidence = await prisma.evidence.findFirstOrThrow({
            where: { id: row.evidenceId ?? '' },
        });
        expect(evidence.type).toBe('TEXT');
        expect(evidence.category).toBe('integration');
        // The evidence says WHICH arm proved what, and what the drill does NOT
        // prove — a single verdict over three different depths of assurance, or
        // one that implied coverage it does not have, would be the same defect
        // as the control it is testing.
        expect(evidence.content).toContain('COMMITTED');
        expect(evidence.content).toContain('ROLLED BACK');
        expect(evidence.content).toContain('proved in CI');

        // NO Finding for a passing drill.
        expect(await prisma.finding.count({ where: { tenantId: TENANT_A } })).toBe(0);
    });

    it('leaves nothing in force, and never targets a real agent', async () => {
        await runKillSwitchDrill(TENANT_A, `job-${SUITE}-2`);

        // The canary is ALWAYS lifted — a drill that left its own kill in force
        // would be a control that breaks the thing it tests.
        expect(
            await prisma.agentKillSwitch.count({
                where: { tenantId: TENANT_A, liftedAt: null },
            }),
        ).toBe(0);

        // And every row it ever wrote named the canary, never a registered
        // agent. This is what makes a nightly drill safe to run in production.
        const targets = await prisma.agentKillSwitch.findMany({
            where: { tenantId: TENANT_A },
            select: { agentId: true },
        });
        expect(targets.length).toBeGreaterThan(0);
        expect([...new Set(targets.map((t) => t.agentId))]).toEqual([KILL_SWITCH_DRILL_AGENT_ID]);
    });

    // ── The failing drill ───────────────────────────────────────────

    it('a boundary that lets the call through FAILS the drill and raises a Finding', async () => {
        // The regression: the kill check no longer sees the kill. Pointed at the
        // exact function whose removal is what the drill exists to catch.
        mockKillState.impl = async () => null;

        const result = await runKillSwitchDrill(TENANT_A, `job-${SUITE}-3`);

        expect(result.outcome).toBe('FAILED');
        expect(result.boundaryRefusalReason).toBe('not_refused');
        // The MEASUREMENT, not a verdict: one call cleared the boundary while a
        // kill was in force.
        expect(result.toolCallsAfterKill).toBe(1);
        expect([...result.scopesFailed].sort()).toEqual(['AGENT', 'PLATFORM', 'TENANT']);

        const row = await prisma.agentKillSwitchDrill.findFirstOrThrow({
            where: { id: result.drillId ?? '' },
        });
        expect(row.outcome).toBe('FAILED');
        expect(row.toolCallsAfterKill).toBe(1);
        expect(row.findingId).not.toBeNull();

        // THE FINDING, through the existing control-test path: a
        // NONCONFORMITY / OPEN row bridged to the producing artefact by
        // FindingEvidence, exactly as control-test-runner does on an automated
        // FAIL. Same queue, same people.
        const finding = await prisma.finding.findFirstOrThrow({
            where: { id: row.findingId ?? '' },
        });
        expect(finding.type).toBe('NONCONFORMITY');
        expect(finding.status).toBe('OPEN');
        expect(finding.severity).toBe('CRITICAL');

        const bridge = await prisma.findingEvidence.findFirstOrThrow({
            where: { tenantId: TENANT_A, findingId: finding.id },
        });
        expect(bridge.evidenceId).toBe(row.evidenceId);

        // Even a failing drill lifts its canary.
        expect(
            await prisma.agentKillSwitch.count({
                where: { tenantId: TENANT_A, liftedAt: null },
            }),
        ).toBe(0);
    });

    it('a refusal for the WRONG REASON fails the drill too — a status code cannot tell them apart', async () => {
        // The subtler regression: the boundary still refuses, but something
        // OTHER than the kill refused it first (the kill check reordered below
        // a credential or exposure check). Every status code still looks right.
        // Simulated by answering with a scope the drill did not engage, so the
        // refusal message is not the one that scope's kill would produce.
        mockKillState.impl = async () => ({
            scope: 'TENANT',
            switchId: 'simulated',
            engagedAt: new Date(),
        });

        const result = await runKillSwitchDrill(TENANT_B, `job-${SUITE}-4`);

        expect(result.outcome).toBe('FAILED');
        expect(result.boundaryRefusalReason).toBe('refused_for_another_reason');
        // NOTHING got through — which is exactly why "the call was refused" is
        // not the claim, and why this number alone would have reported a pass.
        expect(result.toolCallsAfterKill).toBe(0);
        expect(result.scopesFailed).toContain('AGENT');

        const row = await prisma.agentKillSwitchDrill.findFirstOrThrow({
            where: { id: result.drillId ?? '' },
        });
        expect(row.boundaryRefusalReason).toBe('refused_for_another_reason');
        expect(row.findingId).not.toBeNull();
    });

    // ── ERROR is not FAILED ─────────────────────────────────────────

    it('a drill that could NOT RUN records ERROR and raises no Finding', async () => {
        mockKillState.impl = async () => {
            throw new Error('simulated database outage');
        };
        const findingsBefore = await prisma.finding.count({ where: { tenantId: TENANT_B } });

        const result = await runKillSwitchDrill(TENANT_B, `job-${SUITE}-5`);

        expect(result.outcome).toBe('ERROR');
        expect(result.detail).toContain('proves nothing');
        // A drill that could not run has proved nothing. Raising a CRITICAL
        // Finding here would be a Finding about the wrong thing.
        expect(await prisma.finding.count({ where: { tenantId: TENANT_B } })).toBe(findingsBefore);

        const row = await prisma.agentKillSwitchDrill.findFirstOrThrow({
            where: { id: result.drillId ?? '' },
        });
        expect(row.outcome).toBe('ERROR');
        expect(row.findingId).toBeNull();
        // And it still cleaned up after itself.
        expect(
            await prisma.agentKillSwitch.count({
                where: { tenantId: TENANT_B, liftedAt: null },
            }),
        ).toBe(0);
    });

    // ── The scheduled executor ──────────────────────────────────────

    it('the scheduled executor runs a drill and reports the counts', async () => {
        const res = await runAgentKillSwitchDrillJob({ tenantId: TENANT_A });

        expect(res.jobName).toBe('agent-kill-switch-drill');
        // The JOB succeeded because it ran what it set out to run. A FAILED
        // drill is a finding about the product, not a broken job — marking the
        // job failed would put it in the queue's retry path.
        expect(res.success).toBe(true);
        expect(res.itemsScanned).toBe(1);
        expect(res.details?.passed).toBe(1);
        expect(res.details?.failed).toBe(0);
    });

    // ── Two tenants ─────────────────────────────────────────────────

    it('one tenant cannot read another\'s drill records', async () => {
        await runKillSwitchDrill(TENANT_A, `job-${SUITE}-6`);
        const aDrills = await prisma.agentKillSwitchDrill.findMany({
            where: { tenantId: TENANT_A },
            select: { id: true },
        });
        expect(aDrills.length).toBeGreaterThan(0);

        // Read through the real usecase, under tenant B's context and RLS.
        const bView = await listKillSwitches(ownerCtx(TENANT_B));
        const bIds = bView.recentDrills.map((d) => d.id);
        for (const a of aDrills) expect(bIds).not.toContain(a.id);

        // The paired positive: tenant B DOES see its own, so the assertion above
        // is about isolation rather than about a read that returns nothing.
        const aView = await listKillSwitches(ownerCtx(TENANT_A));
        expect(aView.recentDrills.map((d) => d.id)).toEqual(
            expect.arrayContaining([aDrills[0].id]),
        );
    });
});
