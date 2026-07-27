/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/control-test.ts
 *
 * Wave 5 of GAP-02. The control-test usecase orchestrates test
 * plans, test runs, and the FAIL → CONTROL_GAP task fan-out.
 * Three load-bearing invariants:
 *
 *   1. RBAC separation: read / manage-plans / execute-tests / link-
 *      evidence are distinct gates; mixing them up gives an EDITOR
 *      the ability to mark "PASS" without owning the plan.
 *   2. Epic D.2 sanitisation: name + description + step instructions
 *      + step expected outputs + notes + findingSummary all surface
 *      in the audit-pack PDF that goes to external auditors. A
 *      sanitiser regression is a stored-XSS regression that audit
 *      teams CANNOT see in normal UI.
 *   3. FAIL → CONTROL_GAP task creation is best-effort: a task-create
 *      failure must NOT roll back the test-run completion.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/TestPlanRepository', () => ({
    TestPlanRepository: {
        listByControl: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateNextDueAt: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/TestRunRepository', () => ({
    TestRunRepository: {
        getById: jest.fn(),
        create: jest.fn(),
        complete: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/TestEvidenceRepository', () => ({
    TestEvidenceRepository: {
        listByRun: jest.fn(),
        link: jest.fn(),
        unlink: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('@/app-layer/utils/cadence', () => ({
    computeNextDueAt: jest.fn(() => new Date('2026-12-31T00:00:00Z')),
}));

jest.mock('@/app-layer/usecases/task', () => ({
    createTask: jest.fn().mockResolvedValue({ id: 'task-1' }),
}));

jest.mock('@/app-layer/events/test.events', () => ({
    emitTestPlanCreated: jest.fn().mockResolvedValue(undefined),
    emitTestPlanUpdated: jest.fn().mockResolvedValue(undefined),
    emitTestPlanStatusChanged: jest.fn().mockResolvedValue(undefined),
    emitTestRunCreated: jest.fn().mockResolvedValue(undefined),
    emitTestRunCompleted: jest.fn().mockResolvedValue(undefined),
    emitTestRunFailed: jest.fn().mockResolvedValue(undefined),
    emitTestEvidenceLinked: jest.fn().mockResolvedValue(undefined),
    emitTestEvidenceUnlinked: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createTestPlan,
    updateTestPlan,
    createTestRun,
    completeTestRun,
    retestFromRun,
    linkEvidenceToRun,
    unlinkEvidenceFromRun,
    createAutomatedTestRun,
} from '@/app-layer/usecases/control-test';
import { runInTenantContext } from '@/lib/db-context';
import { TestPlanRepository } from '@/app-layer/repositories/TestPlanRepository';
import { TestRunRepository } from '@/app-layer/repositories/TestRunRepository';
import { TestEvidenceRepository } from '@/app-layer/repositories/TestEvidenceRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createTask } from '@/app-layer/usecases/task';
import {
    emitTestRunCompleted,
    emitTestRunFailed,
    emitTestPlanStatusChanged,
} from '@/app-layer/events/test.events';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockPlanCreate = TestPlanRepository.create as jest.MockedFunction<typeof TestPlanRepository.create>;
const mockPlanGetById = TestPlanRepository.getById as jest.MockedFunction<typeof TestPlanRepository.getById>;
const mockPlanUpdate = TestPlanRepository.update as jest.MockedFunction<typeof TestPlanRepository.update>;
const mockRunCreate = TestRunRepository.create as jest.MockedFunction<typeof TestRunRepository.create>;
const mockRunGetById = TestRunRepository.getById as jest.MockedFunction<typeof TestRunRepository.getById>;
const mockRunComplete = TestRunRepository.complete as jest.MockedFunction<typeof TestRunRepository.complete>;
const mockEvidenceLink = TestEvidenceRepository.link as jest.MockedFunction<typeof TestEvidenceRepository.link>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockCreateTask = createTask as jest.MockedFunction<typeof createTask>;
const mockEmitRunCompleted = emitTestRunCompleted as jest.MockedFunction<typeof emitTestRunCompleted>;
const mockEmitRunFailed = emitTestRunFailed as jest.MockedFunction<typeof emitTestRunFailed>;
const mockEmitPlanStatusChanged = emitTestPlanStatusChanged as jest.MockedFunction<typeof emitTestPlanStatusChanged>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockPlanCreate.mockResolvedValue({ id: 'plan-1', name: 'SANITISED(Plan)', controlId: 'c1' } as never);
    mockPlanUpdate.mockResolvedValue({ id: 'plan-1' } as never);
    mockRunCreate.mockResolvedValue({ id: 'run-1', testPlanId: 'plan-1', controlId: 'c1' } as never);
    mockRunComplete.mockResolvedValue({ id: 'run-1' } as never);
});

describe('createTestPlan — Epic D.2 sanitisation', () => {
    it('rejects READER (canManageTestPlans gate)', async () => {
        await expect(
            createTestPlan(makeRequestContext('READER'), 'c1', { name: 'X' }),
        ).rejects.toThrow();
    });

    it('rejects AUDITOR — auditors view but cannot manage', async () => {
        await expect(
            createTestPlan(makeRequestContext('AUDITOR'), 'c1', { name: 'X' }),
        ).rejects.toThrow();
    });

    it('sanitises name + description + every step instruction + every step expectedOutput', async () => {
        // createTestPlan now validates the path controlId in-tenant before
        // stamping — the mock db must resolve it.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ control: { findFirst: async () => ({ id: 'c1' }) } } as never),
        );

        await createTestPlan(makeRequestContext('EDITOR'), 'c1', {
            name: '<b>Plan A</b>',
            description: '<script>x</script>',
            steps: [
                { instruction: '<img onerror=...>', expectedOutput: 'output' },
                { instruction: 'plain', expectedOutput: null },
            ],
        });

        const repoArgs = mockPlanCreate.mock.calls[0][3] as any;
        // Regression: a refactor that dropped the steps[].map sanitiser
        // would persist raw HTML in step instructions. Step
        // instructions surface verbatim in the audit-pack PDF that
        // external auditors open — a stored-XSS payload there is the
        // worst possible carrier.
        expect(repoArgs.name).toBe('SANITISED(<b>Plan A</b>)');
        expect(repoArgs.description).toBe('SANITISED(<script>x</script>)');
        expect(repoArgs.steps[0].instruction).toBe('SANITISED(<img onerror=...>)');
        expect(repoArgs.steps[0].expectedOutput).toBe('SANITISED(output)');
        expect(repoArgs.steps[1].instruction).toBe('SANITISED(plain)');
        // null expectedOutput must stay null — sanitisation does not
        // turn an explicit null into the empty string.
        expect(repoArgs.steps[1].expectedOutput).toBeNull();
    });
});

describe('updateTestPlan — sanitizeOptional + status-change emit', () => {
    it('emits TEST_PLAN_STATUS_CHANGED only when status actually changes', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockPlanGetById.mockResolvedValueOnce({
            id: 'plan-1', status: 'ACTIVE', frequency: 'MONTHLY',
        } as never);

        await updateTestPlan(makeRequestContext('EDITOR'), 'plan-1', {
            status: 'PAUSED',
        });

        expect(mockEmitPlanStatusChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'plan-1',
            'ACTIVE',
            'PAUSED',
        );
    });

    it('does NOT emit status-change when status is unchanged', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockPlanGetById.mockResolvedValueOnce({
            id: 'plan-1', status: 'ACTIVE', frequency: 'MONTHLY',
        } as never);

        await updateTestPlan(makeRequestContext('EDITOR'), 'plan-1', {
            description: 'updated',
        });

        expect(mockEmitPlanStatusChanged).not.toHaveBeenCalled();
    });

    it('throws notFound when the plan does not exist', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockPlanGetById.mockResolvedValueOnce(null as never);

        await expect(
            updateTestPlan(makeRequestContext('EDITOR'), 'missing', { name: 'X' }),
        ).rejects.toThrow(/Test plan not found/);
    });
});

describe('createTestRun — gating', () => {
    it('rejects READER (canExecuteTests)', async () => {
        await expect(
            createTestRun(makeRequestContext('READER'), 'plan-1'),
        ).rejects.toThrow();
    });

    it('rejects creating a run for a non-ACTIVE plan', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockPlanGetById.mockResolvedValueOnce({
            id: 'plan-1', status: 'PAUSED', controlId: 'c1',
        } as never);

        await expect(
            createTestRun(makeRequestContext('EDITOR'), 'plan-1'),
        ).rejects.toThrow(/paused test plan/);
        // Regression: allowing runs on PAUSED plans would obscure
        // when a control test was actually performed — the test
        // could appear "current" while the plan was deliberately
        // benched mid-revision.
        expect(mockRunCreate).not.toHaveBeenCalled();
    });
});

describe('completeTestRun — sanitisation + FAIL fan-out', () => {
    function setupRun(status: string, planFreq = 'MONTHLY') {
        // R2-P2 — completeTestRun now attests the control (db.control
        // findFirst + update) on completion, so the fake db must carry it.
        // R4-P3 #3 — the FAIL CONTROL_GAP spawn moved POST-COMMIT, so it opens
        // its own runInTenantContext(s) after the completion tx (idempotency
        // read via `task.findFirst`, plus a best-effort error-log tx). Use a
        // persistent implementation (not `...Once`) so every one of those calls
        // sees the same fake db.
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn({
            control: {
                findFirst: jest.fn().mockResolvedValue({ id: 'c1', frequency: 'MONTHLY', applicability: 'APPLICABLE' }),
                update: jest.fn().mockResolvedValue({ id: 'c1' }),
            },
            // FAIL-spawn idempotency guard (hasOpenGapTask) queries for an
            // existing open gap task first; null → no dup → createTask fires.
            task: { findFirst: jest.fn().mockResolvedValue(null) },
        } as never));
        mockRunGetById.mockResolvedValueOnce({
            id: 'run-1',
            testPlanId: 'plan-1',
            controlId: 'c1',
            status,
            testPlan: {
                id: 'plan-1',
                name: 'Plan A',
                frequency: planFreq,
                ownerUserId: 'owner-1',
            },
        } as never);
    }

    it('rejects already-completed runs', async () => {
        setupRun('COMPLETED');

        await expect(
            completeTestRun(makeRequestContext('EDITOR'), 'run-1', {
                result: 'PASS',
            }),
        ).rejects.toThrow(/already completed/);
        expect(mockRunComplete).not.toHaveBeenCalled();
    });

    it('sanitises notes + findingSummary BEFORE persistence and event emit', async () => {
        setupRun('PLANNED');

        await completeTestRun(makeRequestContext('EDITOR'), 'run-1', {
            result: 'PASS',
            notes: '<script>n</script>',
            findingSummary: '<img>',
        });

        const completeArgs = mockRunComplete.mock.calls[0][3] as any;
        expect(completeArgs.notes).toBe('SANITISED(<script>n</script>)');
        expect(completeArgs.findingSummary).toBe('SANITISED(<img>)');
    });

    it('on FAIL: creates a CONTROL_GAP task with sanitised content', async () => {
        setupRun('PLANNED');

        await completeTestRun(makeRequestContext('EDITOR'), 'run-1', {
            result: 'FAIL',
            findingSummary: '<script>fail-detail</script>',
        });

        expect(mockEmitRunFailed).toHaveBeenCalled();
        expect(mockCreateTask).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'CONTROL_GAP',
                severity: 'HIGH',
                priority: 'P1',
                controlId: 'c1',
                description: 'SANITISED(<script>fail-detail</script>)',
            }),
        );
    });

    it('on FAIL: a task-create failure does NOT roll back the test-run completion (fire-and-forget)', async () => {
        setupRun('PLANNED');
        mockCreateTask.mockRejectedValueOnce(new Error('task service down'));

        const result = await completeTestRun(
            makeRequestContext('EDITOR'),
            'run-1',
            { result: 'FAIL', findingSummary: 'Something broke' },
        );

        // Regression: a refactor that bubbled the task-create error
        // would corrupt the audit trail — the run shows as completed
        // in the DB but the API call returns a 500, leaving the
        // operator confused about whether the test passed or failed.
        expect(result).toBeDefined();
        expect(mockRunComplete).toHaveBeenCalled();
        // The failure logs an audit row so it's not silent.
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'TEST_RUN_TASK_CREATION_FAILED' }),
        );
    });

    it('on PASS: does NOT emit FAIL event AND does NOT create a CONTROL_GAP task', async () => {
        setupRun('PLANNED');

        await completeTestRun(makeRequestContext('EDITOR'), 'run-1', {
            result: 'PASS',
        });

        expect(mockEmitRunFailed).not.toHaveBeenCalled();
        expect(mockCreateTask).not.toHaveBeenCalled();
        expect(mockEmitRunCompleted).toHaveBeenCalled();
    });
});

describe('retestFromRun', () => {
    it('rejects retest from a non-completed run', async () => {
        const fakeDb = {
            controlTestRun: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'run-1',
                    status: 'PLANNED',
                    testPlan: { id: 'plan-1', controlId: 'c1', status: 'ACTIVE' },
                }),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await expect(
            retestFromRun(makeRequestContext('EDITOR'), 'run-1'),
        ).rejects.toThrow(/completed run/);
    });
});

describe('linkEvidenceToRun', () => {
    it('rejects READER (canLinkTestEvidence)', async () => {
        await expect(
            linkEvidenceToRun(makeRequestContext('READER'), 'run-1', {
                kind: 'FILE',
                fileId: 'f1',
            }),
        ).rejects.toThrow();
    });

    it('throws notFound when the test run does not exist', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockRunGetById.mockResolvedValueOnce(null as never);

        await expect(
            linkEvidenceToRun(makeRequestContext('EDITOR'), 'missing', {
                kind: 'FILE',
                fileId: 'f1',
            }),
        ).rejects.toThrow(/Test run not found/);
        expect(mockEvidenceLink).not.toHaveBeenCalled();
    });
});

describe('unlinkEvidenceFromRun — tenant-scoped lookup', () => {
    it('throws notFound on cross-tenant link id', async () => {
        const fakeDb = {
            controlTestEvidenceLink: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await expect(
            unlinkEvidenceFromRun(makeRequestContext('EDITOR'), 'tenant-B-run', 'tenant-B-link'),
        ).rejects.toThrow(/Evidence link not found/);
        // Regression: a refactor that skipped the tenant check would
        // let an EDITOR in tenant A unlink an evidence row in tenant B
        // by ID. The TestEvidenceRepository.unlink might not enforce
        // the tenant filter on its own.
    });
});

describe('createAutomatedTestRun', () => {
    it('on FAIL: creates the same CONTROL_GAP task as the manual path', async () => {
        // Fake db carries `control` for the R2-P2 attest-on-completion write.
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({
            control: {
                findFirst: jest.fn().mockResolvedValue({ id: 'c1', frequency: 'WEEKLY', applicability: 'APPLICABLE' }),
                update: jest.fn().mockResolvedValue({ id: 'c1' }),
            },
            // FAIL-spawn idempotency guard — null → no dup → createTask fires.
            task: { findFirst: jest.fn().mockResolvedValue(null) },
        } as never));
        mockPlanGetById.mockResolvedValueOnce({
            id: 'plan-1',
            name: 'Auto Plan',
            controlId: 'c1',
            frequency: 'WEEKLY',
            ownerUserId: 'owner-1',
            status: 'ACTIVE',
        } as never);

        await createAutomatedTestRun(makeRequestContext('EDITOR'), 'plan-1', {
            result: 'FAIL',
            notes: 'auto-fail message',
            integrationResultId: 'ir-1',
        });

        expect(mockCreateTask).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'CONTROL_GAP',
                metadataJson: expect.objectContaining({
                    automated: true,
                    integrationResultId: 'ir-1',
                }),
            }),
        );
        // Regression: a refactor that handled automated FAILs without
        // creating the task would leave compliance teams chasing an
        // alert that has no follow-up work item — the gap stays open
        // until someone notices the missing task.
    });
});
