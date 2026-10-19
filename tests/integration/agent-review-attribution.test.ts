/**
 * A discovered-agent review's owner suggestion, stored and read, against a real
 * database (#3728, a follow-up of #3712).
 *
 * Every discovered agent here was written by the real ingest (a signed report
 * from a fake scanner whose key the tenant registered); every review run was
 * admitted by the real `startWorkflowRun` on the Flue path, pinned to the two
 * IAM skills through the real mount gate; and every answer was written by the
 * real Art 12 recorder (`recordModelDecision`) — the one place a Flue run's
 * model output lands. What is pinned:
 *
 *   1. THE CAPTURE STORES A PARSED ANSWER, and only that: status, grade,
 *      person-free signals and the run, with the person a SUGGESTED answer
 *      named kept apart and encrypted at rest.
 *   2. EVERY OTHER OUTCOME IS NAMED AND RECORDS NOTHING — prose, an answer the
 *      contract refuses, an answer about another agent, a static run, a run
 *      still in flight, a run with no answer.
 *   3. THE NEWEST REVIEW WINS, and an older run never replaces it.
 *   4. THE SHADOW LIST CARRIES THE SUGGESTION AND NO OWNER REFERENCE — the
 *      #3687 rule, with a canary proven present at the source first.
 *   5. TWO TENANTS: another tenant can neither capture this tenant's run nor
 *      read its suggestion, through the usecases or past RLS.
 *   6. THE INTAKE RECORDS THE SUGGESTION IT WAS GIVEN — by run id, with the
 *      comparison against the confirmed owner made server-side — and refuses a
 *      run id that is not the one stored now, writing nothing.
 *   7. THE SETTLEMENT SEAM CALLS THE CAPTURE for a completed review run.
 *
 * ── WHAT IS MOCKED, AND WHY ─────────────────────────────────────────────────
 *
 * The Flue admission half, exactly as `discovered-agent-review.test.ts` does: a
 * deployment that permits the engine, a vouched registered agent, and the
 * worker the run is handed to (which a CJS suite cannot load). The capture's
 * after-run hook is wrapped in a pass-through spy so item 7 can see it called.
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
jest.mock('@/app-layer/usecases/agent-harness-attribution', () => {
    const actual = jest.requireActual('@/app-layer/usecases/agent-harness-attribution');
    return { ...actual, captureReviewAttributionAfterRun: jest.fn(actual.captureReviewAttributionAfterRun) };
});

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody } from '../helpers/agent-harness-fake-scanner';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { runInTenantContext } from '@/lib/db-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { getHarnessMatrix } from '@/app-layer/usecases/agent-harness-matrix';
import { registerShadowAgent } from '@/app-layer/usecases/agent-registration-intake';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import {
    captureReviewAttribution,
    captureReviewAttributionAfterRun,
    readStoredSuggestion,
} from '@/app-layer/usecases/agent-harness-attribution';
import { recordModelDecision } from '@/lib/agentic/flue/model-decision';
import { discoveredAgentReviewWorkflow } from '@/lib/agentic/workflows/discovered-agent-review';
import { resetSkillCache } from '@/lib/agentic/flue/skills/resolve';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const KEY = discoveredAgentReviewWorkflow.key;
const T1 = 'review-attribution-one';
const T2 = 'review-attribution-two';
const ALL_TENANTS = [T1, T2];

/** The shadow agents each tenant's scan reports. */
const SHADOWS = ['sug-matrix', 'sug-refusals', 'sug-intake', 'sug-stale'] as const;
type Shadow = (typeof SHADOWS)[number];
const discoveredIdOf = (s: Shadow) => `entra:sp:${s}`;

/**
 * The person the matrix agent's suggestion names — proven present in the
 * stored row before its absence from the client payload is asserted.
 */
const SUGGESTED_OWNER_CANARY = 'usr_canary_suggested_owner_3728';

const emails = (tenantId: string) => [`owner@${tenantId}.test`, `other@${tenantId}.test`];

interface Seeded {
    owner: string;
    other: string;
    discovered: Record<Shadow, string>;
    shadowFinding: Record<Shadow, string>;
}
const seeded: Record<string, Seeded> = {};

const ownerCtx = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].owner });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.discoveredAgentAttribution.deleteMany({ where: t });
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
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

async function member(tenantId: string, email: string, role: Role): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: MembershipStatus.ACTIVE } });
    return user.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, otherEmail] = emails(tenantId);
    seeded[tenantId] = {
        owner: await member(tenantId, ownerEmail, Role.OWNER),
        other: await member(tenantId, otherEmail, Role.ADMIN),
    } as Seeded;
    const ctx = ownerCtx(tenantId);
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: 'Scanner host', ownerUserId: seeded[tenantId].owner } });
    const scannerAgent = await createRegisteredAgent(ctx, {
        aiSystemId: aiSystem.id,
        name: `Scanner ${tenantId}`,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: seeded[tenantId].owner,
    });
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctx, { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });

    const body = validReportBody();
    body.scan = { id: `scan-${tenantId}`, asOf: '2026-10-18T03:00:00.000Z', scanner: { ...body.scan.scanner, agentId: scannerAgent.id } };
    const template = body.agents[1];
    body.agents = SHADOWS.map(
        (s): (typeof body.agents)[number] => ({ ...template, discoveredId: discoveredIdOf(s), registeredAgentId: null }),
    );
    body.findings = [];
    await ingestHarnessReport(ctx, scanner.serialise(body));

    const discovered = await prisma.discoveredAgent.findMany({ where: { tenantId }, select: { id: true, discoveredId: true } });
    const byDiscoveredId = new Map(discovered.map((d) => [d.discoveredId, d.id]));
    const findings = await prisma.finding.findMany({ where: { tenantId, sourceKind: 'AGENT_HARNESS' }, select: { id: true, sourceRef: true } });
    const findingByRef = new Map(findings.map((f) => [f.sourceRef as string, f.id]));
    seeded[tenantId].discovered = Object.fromEntries(SHADOWS.map((s) => [s, byDiscoveredId.get(discoveredIdOf(s)) as string])) as Record<Shadow, string>;
    seeded[tenantId].shadowFinding = Object.fromEntries(
        SHADOWS.map((s) => [s, findingByRef.get(`SHADOW_AGENT:${discoveredIdOf(s)}`) as string]),
    ) as Record<Shadow, string>;
}

/** A SUGGESTED answer about one agent, naming `ownerRef` through the identity's owner list. */
function suggested(discoveredAgentId: string, ownerRef: string, over: Record<string, unknown> = {}) {
    return {
        discoveredAgentId,
        status: 'SUGGESTED',
        proposedOwnerRef: ownerRef,
        grade: 'STRONG',
        signals: [
            { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/sug#owners', personRef: ownerRef, personActive: true },
            { kind: 'TEAM_TAG', evidence: 'entra-sp:servicePrincipals/sug#tags', personRef: null, personActive: null },
        ],
        ...over,
    };
}

/** The model's settled text: prose, then the contract's JSON in a fence. */
const answerText = (value: unknown) =>
    ['Reviewed the agent from its newest scan.', '```json', JSON.stringify(value, null, 2), '```'].join('\n');

/** Ask for the Flue path: a permitting deployment and a vouched agent. */
function asFlue(): void {
    jest.mocked(resolveDriverForRun).mockImplementation(async () => ({ driver: 'flue', reason: null }) as Awaited<ReturnType<typeof resolveDriverForRun>>);
    jest.mocked(evaluateAgentRegistration).mockImplementation(
        async () => ({ standing: 'vouched' }) as Awaited<ReturnType<typeof evaluateAgentRegistration>>,
    );
}

/**
 * One review run of one agent on the Flue path, settled as its worker would:
 * the Art 12 row with the settled text (unless `answer` is null), then
 * COMPLETED at `completedAt` (unless `settle` is false).
 */
async function reviewRun(
    tenantId: string,
    discoveredAgentId: string,
    answer: string | null,
    opts: { completedAt?: Date; settle?: boolean } = {},
): Promise<string> {
    asFlue();
    const { runId, status } = await startWorkflowRun(ownerCtx(tenantId), KEY, { discoveredAgentId });
    expect(status).toBe('RUNNING');
    if (answer !== null) {
        await recordModelDecision(
            ownerCtx(tenantId),
            runId,
            discoveredAgentReviewWorkflow,
            'the dispatched review message',
            answer,
            { tokensIn: 120, tokensOut: 80 },
            'anthropic/claude-review-test',
        );
    }
    if (opts.settle !== false) {
        await prisma.workflowRun.update({
            where: { id: runId },
            data: { status: 'COMPLETED', completedAt: opts.completedAt ?? new Date() },
        });
    }
    return runId;
}

const storedRows = (tenantId: string) => prisma.discoveredAgentAttribution.count({ where: { tenantId } });

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

describe('the capture stores a parsed answer, and the person apart', () => {
    it('records status, grade, person-free signals and the run; the person is encrypted at rest', async () => {
        const agentId = seeded[T1].discovered['sug-matrix'];
        const runId = await reviewRun(T1, agentId, answerText(suggested(agentId, SUGGESTED_OWNER_CANARY)));

        await expect(captureReviewAttribution(ownerCtx(T1), runId)).resolves.toEqual({
            outcome: 'RECORDED',
            discoveredAgentId: agentId,
        });

        // Read through the usecase (the encryption extension decrypts): the
        // person is there, server-side, for the intake to compare.
        const stored = await runInTenantContext(ownerCtx(T1), (db) => readStoredSuggestion(db, ownerCtx(T1), agentId));
        expect(stored).toEqual({
            runId,
            status: 'SUGGESTED',
            grade: 'STRONG',
            unmatchedReason: null,
            signals: [
                { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/sug#owners', namesPerson: true },
                { kind: 'TEAM_TAG', evidence: 'entra-sp:servicePrincipals/sug#tags', namesPerson: false },
            ],
            proposedOwnerRef: SUGGESTED_OWNER_CANARY,
        });

        // Read raw (no encryption extension on the test client): ciphertext.
        const raw = await prisma.discoveredAgentAttribution.findFirstOrThrow({ where: { tenantId: T1, discoveredAgentId: agentId } });
        expect(raw.proposedOwnerRef).not.toContain(SUGGESTED_OWNER_CANARY);
        expect(raw.proposedOwnerRef).toMatch(/^v[12]:/);
        expect(raw.signalsJson).toMatch(/^v[12]:/);
        expect(raw.status).toBe('SUGGESTED');

        // Its audit row says what was stored, and never whom it named.
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'AGENT_OWNER_SUGGESTION_RECORDED', entityId: agentId },
            orderBy: { createdAt: 'desc' },
        });
        expect(JSON.stringify(audit.detailsJson)).toContain(runId);
        expect(JSON.stringify(audit)).not.toContain(SUGGESTED_OWNER_CANARY);
    });
});

describe('every other outcome is named and records nothing', () => {
    const agent = () => seeded[T1].discovered['sug-refusals'];

    it.each<[string, () => string, string]>([
        [
            'prose, with no attribution in it',
            () => 'The strongest signal names one person. Propose nobody until it is checked.',
            'NO_ATTRIBUTION_IN_ANSWER',
        ],
        [
            'a LINKED status the contract does not have',
            () => answerText(suggested(agent(), 'jane@example.com', { status: 'LINKED' })),
            'ANSWER_INVALID',
        ],
        [
            'an owner recorded in the answer',
            () => answerText(suggested(agent(), 'jane@example.com', { ownerUserId: seeded[T1].owner })),
            'ANSWER_INVALID',
        ],
        [
            'an answer about another agent than the one the run was asked about',
            () => answerText(suggested(seeded[T1].discovered['sug-matrix'], 'jane@example.com')),
            'ANSWER_FOR_ANOTHER_AGENT',
        ],
    ])('%s', async (_label, text, outcome) => {
        const runId = await reviewRun(T1, agent(), text());
        const before = await storedRows(T1);
        await expect(captureReviewAttribution(ownerCtx(T1), runId)).resolves.toEqual({ outcome, discoveredAgentId: agent() });
        expect(await storedRows(T1)).toBe(before);
    });

    it('a run with no answer on record, and a run still in flight', async () => {
        const silent = await reviewRun(T1, agent(), null);
        await expect(captureReviewAttribution(ownerCtx(T1), silent)).resolves.toMatchObject({ outcome: 'NO_ANSWER' });
        const inFlight = await reviewRun(T1, agent(), answerText(suggested(agent(), 'jane@example.com')), { settle: false });
        await expect(captureReviewAttribution(ownerCtx(T1), inFlight)).resolves.toMatchObject({ outcome: 'RUN_NOT_COMPLETED' });
        // Settled afterwards so it does not count against the tenant's live-run cap.
        await prisma.workflowRun.update({ where: { id: inFlight }, data: { status: 'FAILED', completedAt: new Date() } });
        expect(await prisma.discoveredAgentAttribution.count({ where: { tenantId: T1, discoveredAgentId: agent() } })).toBe(0);
    });

    it('a static run of the review has no model and so no answer, even with a decision row beside it', async () => {
        const { runId, status } = await startWorkflowRun(ownerCtx(T1), KEY, { discoveredAgentId: agent() });
        expect(status).toBe('COMPLETED');
        await recordModelDecision(
            ownerCtx(T1),
            runId,
            discoveredAgentReviewWorkflow,
            'not a model run',
            answerText(suggested(agent(), 'jane@example.com')),
            { tokensIn: 1, tokensOut: 1 },
            'anthropic/claude-review-test',
        );
        await expect(captureReviewAttribution(ownerCtx(T1), runId)).resolves.toMatchObject({ outcome: 'NOT_A_MODEL_RUN' });
        expect(await prisma.discoveredAgentAttribution.count({ where: { tenantId: T1, discoveredAgentId: agent() } })).toBe(0);
    });

    it('an id that is not a review run', async () => {
        await expect(captureReviewAttribution(ownerCtx(T1), 'not-a-run')).resolves.toEqual({
            outcome: 'NOT_A_REVIEW_RUN',
            discoveredAgentId: null,
        });
    });
});

describe('the newest review wins', () => {
    it('a later run replaces the stored answer; an older one never does; a repeat changes nothing', async () => {
        const agentId = seeded[T1].discovered['sug-stale'];
        const older = await reviewRun(T1, agentId, answerText(suggested(agentId, 'first@example.com')), {
            completedAt: new Date('2026-10-18T05:00:00.000Z'),
        });
        const newer = await reviewRun(
            T1,
            agentId,
            answerText({ discoveredAgentId: agentId, status: 'UNMATCHED', reason: 'NO_OWNER_SIGNAL', signals: [] }),
            { completedAt: new Date('2026-10-19T05:00:00.000Z') },
        );

        await expect(captureReviewAttribution(ownerCtx(T1), older)).resolves.toMatchObject({ outcome: 'RECORDED' });
        await expect(captureReviewAttribution(ownerCtx(T1), newer)).resolves.toMatchObject({ outcome: 'RECORDED' });
        await expect(captureReviewAttribution(ownerCtx(T1), older)).resolves.toMatchObject({ outcome: 'SUPERSEDED' });
        await expect(captureReviewAttribution(ownerCtx(T1), newer)).resolves.toMatchObject({ outcome: 'ALREADY_RECORDED' });

        const stored = await runInTenantContext(ownerCtx(T1), (db) => readStoredSuggestion(db, ownerCtx(T1), agentId));
        expect(stored).toMatchObject({ runId: newer, status: 'UNMATCHED', unmatchedReason: 'NO_OWNER_SIGNAL', proposedOwnerRef: null });
    });
});

describe('the shadow list carries the suggestion and no owner reference (#3687)', () => {
    it('shows status, grade, signals and the run on the agent\'s shadow row — and never the person', async () => {
        const agentId = seeded[T1].discovered['sug-matrix'];
        // The canary is really in the stored row (item 1 put it there), so its
        // absence below is the projection working, not the canary missing.
        const stored = await runInTenantContext(ownerCtx(T1), (db) => readStoredSuggestion(db, ownerCtx(T1), agentId));
        expect(stored?.proposedOwnerRef).toBe(SUGGESTED_OWNER_CANARY);

        const view = await getHarnessMatrix(ownerCtx(T1));
        const row = view.shadow.rows.find((r) => r.discoveredAgentId === agentId);
        expect(row?.suggestion).toEqual({
            runId: stored?.runId,
            runCompletedAt: expect.any(String),
            status: 'SUGGESTED',
            grade: 'STRONG',
            unmatchedReason: null,
            signals: [
                { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/sug#owners', namesPerson: true },
                { kind: 'TEAM_TAG', evidence: 'entra-sp:servicePrincipals/sug#tags', namesPerson: false },
            ],
        });
        // A row with nothing stored carries nothing.
        expect(view.shadow.rows.find((r) => r.discoveredAgentId === seeded[T1].discovered['sug-refusals'])?.suggestion).toBeNull();

        const payload = JSON.stringify(view);
        expect(payload).not.toContain(SUGGESTED_OWNER_CANARY);
        expect(payload).not.toContain('proposedOwnerRef');
        expect(payload).not.toContain('personRef');
    });
});

describe('two tenants', () => {
    it('another tenant cannot capture this tenant\'s run, read its suggestion, or see it past RLS', async () => {
        const t1Agent = seeded[T1].discovered['sug-matrix'];
        const t1RunId = (await prisma.discoveredAgentAttribution.findFirstOrThrow({ where: { tenantId: T1, discoveredAgentId: t1Agent } })).runId;

        // Its own suggestion, so the tenant has something to read.
        const t2Agent = seeded[T2].discovered['sug-matrix'];
        const t2Run = await reviewRun(T2, t2Agent, answerText(suggested(t2Agent, 'someone@two.test')));
        await expect(captureReviewAttribution(ownerCtx(T2), t2Run)).resolves.toMatchObject({ outcome: 'RECORDED' });

        // The usecase: T1's run is not a review run T2 has.
        await expect(captureReviewAttribution(ownerCtx(T2), t1RunId)).resolves.toMatchObject({ outcome: 'NOT_A_REVIEW_RUN' });
        // The intake's read: T1's agent has no suggestion in T2.
        await expect(runInTenantContext(ownerCtx(T2), (db) => readStoredSuggestion(db, ownerCtx(T2), t1Agent))).resolves.toBeNull();
        // RLS, with no tenant filter of the caller's own: only T2's rows come back.
        const seen = await runInTenantContext(ownerCtx(T2), (db) =>
            db.discoveredAgentAttribution.findMany({ select: { tenantId: true, runId: true }, take: 50 }),
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((r) => r.tenantId === T2)).toBe(true);

        // The matrix: T2 sees its own suggestion and nothing of T1's.
        const t2View = await getHarnessMatrix(ownerCtx(T2));
        expect(t2View.shadow.rows.find((r) => r.discoveredAgentId === t2Agent)?.suggestion?.runId).toBe(t2Run);
        expect(JSON.stringify(t2View)).not.toContain(t1RunId);
        expect(JSON.stringify(await getHarnessMatrix(ownerCtx(T1)))).not.toContain(t2Run);
    });
});

describe('the intake records the suggestion it was given', () => {
    const intakeBody = (tenantId: string, s: Shadow, over: Record<string, unknown> = {}) => ({
        findingId: seeded[tenantId].shadowFinding[s],
        ownerUserId: seeded[tenantId].owner,
        confirmOwner: true,
        name: `Registered from ${s}`,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ...over,
    });

    it('refuses a run id that is not the stored suggestion, writing nothing', async () => {
        const agentId = seeded[T1].discovered['sug-stale'];
        // Two reviews; the second replaces the first, which the person may still
        // have on screen.
        const first = await reviewRun(T1, agentId, answerText(suggested(agentId, 'first@example.com')), {
            completedAt: new Date('2026-10-20T05:00:00.000Z'),
        });
        const second = await reviewRun(T1, agentId, answerText(suggested(agentId, 'second@example.com')), {
            completedAt: new Date('2026-10-21T05:00:00.000Z'),
        });
        await expect(captureReviewAttribution(ownerCtx(T1), first)).resolves.toMatchObject({ outcome: 'RECORDED' });
        await expect(captureReviewAttribution(ownerCtx(T1), second)).resolves.toMatchObject({ outcome: 'RECORDED' });
        const agentsBefore = await prisma.registeredAgent.count({ where: { tenantId: T1 } });
        const aiSystemsBefore = await prisma.aiSystem.count({ where: { tenantId: T1 } });

        for (const runId of [first, 'run-that-never-was']) {
            await expect(
                registerShadowAgent(ownerCtx(T1), intakeBody(T1, 'sug-stale', { attribution: { runId } })),
            ).rejects.toMatchObject({ details: { reason: 'SUGGESTION_NOT_STORED' } });
        }
        expect(await prisma.registeredAgent.count({ where: { tenantId: T1 } })).toBe(agentsBefore);
        expect(await prisma.aiSystem.count({ where: { tenantId: T1 } })).toBe(aiSystemsBefore);
    });

    it('records the stored suggestion by its run — the comparison made server-side, the person never written', async () => {
        const agentId = seeded[T1].discovered['sug-intake'];
        // The suggestion names the owner by e-mail, which the intake compares
        // against the confirmed owner's lookup hash.
        const ownerEmail = emails(T1)[0];
        const runId = await reviewRun(T1, agentId, answerText(suggested(agentId, ownerEmail)));
        await expect(captureReviewAttribution(ownerCtx(T1), runId)).resolves.toMatchObject({ outcome: 'RECORDED' });

        const result = await registerShadowAgent(ownerCtx(T1), intakeBody(T1, 'sug-intake', { attribution: { runId } }));
        expect(result.ownerUserId).toBe(seeded[T1].owner);
        expect(result.suggestion).toEqual({
            status: 'SUGGESTED',
            grade: 'STRONG',
            unmatchedReason: null,
            signals: [
                { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/sug#owners', namesPerson: true },
                { kind: 'TEAM_TAG', evidence: 'entra-sp:servicePrincipals/sug#tags', namesPerson: false },
            ],
            confirmedOwnerIsSuggested: true,
            runId,
        });

        // The register row's owner is the confirmed person, and its audit row
        // records the suggestion with its run — and not the address it named.
        const agent = await prisma.registeredAgent.findFirstOrThrow({ where: { tenantId: T1, intakeDiscoveredAgentId: agentId } });
        expect(agent.ownerUserId).toBe(seeded[T1].owner);
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'AGENT_REGISTERED', entityId: agent.id },
        });
        const details = audit.detailsJson as { after?: { ownerSuggestion?: Record<string, unknown> } };
        expect(details.after?.ownerSuggestion).toMatchObject({ status: 'SUGGESTED', grade: 'STRONG', confirmedOwnerIsSuggested: true, runId });
        expect(JSON.stringify(audit.detailsJson)).not.toContain(ownerEmail);
    });
});

describe('the settlement seam calls the capture', () => {
    it('a review run that completes through the engine is handed to the capture, which names why it stored nothing', async () => {
        const hook = jest.mocked(captureReviewAttributionAfterRun);
        hook.mockClear();
        const agentId = seeded[T1].discovered['sug-refusals'];
        // The static engine completes the run in-process, through executeFrom.
        const { runId, status } = await startWorkflowRun(ownerCtx(T1), KEY, { discoveredAgentId: agentId });
        expect(status).toBe('COMPLETED');
        expect(hook).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1 }), runId, KEY, 'COMPLETED');
        await expect(hook.mock.results[0].value).resolves.toMatchObject({ outcome: 'NOT_A_MODEL_RUN' });
    });
});
