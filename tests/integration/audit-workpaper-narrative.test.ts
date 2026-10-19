/**
 * The auditor agent's narrative of a period's workpapers, stored and read,
 * against a real database (#3749).
 *
 * Every run here is admitted by the real `startWorkflowRun` on the Flue path,
 * pinned to `iam-audit-procedures` through the real mount gate; every answer is
 * written by the real Art 12 recorder (`recordModelDecision`). What is pinned:
 *
 *   1. THE CAPTURE STORES NARRATIVES HELD TO THE RECORD: one per workpaper,
 *      encrypted at rest, audited without its text, and flagged on the
 *      period read.
 *   2. WRITE-ONCE: a second capture, or a second run, stores nothing over a
 *      stored narrative; the database refuses an UPDATE from every role and a
 *      DELETE from `app_user`, and refuses a code the workpaper does not record.
 *   3. EVERY OTHER OUTCOME IS NAMED AND RECORDS NOTHING — prose, a conclusion
 *      the workpaper does not record, a workpaper of another period or tenant,
 *      a block about another period, a static run, a run still in flight.
 *   4. TWO TENANTS: another tenant can neither capture this tenant's run nor
 *      see its narratives, through the usecase or past RLS.
 *   5. THE SETTLEMENT SEAM CALLS THE CAPTURE for a completed run.
 *
 * ── WHAT IS MOCKED, AND WHY ─────────────────────────────────────────────────
 *
 * The Flue admission half, as `agent-review-attribution.test.ts` does: a
 * deployment that permits the engine, a vouched registered agent, and the
 * worker the run is handed to. The after-run hook is wrapped in a pass-through
 * spy so item 5 can see it called.
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
jest.mock('@/app-layer/usecases/audit-workpaper-narrative', () => {
    const actual = jest.requireActual('@/app-layer/usecases/audit-workpaper-narrative');
    return { ...actual, captureAuditNarrativeAfterRun: jest.fn(actual.captureAuditNarrativeAfterRun) };
});

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { runInTenantContext } from '@/lib/db-context';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { listAuditWorkpapersForPeriod } from '@/app-layer/usecases/audit-workpaper';
import {
    captureAuditNarrative,
    captureAuditNarrativeAfterRun,
    narrativeOfWorkpaper,
} from '@/app-layer/usecases/audit-workpaper-narrative';
import { recordModelDecision } from '@/lib/agentic/flue/model-decision';
import { auditNarrativeWorkflow } from '@/lib/agentic/workflows/audit-narrative';
import { resetSkillCache } from '@/lib/agentic/flue/skills/resolve';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const KEY = auditNarrativeWorkflow.key;
const T1 = 'audit-narrative-one';
const T2 = 'audit-narrative-two';
const ALL_TENANTS = [T1, T2];
const PERIOD = '2026-09';
const OTHER_PERIOD = '2026-08';
const HEX = 'a'.repeat(64);

const emails = (tenantId: string) => [`owner@${tenantId}.test`, `second@${tenantId}.test`];

/** The workpapers each tenant holds: two to narrate, one the refusals use, one of another period. */
interface Seeded {
    owner: string;
    second: string;
    auditor: string;
    fail: string;
    pass: string;
    refusals: string;
    otherPeriod: string;
}
const seeded: Record<string, Seeded> = {};

const ownerCtx = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].owner });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.auditWorkpaperNarrative.deleteMany({ where: t });
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
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

async function member(tenantId: string, email: string, role: Role, lineOfDefence?: 'SECOND'): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role, status: MembershipStatus.ACTIVE, ...(lineOfDefence ? { lineOfDefence } : {}) },
    });
    return user.id;
}

/** A workpaper written as the auditor's procedure handler writes one, through the shape CHECKs. */
async function workpaper(
    tenantId: string,
    auditorAgentId: string,
    procedureId: string,
    periodLabel: string,
    conclusion: 'PASS' | 'FAIL',
    i: number,
): Promise<string> {
    const failed = conclusion === 'FAIL';
    const row = await prisma.auditWorkpaper.create({
        data: {
            tenantId,
            procedureId,
            catalogueVersion: 1,
            periodLabel,
            populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
            populationCount: 4,
            populationDigest: HEX,
            sampleEpoch: `${procedureId}@${periodLabel}`,
            seedFingerprint: HEX,
            sampleSize: 2,
            sampledUnitIds: ['emp_1', 'emp_2'],
            attributesTested: ['L1', 'L2', 'L3'],
            itemOutcomesJson: [
                { unitId: 'emp_1', outcome: 'PASS', code: null },
                failed
                    ? { unitId: 'emp_2', outcome: 'EXCEPTION', code: 'LEAVER_DISABLED_LATE' }
                    : { unitId: 'emp_2', outcome: 'PASS', code: null },
            ],
            exceptionsJson: failed ? [{ unitId: 'emp_2', code: 'LEAVER_DISABLED_LATE' }] : [],
            exceptionCount: failed ? 1 : 0,
            conclusion,
            conclusionBasis: failed ? 'EXCEPTIONS_FOUND' : 'ALL_SAMPLED_UNITS_PASSED',
            auditorAgentId,
            controlTestRunId: `run-${tenantId}-${i}`,
            createdAt: new Date(Date.UTC(2026, 9, 2, 6, i)),
        },
    });
    return row.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, secondEmail] = emails(tenantId);
    const owner = await member(tenantId, ownerEmail, Role.OWNER);
    // The independence trigger wants an auditor owned by the second line.
    const second = await member(tenantId, secondEmail, Role.ADMIN, 'SECOND');
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: 'Auditor host', ownerUserId: second } });
    const auditor = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name: `Auditor ${tenantId}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: second,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            isAuditor: true,
        },
    });
    seeded[tenantId] = {
        owner,
        second,
        auditor: auditor.id,
        fail: await workpaper(tenantId, auditor.id, 'iam.leaver_timeliness', PERIOD, 'FAIL', 1),
        pass: await workpaper(tenantId, auditor.id, 'iam.time_bounded_access_expiry', PERIOD, 'PASS', 2),
        refusals: await workpaper(tenantId, auditor.id, 'agent.authority_conformance', PERIOD, 'FAIL', 3),
        otherPeriod: await workpaper(tenantId, auditor.id, 'iam.leaver_timeliness', OTHER_PERIOD, 'FAIL', 4),
    };
}

const FAIL_TEXT = 'Two of four leavers were sampled; emp_2 was disabled after the 24-hour window (LEAVER_DISABLED_LATE). FAIL.';
const PASS_TEXT = 'Both sampled grants ended inside their window and were seen gone: ALL_SAMPLED_UNITS_PASSED, so PASS.';

const failNarrative = (workpaperId: string, over: Record<string, unknown> = {}) => ({
    workpaperId,
    conclusion: 'FAIL',
    exceptionCodes: ['LEAVER_DISABLED_LATE'],
    text: FAIL_TEXT,
    ...over,
});
const block = (narratives: unknown[], periodLabel = PERIOD) =>
    ['```json', JSON.stringify({ periodLabel, narratives }), '```'].join('\n');

function asFlue(): void {
    jest.mocked(resolveDriverForRun).mockImplementation(async () => ({ driver: 'flue', reason: null }) as Awaited<ReturnType<typeof resolveDriverForRun>>);
    jest.mocked(evaluateAgentRegistration).mockImplementation(
        async () => ({ standing: 'vouched' }) as Awaited<ReturnType<typeof evaluateAgentRegistration>>,
    );
}

/** One narrative run for a period on the Flue path, settled as its worker would. */
async function narrativeRun(
    tenantId: string,
    answer: string | null,
    opts: { periodLabel?: string; settle?: boolean } = {},
): Promise<string> {
    asFlue();
    const { runId, status } = await startWorkflowRun(ownerCtx(tenantId), KEY, { periodLabel: opts.periodLabel ?? PERIOD });
    expect(status).toBe('RUNNING');
    if (answer !== null) {
        await recordModelDecision(
            ownerCtx(tenantId),
            runId,
            auditNarrativeWorkflow,
            'the dispatched narrative message',
            answer,
            { tokensIn: 120, tokensOut: 80 },
            'anthropic/claude-narrative-test',
        );
    }
    if (opts.settle !== false) {
        await prisma.workflowRun.update({ where: { id: runId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    }
    return runId;
}

const storedRows = (tenantId: string) => prisma.auditWorkpaperNarrative.count({ where: { tenantId } });

beforeAll(async () => {
    resetSkillCache();
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
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

describe('the capture stores narratives held to the record', () => {
    it('stores one narrative per workpaper, encrypted at rest, audited without its text, and flagged on the period read', async () => {
        const s = seeded[T1];
        const runId = await narrativeRun(
            T1,
            block([
                failNarrative(s.fail),
                { workpaperId: s.pass, conclusion: 'PASS', exceptionCodes: [], text: PASS_TEXT },
            ]),
        );

        await expect(captureAuditNarrative(ownerCtx(T1), runId)).resolves.toEqual({
            outcome: 'RECORDED',
            periodLabel: PERIOD,
            recorded: 2,
            alreadyNarrated: 0,
        });

        // Through the usecase (the encryption extension decrypts).
        const stored = await runInTenantContext(ownerCtx(T1), (db) => narrativeOfWorkpaper(db, ownerCtx(T1), s.fail));
        expect(stored).toMatchObject({ text: FAIL_TEXT, exceptionCodes: ['LEAVER_DISABLED_LATE'], runId });

        // Raw (no encryption extension on the test client): ciphertext.
        const raw = await prisma.auditWorkpaperNarrative.findFirstOrThrow({ where: { tenantId: T1, workpaperId: s.fail } });
        expect(raw.text).toMatch(/^v[12]:/);
        expect(raw.text).not.toContain('emp_2');

        // One audit row per narrative: the run and the codes, never the text.
        const audits = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'AUDIT_WORKPAPER_NARRATIVE_RECORDED' },
            take: 10,
        });
        expect(audits.map((a) => a.entityId).sort()).toEqual([s.fail, s.pass].sort());
        expect(JSON.stringify(audits)).toContain(runId);
        expect(JSON.stringify(audits)).not.toContain('disabled after the 24-hour window');

        const period = await listAuditWorkpapersForPeriod(ownerCtx(T1), PERIOD);
        expect(Object.fromEntries(period.workpapers.map((w) => [w.workpaperId, w.narrated]))).toEqual({
            [s.fail]: true,
            [s.pass]: true,
            [s.refusals]: false,
        });
    });
});

describe('write-once', () => {
    it('a second capture, and a second run, store nothing over a stored narrative', async () => {
        const s = seeded[T1];
        const first = (await prisma.auditWorkpaperNarrative.findFirstOrThrow({ where: { tenantId: T1, workpaperId: s.fail } })).runId;
        await expect(captureAuditNarrative(ownerCtx(T1), first)).resolves.toMatchObject({
            outcome: 'ALREADY_RECORDED',
            recorded: 0,
            alreadyNarrated: 2,
        });

        const second = await narrativeRun(
            T1,
            block([failNarrative(s.fail, { text: 'A rewritten account that still records FAIL (LEAVER_DISABLED_LATE).' })]),
        );
        const before = await storedRows(T1);
        await expect(captureAuditNarrative(ownerCtx(T1), second)).resolves.toMatchObject({ outcome: 'ALREADY_RECORDED' });
        expect(await storedRows(T1)).toBe(before);
        const kept = await runInTenantContext(ownerCtx(T1), (db) => narrativeOfWorkpaper(db, ownerCtx(T1), s.fail));
        expect(kept).toMatchObject({ text: FAIL_TEXT, runId: first });
    });

    it('the database refuses an UPDATE from every role and a DELETE from app_user', async () => {
        const row = await prisma.auditWorkpaperNarrative.findFirstOrThrow({ where: { tenantId: T1, workpaperId: seeded[T1].fail } });
        await expect(
            prisma.auditWorkpaperNarrative.update({ where: { id: row.id }, data: { runId: 'rewritten' } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_NARRATIVE/);
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
                await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${T1}', true)`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditWorkpaperNarrative" WHERE "id" = $1`, row.id);
            }),
        ).rejects.toThrow(/permission denied/);
        expect(await prisma.auditWorkpaperNarrative.count({ where: { id: row.id } })).toBe(1);
    });

    it('the database refuses a code the workpaper does not record, for a writer that skips the contract', async () => {
        await expect(
            prisma.auditWorkpaperNarrative.create({
                data: {
                    tenantId: T1,
                    workpaperId: seeded[T1].refusals,
                    runId: 'direct-writer',
                    exceptionCodes: ['LEAVER_ACCOUNT_ACTIVE'],
                    text: 'not through the capture',
                },
            }),
        ).rejects.toThrow(/AUDIT_WORKPAPER_NARRATIVE_UNRECORDED_CODE/);
    });
});

describe('every other outcome is named and records nothing', () => {
    const wp = () => seeded[T1].refusals;

    it.each<[string, () => string, string]>([
        ['prose, with no narrative block in it', () => 'The period shows one late disable. FAIL.', 'NO_NARRATIVE_IN_ANSWER'],
        ['a conclusion the workpaper does not record', () => block([failNarrative(wp(), { conclusion: 'PASS', exceptionCodes: [] })]), 'CONCLUSION_MISMATCH'],
        ['an exception code the workpaper does not record', () => block([failNarrative(wp(), { exceptionCodes: ['LEAVER_ACCOUNT_ACTIVE'] })]), 'UNRECORDED_EXCEPTION_CODE'],
        ['a workpaper of another period', () => block([failNarrative(seeded[T1].otherPeriod)]), 'UNKNOWN_WORKPAPER'],
        ['another tenant’s workpaper', () => block([failNarrative(seeded[T2].refusals)]), 'UNKNOWN_WORKPAPER'],
        ['a block about another period than the run’s', () => block([failNarrative(wp())], OTHER_PERIOD), 'PERIOD_MISMATCH'],
    ])('%s', async (_label, text, outcome) => {
        const runId = await narrativeRun(T1, text());
        const before = await storedRows(T1);
        await expect(captureAuditNarrative(ownerCtx(T1), runId)).resolves.toMatchObject({ outcome, recorded: 0 });
        expect(await storedRows(T1)).toBe(before);
        expect(await prisma.auditWorkpaperNarrative.count({ where: { workpaperId: wp() } })).toBe(0);
    });

    it('a run with no answer on record, and a run still in flight', async () => {
        const silent = await narrativeRun(T1, null);
        await expect(captureAuditNarrative(ownerCtx(T1), silent)).resolves.toMatchObject({ outcome: 'NO_ANSWER' });
        const inFlight = await narrativeRun(T1, block([failNarrative(wp())]), { settle: false });
        await expect(captureAuditNarrative(ownerCtx(T1), inFlight)).resolves.toMatchObject({ outcome: 'RUN_NOT_COMPLETED' });
        await prisma.workflowRun.update({ where: { id: inFlight }, data: { status: 'FAILED', completedAt: new Date() } });
        expect(await prisma.auditWorkpaperNarrative.count({ where: { workpaperId: wp() } })).toBe(0);
    });

    it('a static run has no model and so no answer, even with a decision row beside it', async () => {
        const { runId, status } = await startWorkflowRun(ownerCtx(T1), KEY, { periodLabel: PERIOD });
        expect(status).toBe('COMPLETED');
        await recordModelDecision(
            ownerCtx(T1),
            runId,
            auditNarrativeWorkflow,
            'not a model run',
            block([failNarrative(wp())]),
            { tokensIn: 1, tokensOut: 1 },
            'anthropic/claude-narrative-test',
        );
        await expect(captureAuditNarrative(ownerCtx(T1), runId)).resolves.toMatchObject({ outcome: 'NOT_A_MODEL_RUN' });
        expect(await prisma.auditWorkpaperNarrative.count({ where: { workpaperId: wp() } })).toBe(0);
    });

    it('an id that is not a narrative run', async () => {
        await expect(captureAuditNarrative(ownerCtx(T1), 'not-a-run')).resolves.toEqual({
            outcome: 'NOT_A_NARRATIVE_RUN',
            periodLabel: null,
            recorded: 0,
            alreadyNarrated: 0,
        });
    });
});

describe('two tenants', () => {
    it('another tenant cannot capture this tenant’s run, read its narratives, or see them past RLS', async () => {
        const t1Run = (await prisma.auditWorkpaperNarrative.findFirstOrThrow({ where: { tenantId: T1 } })).runId;

        const t2 = seeded[T2];
        const t2Run = await narrativeRun(T2, block([failNarrative(t2.fail)]));
        await expect(captureAuditNarrative(ownerCtx(T2), t2Run)).resolves.toMatchObject({ outcome: 'RECORDED', recorded: 1 });

        await expect(captureAuditNarrative(ownerCtx(T2), t1Run)).resolves.toMatchObject({ outcome: 'NOT_A_NARRATIVE_RUN' });
        await expect(
            runInTenantContext(ownerCtx(T2), (db) => narrativeOfWorkpaper(db, ownerCtx(T2), seeded[T1].fail)),
        ).resolves.toBeNull();
        const seen = await runInTenantContext(ownerCtx(T2), (db) =>
            db.auditWorkpaperNarrative.findMany({ select: { tenantId: true, runId: true }, take: 50 }),
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((r) => r.tenantId === T2)).toBe(true);
    });
});

describe('the settlement seam calls the capture', () => {
    it('a run that completes through the engine is handed to the capture, which names why it stored nothing', async () => {
        const hook = jest.mocked(captureAuditNarrativeAfterRun);
        hook.mockClear();
        // The static engine completes the run in-process, through executeFrom.
        const { runId, status } = await startWorkflowRun(ownerCtx(T1), KEY, { periodLabel: PERIOD });
        expect(status).toBe('COMPLETED');
        expect(hook).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1 }), runId, KEY, 'COMPLETED');
        await expect(hook.mock.results[0].value).resolves.toMatchObject({ outcome: 'NOT_A_MODEL_RUN' });
    });
});
