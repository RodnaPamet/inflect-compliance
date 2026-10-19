/**
 * The daily audit narrative dispatch (#3749, part C), against a real database.
 *
 *   1. ONE RUN PER TENANT, for the period of its oldest un-narrated workpaper
 *      whose period has ended and which has settled for 24 hours, as the
 *      auditor agent that wrote it, under its owner's permissions.
 *   2. AT MOST ONE A DAY: a second dispatch inside the spacing window starts
 *      nothing, whoever started the first.
 *   3. EVERY REFUSAL IS NAMED and starts nothing: the static engine, a tool not
 *      granted, an unscored or inactive auditor, an owner who cannot read
 *      workpapers. A period with nothing to narrate is no candidate at all.
 *   4. TWO TENANTS: each run is its own tenant's, and one tenant's refusal does
 *      not touch the other's dispatch.
 *
 * ── WHAT IS MOCKED, AND WHY ─────────────────────────────────────────────────
 *
 * The driver decision (the engine check reads it; by default a test tenant
 * resolves to the static engine, which item 3 relies on), the registration
 * gate on the Flue path, and the worker the run is handed to. The mount gate,
 * the run admission and the run row are real.
 */
jest.mock('@/lib/agentic/agent-driver-policy', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-driver-policy');
    return { ...actual, resolveDriverForRun: jest.fn(actual.resolveDriverForRun) };
});
jest.mock('@/lib/agentic/agent-registration-gate', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-registration-gate');
    return { ...actual, evaluateAgentRegistration: jest.fn(actual.evaluateAgentRegistration) };
});
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { resetSkillCache } from '@/lib/agentic/flue/skills/resolve';
import { runAuditNarrativeDispatch, NARRATIVE_READ_TOOL } from '@/app-layer/jobs/audit-narrative-dispatch';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'narrative-dispatch-one';
const T2 = 'narrative-dispatch-two';
const ALL_TENANTS = [T1, T2];
const HEX = 'a'.repeat(64);
/** "Now" for every dispatch: well after the seeded periods ended and their workpapers settled. */
const NOW = new Date(Date.UTC(2026, 9, 10, 8, 50));

const emails = (tenantId: string) => [`owner@${tenantId}.test`, `second@${tenantId}.test`];

interface Seeded {
    second: string;
    secondMembership: string;
    auditor: string;
}
const seeded: Record<string, Seeded> = {};

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.auditWorkpaperNarrative.deleteMany({ where: t });
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AiDecisionLog" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.flatMap(emails).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

/** A PASS workpaper of `periodLabel`, written `daysAgo` days before NOW. */
async function workpaper(tenantId: string, periodLabel: string, daysAgo: number, i: number): Promise<string> {
    const procedureId = 'iam.time_bounded_access_expiry';
    const row = await prisma.auditWorkpaper.create({
        data: {
            tenantId,
            procedureId,
            catalogueVersion: 1,
            periodLabel,
            populationDefinition: 'Journalled time-bounded grants whose end date falls inside the period',
            populationCount: 2,
            populationDigest: HEX,
            sampleEpoch: `${procedureId}@${periodLabel}`,
            seedFingerprint: HEX,
            sampleSize: 1,
            sampledUnitIds: ['ewj_1'],
            attributesTested: ['T1', 'T2', 'T3', 'T4'],
            itemOutcomesJson: [{ unitId: 'ewj_1', outcome: 'PASS', code: null }],
            exceptionsJson: [],
            exceptionCount: 0,
            conclusion: 'PASS',
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
            auditorAgentId: seeded[tenantId].auditor,
            controlTestRunId: `run-${tenantId}-${i}`,
            createdAt: new Date(NOW.getTime() - daysAgo * 24 * 3600 * 1000),
        },
    });
    return row.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, secondEmail] = emails(tenantId);
    const owner = await prisma.user.create({ data: { email: ownerEmail, emailHash: hashForLookup(ownerEmail) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: owner.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
    const second = await prisma.user.create({ data: { email: secondEmail, emailHash: hashForLookup(secondEmail) } });
    // The auditor's owner: second line, ADMIN, so it holds audits.workpaper_view.
    const m = await prisma.tenantMembership.create({
        data: { tenantId, userId: second.id, role: Role.ADMIN, status: MembershipStatus.ACTIVE, lineOfDefence: 'SECOND' },
    });
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: 'Auditor host', ownerUserId: second.id } });
    const auditor = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name: `Auditor ${tenantId}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: second.id,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            isAuditor: true,
        },
    });
    await prisma.registeredAgentTool.create({
        data: { tenantId, agentId: auditor.id, toolName: NARRATIVE_READ_TOOL, grantedByUserId: owner.id },
    });
    seeded[tenantId] = { second: second.id, secondMembership: m.id, auditor: auditor.id };
}

function asFlue(): void {
    jest.mocked(resolveDriverForRun).mockImplementation(async () => ({ driver: 'flue', reason: null }) as Awaited<ReturnType<typeof resolveDriverForRun>>);
    jest.mocked(evaluateAgentRegistration).mockImplementation(
        async () => ({ standing: 'vouched' }) as Awaited<ReturnType<typeof evaluateAgentRegistration>>,
    );
}
function asStatic(): void {
    jest.mocked(resolveDriverForRun).mockImplementation(async () => ({ driver: 'static', reason: null }) as Awaited<ReturnType<typeof resolveDriverForRun>>);
}

const runsOf = (tenantId: string) =>
    prisma.workflowRun.findMany({
        where: { tenantId, workflowKey: 'audit-narrative' },
        select: { id: true, agentId: true, startedByUserId: true },
        take: 20,
    });

/**
 * The run rows are written at the wall clock, but each dispatch here runs at a
 * fixed "now"; put a run where the dispatch that started it stood, settled, as
 * a day-old run would be by the next morning.
 */
const settleRunsAt = (at: Date) =>
    prisma.workflowRun.updateMany({
        where: { tenantId: { in: ALL_TENANTS }, workflowKey: 'audit-narrative' },
        data: { createdAt: at, status: 'COMPLETED', completedAt: at },
    });

const outcomeOf = async (tenantId: string, now: Date = NOW) => {
    const r = await runAuditNarrativeDispatch(prisma, { tenantId, now });
    return r.tenants.find((t) => t.tenantId === tenantId);
};

beforeAll(async () => {
    resetSkillCache();
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
    // T1: September (ended, 8 days old) is its oldest un-narrated period;
    // a workpaper of the open October period and one written an hour ago are
    // never candidates.
    await workpaper(T1, '2026-09', 8, 1);
    await workpaper(T1, '2026-10', 1, 2);
    // T2: August is narrated already, so September is its period.
    const narratedAug = await workpaper(T2, '2026-08', 30, 3);
    await prisma.auditWorkpaperNarrative.create({
        data: { tenantId: T2, workpaperId: narratedAug, runId: 'earlier-run', exceptionCodes: [], text: 'narrated earlier' },
    });
    await workpaper(T2, '2026-09', 6, 4);
});

afterEach(() => {
    const realDriver = jest.requireActual('@/lib/agentic/agent-driver-policy').resolveDriverForRun;
    const realGate = jest.requireActual('@/lib/agentic/agent-registration-gate').evaluateAgentRegistration;
    jest.mocked(resolveDriverForRun).mockClear().mockImplementation(realDriver);
    jest.mocked(evaluateAgentRegistration).mockClear().mockImplementation(realGate);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('every refusal is named and starts nothing', () => {
    it('a tenant whose runs resolve to the static engine', async () => {
        asStatic();
        await expect(outcomeOf(T1)).resolves.toMatchObject({ outcome: 'engine_not_flue', periodLabel: '2026-09' });
        expect(await runsOf(T1)).toHaveLength(0);
    });

    it('an auditor not granted the read tool', async () => {
        asFlue();
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: T1, agentId: seeded[T1].auditor } });
        try {
            await expect(outcomeOf(T1)).resolves.toMatchObject({ outcome: 'tool_not_granted' });
        } finally {
            await prisma.registeredAgentTool.create({
                data: { tenantId: T1, agentId: seeded[T1].auditor, toolName: NARRATIVE_READ_TOOL, grantedByUserId: seeded[T1].second },
            });
        }
        expect(await runsOf(T1)).toHaveLength(0);
    });

    it('an auditor never risk-assessed', async () => {
        asFlue();
        await prisma.registeredAgent.update({ where: { id: seeded[T1].auditor }, data: { riskTier: null, riskTierScoredAt: null } });
        try {
            await expect(outcomeOf(T1)).resolves.toMatchObject({ outcome: 'auditor_unscored' });
        } finally {
            await prisma.registeredAgent.update({ where: { id: seeded[T1].auditor }, data: { riskTier: 'LOW', riskTierScoredAt: new Date() } });
        }
        expect(await runsOf(T1)).toHaveLength(0);
    });

    it('an owner who holds neither audits.workpaper_view nor audits.manage', async () => {
        asFlue();
        await prisma.tenantMembership.update({ where: { id: seeded[T1].secondMembership }, data: { role: Role.READER } });
        try {
            await expect(outcomeOf(T1)).resolves.toMatchObject({ outcome: 'owner_cannot_read_workpapers' });
        } finally {
            await prisma.tenantMembership.update({ where: { id: seeded[T1].secondMembership }, data: { role: Role.ADMIN } });
        }
        expect(await runsOf(T1)).toHaveLength(0);
    });

    it('a period still open, or a workpaper not yet settled, is no candidate at all', async () => {
        asFlue();
        // Before September ended, and before its workpaper was 24 hours old.
        const early = new Date(Date.UTC(2026, 9, 2, 12, 0));
        const r = await runAuditNarrativeDispatch(prisma, { tenantId: T1, now: early });
        expect(r.tenants).toEqual([]);
        expect(await runsOf(T1)).toHaveLength(0);
    });
});

describe('one run per tenant, at most once a day', () => {
    it('starts one run per tenant for its oldest un-narrated ended period, as its auditor, under its owner', async () => {
        asFlue();
        const r = await runAuditNarrativeDispatch(prisma, { now: NOW });
        const mine = r.tenants.filter((t) => ALL_TENANTS.includes(t.tenantId));
        expect(Object.fromEntries(mine.map((t) => [t.tenantId, [t.outcome, t.periodLabel]]))).toEqual({
            [T1]: ['dispatched', '2026-09'],
            [T2]: ['dispatched', '2026-09'],
        });
        for (const t of ALL_TENANTS) {
            const runs = await runsOf(t);
            expect(runs).toHaveLength(1);
            expect(runs[0]).toMatchObject({ agentId: seeded[t].auditor, startedByUserId: seeded[t].second });
            expect(mine.find((d) => d.tenantId === t)?.runId).toBe(runs[0].id);
        }
        await settleRunsAt(NOW);
    });

    it('a second dispatch inside the window starts nothing, and names why', async () => {
        asFlue();
        await expect(outcomeOf(T1, new Date(NOW.getTime() + 2 * 3600 * 1000))).resolves.toMatchObject({
            outcome: 'already_ran_today',
        });
        expect(await runsOf(T1)).toHaveLength(1);
    });

    it('one tenant’s refusal does not touch another’s dispatch', async () => {
        asFlue();
        const tomorrow = new Date(NOW.getTime() + 24 * 3600 * 1000);
        await prisma.registeredAgent.update({ where: { id: seeded[T1].auditor }, data: { riskTier: null, riskTierScoredAt: null } });
        try {
            const r = await runAuditNarrativeDispatch(prisma, { now: tomorrow });
            const byTenant = Object.fromEntries(r.tenants.filter((t) => ALL_TENANTS.includes(t.tenantId)).map((t) => [t.tenantId, t.outcome]));
            expect(byTenant).toEqual({ [T1]: 'auditor_unscored', [T2]: 'dispatched' });
        } finally {
            await prisma.registeredAgent.update({ where: { id: seeded[T1].auditor }, data: { riskTier: 'LOW', riskTierScoredAt: new Date() } });
        }
        expect(await runsOf(T1)).toHaveLength(1);
        expect(await runsOf(T2)).toHaveLength(2);
    });
});
