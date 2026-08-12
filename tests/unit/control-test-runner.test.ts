/**
 * Epic G-2 — Control Test Runner unit tests.
 *
 * Pure-memory tests of the runner's three branches:
 *   • plan-not-found / plan-paused short-circuits
 *   • MANUAL → PLANNED run + auto-evidence + ControlTestEvidenceLink
 *   • SCRIPT/INTEGRATION (handler seam) → COMPLETED run; on FAIL,
 *     a Finding is created and bridged to the run's evidence
 *
 * Prisma, the audit/event emitters, the logger, and the
 * runJob/runInTenantContext observability helpers are mocked so
 * the test runs in pure memory.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

// db argument for runInTenantContext is the mock prismaTx — same
// surface the runner pokes (controlTestPlan/findFirst is direct,
// the rest go through the transaction handle).
const mockTx = {
    controlTestRun: {
        update: jest.fn(),
    },
    evidence: {
        create: jest.fn(),
    },
    evidenceControlLink: {
        create: jest.fn(),
    },
    findingEvidence: {
        create: jest.fn(),
    },
    auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
        // Some logEvent paths read the latest entry for hash chaining.
        findFirst: jest.fn().mockResolvedValue(null),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn(mockTx),
    ),
}));

const mockPlanFindFirst = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        controlTestPlan: {
            findFirst: (...args: unknown[]) => mockPlanFindFirst(...args),
        },
    },
}));

// Repositories
const mockTestRunCreate = jest.fn();
const mockTestRunComplete = jest.fn();
jest.mock('@/app-layer/repositories/TestRunRepository', () => ({
    TestRunRepository: {
        create: (...args: unknown[]) => mockTestRunCreate(...args),
        complete: (...args: unknown[]) => mockTestRunComplete(...args),
    },
}));

const mockTestEvidenceLink = jest.fn();
jest.mock('@/app-layer/repositories/TestEvidenceRepository', () => ({
    TestEvidenceRepository: {
        link: (...args: unknown[]) => mockTestEvidenceLink(...args),
    },
}));

const mockFindingCreate = jest.fn();
jest.mock('@/app-layer/repositories/FindingRepository', () => ({
    FindingRepository: {
        create: (...args: unknown[]) => mockFindingCreate(...args),
    },
}));

// PR-P — the runner now stamps effectiveness parity on the handler-completion
// path (attestControlTested + updateNextDueAt), mirroring completeTestRun.
const mockUpdateNextDueAt = jest.fn();
jest.mock('@/app-layer/repositories/TestPlanRepository', () => ({
    TestPlanRepository: {
        updateNextDueAt: (...args: unknown[]) => mockUpdateNextDueAt(...args),
    },
}));

const mockAttestControlTested = jest.fn();
jest.mock('@/app-layer/usecases/control', () => ({
    attestControlTested: (...args: unknown[]) => mockAttestControlTested(...args),
    // PR-CC — the runner gates the attestation + cadence roll on a real
    // verdict. This predicate is pure, so the mock uses the REAL rule rather
    // than a stub: a fake that always returned true would hide the very bug
    // the gate exists to prevent (a handler crash coerced to INCONCLUSIVE
    // marking the control "tested & on-schedule").
    isAttestingVerdict: (result: unknown) => result === 'PASS' || result === 'FAIL',
}));

// Events
const mockEmitTestRunCreated = jest.fn();
const mockEmitTestRunCompleted = jest.fn();
const mockEmitTestRunFailed = jest.fn();
jest.mock('@/app-layer/events/test.events', () => ({
    emitTestRunCreated: (...args: unknown[]) => mockEmitTestRunCreated(...args),
    emitTestRunCompleted: (...args: unknown[]) => mockEmitTestRunCompleted(...args),
    emitTestRunFailed: (...args: unknown[]) => mockEmitTestRunFailed(...args),
}));

// Audit
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

// Permissions — the system context build needs this; return a
// minimal PermissionSet shape that satisfies the runner's call
// signature without dragging in the full permission graph.
jest.mock('@/lib/permissions', () => ({
    getPermissionsForRole: jest.fn().mockReturnValue({
        controls: { canRead: true, canWrite: true },
        risks: { canRead: true, canWrite: true },
    }),
}));

// ─── Imports ───────────────────────────────────────────────────────

import {
    runControlTestRunner,
    runnerHandlerRegistry,
} from '@/app-layer/jobs/control-test-runner';

// ─── Helpers ───────────────────────────────────────────────────────

const SCHEDULED_FOR = '2026-05-05T12:00:00.000Z';
const SCHEDULED_FOR_DATE = new Date(SCHEDULED_FOR);
const PAYLOAD_BASE = {
    tenantId: 'tenant-1',
    testPlanId: 'plan-1',
    scheduledForIso: SCHEDULED_FOR,
    schedulerJobRunId: 'sched-job-1',
};

function makePlan(overrides: Partial<{
    automationType: 'MANUAL' | 'SCRIPT' | 'INTEGRATION';
    status: string;
    automationConfig: unknown;
    schedule: string | null;
}> = {}) {
    return {
        id: 'plan-1',
        tenantId: 'tenant-1',
        controlId: 'ctrl-1',
        name: 'Quarterly access review',
        schedule: 'schedule' in overrides ? overrides.schedule! : '0 9 * * MON',
        frequency: 'QUARTERLY',
        automationType: overrides.automationType ?? 'MANUAL',
        automationConfig: overrides.automationConfig ?? null,
        status: overrides.status ?? 'ACTIVE',
        createdByUserId: 'user-creator',
        ownerUserId: 'user-owner',
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    runnerHandlerRegistry._reset();
    mockTestRunCreate.mockReset();
    mockTestRunComplete.mockReset();
    mockTestEvidenceLink.mockReset();
    mockFindingCreate.mockReset();
    mockUpdateNextDueAt.mockReset();
    mockAttestControlTested.mockReset();
    mockPlanFindFirst.mockReset();
    mockTx.controlTestRun.update.mockReset();
    mockTx.evidence.create.mockReset();
    mockTx.evidenceControlLink.create.mockReset();
    mockTx.findingEvidence.create.mockReset();
});

// ─── 1. Defensive short-circuits ───────────────────────────────────

describe('runControlTestRunner — defensive short-circuits', () => {
    test('returns SKIPPED when the plan no longer exists', async () => {
        mockPlanFindFirst.mockResolvedValueOnce(null);

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runStatus: 'SKIPPED',
            runResult: null,
            evidenceAttached: false,
            findingCreated: false,
            skipReason: 'plan_not_found',
        });
        expect(mockTestRunCreate).not.toHaveBeenCalled();
    });

    test('returns SKIPPED when the plan is PAUSED', async () => {
        mockPlanFindFirst.mockResolvedValueOnce(makePlan({ status: 'PAUSED' }));

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runStatus: 'SKIPPED',
            skipReason: 'plan_inactive',
        });
        expect(mockTestRunCreate).not.toHaveBeenCalled();
    });
});

// ─── 2. MANUAL branch ─────────────────────────────────────────────

describe('runControlTestRunner — MANUAL plan', () => {
    test('creates PLANNED run, attaches auto-evidence, no Finding', async () => {
        mockPlanFindFirst.mockResolvedValueOnce(makePlan({ automationType: 'MANUAL' }));
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runId: 'run-1',
            runStatus: 'PLANNED',
            runResult: null,
            evidenceAttached: true,
            evidenceId: 'ev-1',
            findingCreated: false,
        });

        // Run created with the right plan + control linkage.
        expect(mockTestRunCreate).toHaveBeenCalledTimes(1);
        const runCallArgs = mockTestRunCreate.mock.calls[0][2];
        expect(runCallArgs).toEqual({
            testPlanId: 'plan-1',
            controlId: 'ctrl-1',
        });

        // Run NOT completed (MANUAL stays PLANNED for human review).
        expect(mockTestRunComplete).not.toHaveBeenCalled();

        // Run is annotated with the auto-schedule note so the
        // existing UI lists it as scheduler-instantiated.
        expect(mockTx.controlTestRun.update).toHaveBeenCalledTimes(1);
        const note = mockTx.controlTestRun.update.mock.calls[0][0].data.notes;
        expect(note).toContain('[Auto-scheduled by Epic G-2');
        expect(note).toContain(SCHEDULED_FOR);

        // EP-3 — the Evidence row no longer carries a singular controlId.
        // The control association is a separate EvidenceControlLink join
        // row; that link is the load-bearing edge for the
        // Finding-via-FindingEvidence chain even though MANUAL doesn't
        // create a Finding today.
        expect(mockTx.evidence.create).toHaveBeenCalledTimes(1);
        const evData = mockTx.evidence.create.mock.calls[0][0].data;
        expect(evData).toMatchObject({
            tenantId: 'tenant-1',
            type: 'TEXT',
            status: 'APPROVED',
            category: 'integration',
        });
        expect(evData).not.toHaveProperty('controlId');
        expect(evData.title).toContain('Quarterly access review');
        expect(evData.content).toContain('Awaiting manual completion');

        // The control link is written via the EvidenceControlLink join,
        // carrying the evidence id + the plan's controlId.
        expect(mockTx.evidenceControlLink.create).toHaveBeenCalledTimes(1);
        const linkData = mockTx.evidenceControlLink.create.mock.calls[0][0].data;
        expect(linkData).toMatchObject({
            tenantId: 'tenant-1',
            evidenceId: 'ev-1',
            controlId: 'ctrl-1',
        });

        // Evidence is linked to the run via the existing
        // ControlTestEvidenceLink shape.
        expect(mockTestEvidenceLink).toHaveBeenCalledTimes(1);
        const linkArgs = mockTestEvidenceLink.mock.calls[0][2];
        expect(linkArgs).toMatchObject({
            testRunId: 'run-1',
            kind: 'EVIDENCE',
            evidenceId: 'ev-1',
        });
    });

    test('emits TEST_RUN_CREATED but not TEST_RUN_COMPLETED', async () => {
        mockPlanFindFirst.mockResolvedValueOnce(makePlan({ automationType: 'MANUAL' }));
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        await runControlTestRunner(PAYLOAD_BASE);

        expect(mockEmitTestRunCreated).toHaveBeenCalledTimes(1);
        expect(mockEmitTestRunCompleted).not.toHaveBeenCalled();
        expect(mockEmitTestRunFailed).not.toHaveBeenCalled();
    });
});

// ─── 3. SCRIPT/INTEGRATION with no handler → PLANNED awaiting (PR-P) ─

describe('runControlTestRunner — SCRIPT/INTEGRATION without handler', () => {
    test('creates a PLANNED "awaiting manual completion" run, NOT an INCONCLUSIVE no-op', async () => {
        // PR-P — no execution engine is registered, so a scheduled SCRIPT plan
        // must NOT complete as a jargon INCONCLUSIVE no-op (which polluted the
        // pass-rate and showed raw "no handler" text as evidence). Instead it
        // delegates to the MANUAL path: the run stays PLANNED "awaiting manual
        // completion" and never reaches COMPLETED, so it never enters the
        // effectiveness denominator.
        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({ automationType: 'SCRIPT' }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runStatus: 'PLANNED',
            runResult: null,
            evidenceAttached: true,
            findingCreated: false,
        });

        // The run is NEVER completed — no verdict is fabricated.
        expect(mockTestRunComplete).not.toHaveBeenCalled();
        expect(mockEmitTestRunCompleted).not.toHaveBeenCalled();
        expect(mockEmitTestRunFailed).not.toHaveBeenCalled();

        // No effectiveness side-effects — the control is not attested and the
        // plan cadence is not rolled until a human actually completes the run.
        expect(mockAttestControlTested).not.toHaveBeenCalled();
        expect(mockUpdateNextDueAt).not.toHaveBeenCalled();

        // The run is annotated "awaiting manual completion" (the manual path).
        expect(mockTx.controlTestRun.update).toHaveBeenCalledTimes(1);
        const updateArgs = mockTx.controlTestRun.update.mock.calls[0][0];
        expect(updateArgs.data.notes).toContain('Awaiting manual completion');

        // Evidence no longer carries raw "no handler registered" jargon.
        const evData = mockTx.evidence.create.mock.calls[0][0].data;
        expect(evData.content).not.toContain('No automation handler is registered');
    });
});

// ─── 4. SCRIPT branch — registered handler returns PASS ────────────

describe('runControlTestRunner — SCRIPT handler PASS', () => {
    test('completes run with PASS, attaches handler-supplied evidence, no Finding', async () => {
        runnerHandlerRegistry.register('SCRIPT', async () => ({
            result: 'PASS',
            evidenceTitle: 'IAM password policy check',
            evidenceContent: 'minLength=14 ✓ history=24 ✓ rotation=90d ✓',
            notes: 'All assertions passed.',
        }));

        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({ automationType: 'SCRIPT' }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runStatus: 'COMPLETED',
            runResult: 'PASS',
            evidenceAttached: true,
            findingCreated: false,
        });

        const evData = mockTx.evidence.create.mock.calls[0][0].data;
        expect(evData.title).toBe('IAM password policy check');
        expect(evData.content).toContain('minLength=14');

        expect(mockFindingCreate).not.toHaveBeenCalled();
        expect(mockTx.findingEvidence.create).not.toHaveBeenCalled();
        expect(mockEmitTestRunFailed).not.toHaveBeenCalled();

        // PR-P — effectiveness parity with the manual completeTestRun path: a
        // completed automated run stamps Control.lastTested (attestControlTested)
        // and rolls the plan cadence (updateNextDueAt). Without these, an
        // automated run would move the pass-rate while lastTested + cadence
        // went stale.
        expect(mockAttestControlTested).toHaveBeenCalledTimes(1);
        expect(mockAttestControlTested.mock.calls[0][2]).toBe('ctrl-1');
        expect(mockUpdateNextDueAt).toHaveBeenCalledTimes(1);
        expect(mockUpdateNextDueAt.mock.calls[0][2]).toBe('plan-1');
    });
});

// ─── 5. SCRIPT branch — registered handler returns FAIL → Finding ─

describe('runControlTestRunner — SCRIPT handler FAIL', () => {
    test('creates Finding bridged via FindingEvidence to the run evidence', async () => {
        runnerHandlerRegistry.register('SCRIPT', async () => ({
            result: 'FAIL',
            evidenceTitle: 'IAM password policy check',
            evidenceContent: 'minLength=8 ✗ (expected 14+)',
            notes: 'Password policy minimum length is below the standard.',
            findingSummary: 'Password minLength=8 is below the SOC 2 baseline of 14.',
        }));

        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({ automationType: 'SCRIPT' }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });
        mockFindingCreate.mockResolvedValueOnce({
            id: 'finding-1',
            title: 'Test failed: Quarterly access review',
        });

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runStatus: 'COMPLETED',
            runResult: 'FAIL',
            evidenceAttached: true,
            evidenceId: 'ev-1',
            findingCreated: true,
            findingId: 'finding-1',
        });

        // Finding shape — title carries plan name; description
        // pulled from findingSummary; severity defaults HIGH.
        expect(mockFindingCreate).toHaveBeenCalledTimes(1);
        const findingArgs = mockFindingCreate.mock.calls[0][2];
        expect(findingArgs).toMatchObject({
            title: 'Test failed: Quarterly access review',
            description: expect.stringContaining('SOC 2 baseline of 14'),
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            status: 'OPEN',
        });

        // Bridge — FindingEvidence links the new Finding to the
        // evidence row that carries controlId (the run's auto-
        // evidence). This is the codebase's pattern for Finding
        // → Control linkage since Finding has no direct controlId.
        expect(mockTx.findingEvidence.create).toHaveBeenCalledTimes(1);
        const bridgeArgs = mockTx.findingEvidence.create.mock.calls[0][0].data;
        expect(bridgeArgs).toEqual({
            tenantId: 'tenant-1',
            findingId: 'finding-1',
            evidenceId: 'ev-1',
        });

        // TEST_RUN_FAILED event emitted in addition to TEST_RUN_COMPLETED.
        expect(mockEmitTestRunCompleted).toHaveBeenCalledTimes(1);
        expect(mockEmitTestRunFailed).toHaveBeenCalledTimes(1);
    });

    test('honours handler-supplied severity override', async () => {
        runnerHandlerRegistry.register('SCRIPT', async () => ({
            result: 'FAIL',
            evidenceTitle: 't',
            evidenceContent: 'c',
            findingSeverity: 'CRITICAL',
        }));
        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({ automationType: 'SCRIPT' }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });
        mockFindingCreate.mockResolvedValueOnce({
            id: 'finding-1',
            title: 'x',
        });

        await runControlTestRunner(PAYLOAD_BASE);

        const findingArgs = mockFindingCreate.mock.calls[0][2];
        expect(findingArgs.severity).toBe('CRITICAL');
    });
});

// ─── 6. SCRIPT branch — handler throws ─────────────────────────────

describe('runControlTestRunner — SCRIPT handler throws', () => {
    test('handler error becomes INCONCLUSIVE, not FAIL (no Finding)', async () => {
        runnerHandlerRegistry.register('SCRIPT', async () => {
            throw new Error('Connection refused');
        });
        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({ automationType: 'SCRIPT' }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        const result = await runControlTestRunner(PAYLOAD_BASE);

        // Handler errors are infrastructure failures, not control
        // failures — INCONCLUSIVE keeps the run auditable without
        // mis-attributing a control gap. No Finding is opened.
        expect(result.runResult).toBe('INCONCLUSIVE');
        expect(result.findingCreated).toBe(false);

        const evData = mockTx.evidence.create.mock.calls[0][0].data;
        expect(evData.content).toContain('Handler raised: Connection refused');
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('handler threw'),
            expect.objectContaining({ planId: 'plan-1' }),
        );
    });
});

// ─── 7. System context attribution ─────────────────────────────────

describe('runControlTestRunner — system actor context', () => {
    test('TestRunRepository.create is called with plan.createdByUserId as the actor', async () => {
        mockPlanFindFirst.mockResolvedValueOnce(makePlan());
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        await runControlTestRunner(PAYLOAD_BASE);

        // The 2nd arg to TestRunRepository.create is the ctx. The plan
        // author stays the userId so audit entries attribute automated
        // runs to the person whose plan it is rather than a missing /
        // impersonated actor — that part is unchanged and deliberate.
        //
        // B2-1c added the half that was missing: `actorType: 'JOB'`, so
        // the row says the SCHEDULER ran the test attributed to the
        // author, instead of reading as though the author ran it. Both
        // halves are asserted together — dropping either one puts the
        // trail back to naming a person for machine work.
        const ctxArg = mockTestRunCreate.mock.calls[0][1];
        expect(ctxArg).toMatchObject({
            tenantId: 'tenant-1',
            userId: 'user-creator',
            requestId: 'sched-job-1',
            role: 'ADMIN',
            actorType: 'JOB',
        });
    });
});

// ─── 8. INTEGRATION branch is functionally identical ──────────────

describe('runControlTestRunner — INTEGRATION uses the same handler seam', () => {
    test('INTEGRATION handler PASS produces a COMPLETED run with PASS', async () => {
        runnerHandlerRegistry.register('INTEGRATION', async () => ({
            result: 'PASS',
            evidenceTitle: 'AWS IAM check',
            evidenceContent: 'OK',
        }));
        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({ automationType: 'INTEGRATION' }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        const result = await runControlTestRunner(PAYLOAD_BASE);

        expect(result).toMatchObject({
            runStatus: 'COMPLETED',
            runResult: 'PASS',
            evidenceAttached: true,
        });
    });

    test('handler input carries plan id, control id, and parsed scheduledFor', async () => {
        const seenInput = jest.fn();
        runnerHandlerRegistry.register('INTEGRATION', async (input) => {
            seenInput(input);
            return { result: 'PASS', evidenceContent: 'ok' };
        });
        mockPlanFindFirst.mockResolvedValueOnce(
            makePlan({
                automationType: 'INTEGRATION',
                automationConfig: { connectorId: 'aws-1' },
            }),
        );
        mockTestRunCreate.mockResolvedValueOnce({ id: 'run-1' });
        mockTx.evidence.create.mockResolvedValueOnce({ id: 'ev-1' });

        await runControlTestRunner(PAYLOAD_BASE);

        expect(seenInput).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            planId: 'plan-1',
            controlId: 'ctrl-1',
            automationType: 'INTEGRATION',
            automationConfig: { connectorId: 'aws-1' },
            scheduledFor: SCHEDULED_FOR_DATE,
        });
    });
});
