/**
 * Unit coverage for the NIS2 gap-lifecycle usecase.
 *
 * `classify` is the pure propose-not-commit ROUTER (management-liability lens);
 * the DB-bound flows (install detection, history, propose, apply) are driven
 * with a mocked `runInTenantContext` + `db` + create-usecases, so every
 * routing / idempotency / approval branch is exercised without a live database.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('../../src/app-layer/policies/common', () => ({ assertCanRead: jest.fn(), assertCanWrite: jest.fn() }));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../src/app-layer/usecases/nis2-readiness', () => ({ computeNis2Readiness: jest.fn() }));
jest.mock('../../src/app-layer/usecases/risk', () => ({ createRisk: jest.fn().mockResolvedValue({ id: 'r1' }) }));
jest.mock('../../src/app-layer/usecases/control/mutations', () => ({ createControl: jest.fn().mockResolvedValue({ id: 'c1' }) }));
jest.mock('../../src/app-layer/usecases/task', () => ({ createTask: jest.fn().mockResolvedValue({ id: 't1' }) }));
jest.mock('../../src/app-layer/repositories/Nis2GapAssessmentRepository', () => ({
    Nis2GapAssessmentRepository: { listAssessments: jest.fn() },
}));

import {
    classify,
    NIS2_GAP_CATEGORY,
    tenantHasNis2,
    listNis2GapAssessmentHistory,
    proposeNis2Remediations,
    applyNis2Remediations,
    type RemediationKind,
} from '@/app-layer/usecases/nis2-gap-lifecycle';
import type { Nis2Gap } from '@/app-layer/usecases/nis2-readiness';
import { runInTenantContext } from '@/lib/db-context';
import { computeNis2Readiness } from '@/app-layer/usecases/nis2-readiness';
import { Nis2GapAssessmentRepository } from '@/app-layer/repositories/Nis2GapAssessmentRepository';
import { createRisk } from '@/app-layer/usecases/risk';
import { createControl } from '@/app-layer/usecases/control/mutations';
import { createTask } from '@/app-layer/usecases/task';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockReadiness = computeNis2Readiness as jest.MockedFunction<typeof computeNis2Readiness>;
const mockListAssessments = Nis2GapAssessmentRepository.listAssessments as jest.Mock;
const mockCreateRisk = createRisk as jest.MockedFunction<typeof createRisk>;
const mockCreateControl = createControl as jest.MockedFunction<typeof createControl>;
const mockCreateTask = createTask as jest.MockedFunction<typeof createTask>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (over: any = {}): any => ({ tenantId: 't1', userId: 'u1', role: 'ADMIN', ...over });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDb(db: any) { mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db)); }

function gap(over: Partial<Nis2Gap>): Nis2Gap {
    return {
        questionId: 'gap-0-01', domainId: 0, criticality: 'HIGH', consequence: 'AUDIT_FINDING',
        fineExposure: false, timeToFix: 'WEEKS', legalBasis: '§28 BSIG', answer: 'NO',
        priority: 40, priorityTier: 'HIGH', plainText: { en: 'x', de: 'x' }, ...over,
    } as Nis2Gap;
}
function readiness(gaps: Nis2Gap[]) {
    return { gaps, score: { overall: 55 }, answeredTotal: 10, questionTotal: 20 } as never;
}

beforeEach(() => jest.clearAllMocks());

describe('classify — propose-not-commit routing', () => {
    it('fine-exposure → RISK', () => expect(classify(gap({ fineExposure: true }), false)).toBe<RemediationKind>('RISK'));
    it('PERSONAL_LIABILITY → RISK', () => expect(classify(gap({ consequence: 'PERSONAL_LIABILITY' }), true)).toBe<RemediationKind>('RISK'));
    it('QUICK_WIN → TASK', () => expect(classify(gap({ timeToFix: 'QUICK_WIN' }), true)).toBe<RemediationKind>('TASK'));
    it('control gap with existing control → CONTROL_LINK', () => expect(classify(gap({}), true)).toBe<RemediationKind>('CONTROL_LINK'));
    it('control gap with no existing control → CONTROL_CREATE', () => expect(classify(gap({}), false)).toBe<RemediationKind>('CONTROL_CREATE'));
    it('exposes the dedupe category sentinel', () => expect(NIS2_GAP_CATEGORY).toBe('NIS2_GAP'));
});

describe('tenantHasNis2', () => {
    it('true when a run exists', async () => {
        mockListAssessments.mockResolvedValue([{ id: 'a1' }]);
        withDb({ controlRequirementLink: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(tenantHasNis2(ctx())).resolves.toBe(true);
    });
    it('true when a NIS2 control link exists (no runs)', async () => {
        mockListAssessments.mockResolvedValue([]);
        withDb({ controlRequirementLink: { findFirst: jest.fn().mockResolvedValue({ id: 'l1' }) } });
        await expect(tenantHasNis2(ctx())).resolves.toBe(true);
    });
    it('false when neither a run nor a link exists', async () => {
        mockListAssessments.mockResolvedValue([]);
        withDb({ controlRequirementLink: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(tenantHasNis2(ctx())).resolves.toBe(false);
    });
});

describe('listNis2GapAssessmentHistory', () => {
    it('summarises each run (source fallback + completedAt null/date)', async () => {
        mockListAssessments.mockResolvedValue([
            { id: 'a1', source: null, status: 'COMPLETED', completedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
            { id: 'a2', source: 'STANDALONE', status: 'IN_PROGRESS', completedAt: null, createdAt: new Date('2026-02-01') },
        ]);
        withDb({});
        mockReadiness.mockResolvedValue(readiness([gap({})]));
        const out = await listNis2GapAssessmentHistory(ctx());
        expect(out).toHaveLength(2);
        expect(out[0].source).toBe('STANDALONE'); // null → fallback
        expect(out[0].completedAt).toBe(new Date('2026-01-01').toISOString());
        expect(out[1].completedAt).toBeNull();
        expect(out[0].gapCount).toBe(1);
    });
});

describe('proposeNis2Remediations', () => {
    it('filters below the criticality threshold and classifies the rest', async () => {
        mockReadiness.mockResolvedValue(readiness([
            gap({ questionId: 'q-crit', criticality: 'CRITICAL', fineExposure: true }),
            gap({ questionId: 'q-low', criticality: 'LOW' }), // filtered out at default HIGH threshold
            gap({ questionId: 'q-quick', criticality: 'HIGH', timeToFix: 'QUICK_WIN' }),
        ]));
        // no existing NIS2 controls
        withDb({ controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) } });
        const { suggestions } = await proposeNis2Remediations(ctx());
        const ids = suggestions.map((s) => s.questionId);
        expect(ids).toContain('q-crit');
        expect(ids).toContain('q-quick');
        expect(ids).not.toContain('q-low');
        expect(suggestions.find((s) => s.questionId === 'q-crit')!.kind).toBe('RISK');
        expect(suggestions.find((s) => s.questionId === 'q-quick')!.kind).toBe('TASK');
    });

    it('attaches existingControls to a CONTROL_LINK suggestion', async () => {
        mockReadiness.mockResolvedValue(readiness([gap({ questionId: 'q-ctl', criticality: 'HIGH' })]));
        withDb({ controlRequirementLink: { findMany: jest.fn().mockResolvedValue([{ control: { id: 'c1', name: 'Existing' } }]) } });
        const { suggestions, existingControls } = await proposeNis2Remediations(ctx({}), { minCriticality: 'MEDIUM' });
        expect(existingControls).toEqual([{ id: 'c1', name: 'Existing' }]);
        const s = suggestions.find((x) => x.questionId === 'q-ctl')!;
        expect(s.kind).toBe('CONTROL_LINK');
        expect(s.existingControls).toEqual([{ id: 'c1', name: 'Existing' }]);
    });
});

describe('applyNis2Remediations', () => {
    it('returns zeros for an empty approval list', async () => {
        await expect(applyNis2Remediations(ctx(), [])).resolves.toEqual({ risksCreated: 0, controlsCreated: 0, tasksCreated: 0, skipped: 0 });
    });

    function wireApply(gaps: Nis2Gap[], idempotency: { risks?: unknown[]; controls?: unknown[]; tasks?: unknown[] } = {}) {
        mockReadiness.mockResolvedValue(readiness(gaps));
        // First runInTenantContext call = propose's existingControls query; second = idempotency sets; third = logEvent.
        const proposeDb = { controlRequirementLink: { findMany: jest.fn().mockResolvedValue([{ control: { id: 'c-existing', name: 'C' } }]) } };
        const idemDb = {
            risk: { findMany: jest.fn().mockResolvedValue(idempotency.risks ?? []) },
            control: { findMany: jest.fn().mockResolvedValue(idempotency.controls ?? []) },
            task: { findMany: jest.fn().mockResolvedValue(idempotency.tasks ?? []) },
        };
        const calls = [proposeDb, idemDb, {}];
        let i = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(calls[Math.min(i++, calls.length - 1)]));
    }

    it('creates a RISK / CONTROL / TASK for approved, distinct suggestions', async () => {
        wireApply([
            gap({ questionId: 'q-risk', fineExposure: true }),
            gap({ questionId: 'q-ctl-create', timeToFix: 'MONTHS' }), // control gap; but existing control present → LINK... force create via no-existing
            gap({ questionId: 'q-task', timeToFix: 'QUICK_WIN' }),
        ]);
        const res = await applyNis2Remediations(ctx(), [
            { questionId: 'q-risk', kind: 'RISK' },
            { questionId: 'q-task', kind: 'TASK' },
            { questionId: 'q-unknown', kind: 'RISK' }, // not a current suggestion → skipped
        ]);
        expect(mockCreateRisk).toHaveBeenCalledTimes(1);
        expect(mockCreateTask).toHaveBeenCalledTimes(1);
        expect(res.risksCreated).toBe(1);
        expect(res.tasksCreated).toBe(1);
        expect(res.skipped).toBe(1); // q-unknown
    });

    it('skips a RISK whose title already exists (idempotent)', async () => {
        const g = gap({ questionId: 'q-risk', fineExposure: true, plainText: { en: 'Dup Title', de: 'x' } });
        wireApply([g], { risks: [{ title: 'Dup Title' }] });
        const res = await applyNis2Remediations(ctx(), [{ questionId: 'q-risk', kind: 'RISK' }]);
        expect(mockCreateRisk).not.toHaveBeenCalled();
        expect(res.risksCreated).toBe(0);
        expect(res.skipped).toBe(1);
    });

    it('creates a CONTROL when no NIS2 control exists and title is new', async () => {
        // no existing controls → classify returns CONTROL_CREATE
        mockReadiness.mockResolvedValue(readiness([gap({ questionId: 'q-cc', timeToFix: 'MONTHS' })]));
        const proposeDb = { controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) } };
        const idemDb = { risk: { findMany: jest.fn().mockResolvedValue([]) }, control: { findMany: jest.fn().mockResolvedValue([]) }, task: { findMany: jest.fn().mockResolvedValue([]) } };
        const calls = [proposeDb, idemDb, {}]; let i = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(calls[Math.min(i++, calls.length - 1)]));
        const res = await applyNis2Remediations(ctx(), [{ questionId: 'q-cc', kind: 'CONTROL_CREATE' }]);
        expect(mockCreateControl).toHaveBeenCalledTimes(1);
        expect(res.controlsCreated).toBe(1);
    });

    it('skips a TASK whose questionId marker already exists', async () => {
        wireApply([gap({ questionId: 'q-task', timeToFix: 'QUICK_WIN' })], {
            tasks: [{ metadataJson: { source: 'NIS2_GAP', questionId: 'q-task' } }],
        });
        const res = await applyNis2Remediations(ctx(), [{ questionId: 'q-task', kind: 'TASK' }]);
        expect(mockCreateTask).not.toHaveBeenCalled();
        expect(res.skipped).toBe(1);
    });

    it('skips an approval whose kind differs from the engine classification (#5318)', async () => {
        wireApply([gap({ questionId: 'q-task', timeToFix: 'QUICK_WIN' })]);
        const res = await applyNis2Remediations(ctx(), [
            { questionId: 'q-task', kind: 'RISK' },
            { questionId: 'q-task', kind: 'CONTROL_CREATE' },
        ]);
        expect(mockCreateRisk).not.toHaveBeenCalled();
        expect(mockCreateControl).not.toHaveBeenCalled();
        expect(res).toEqual({ risksCreated: 0, controlsCreated: 0, tasksCreated: 0, skipped: 2 });
    });

    it('skips a CONTROL_LINK naming a control the suggestion did not offer (#5318)', async () => {
        wireApply([gap({ questionId: 'q-link' })]);
        const res = await applyNis2Remediations(ctx(), [
            { questionId: 'q-link', kind: 'CONTROL_LINK', linkControlId: 'c-not-offered' },
        ]);
        expect(mockCreateTask).not.toHaveBeenCalled();
        expect(res.skipped).toBe(1);

        wireApply([gap({ questionId: 'q-link' })]);
        const ok = await applyNis2Remediations(ctx(), [
            { questionId: 'q-link', kind: 'CONTROL_LINK', linkControlId: 'c-existing' },
        ]);
        expect(ok.tasksCreated).toBe(1);
        expect(mockCreateTask).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ controlId: 'c-existing' }),
        );
    });
});
