/**
 * A completed NIS2 run keeps its answers (#4734).
 *
 * The self-assessment page answers the latest run, and it used to do so
 * whatever that run's status, so answering after completion rewrote a
 * completed run and the gap page's history stopped matching what had been
 * answered at the time. Now:
 *
 *   - an answer to a COMPLETED or ARCHIVED run is refused, 409 with the
 *     named reason NIS2_RUN_FINALISED, under the lock the delegated answers
 *     take, and nothing is written;
 *   - completing a finalised run again leaves it as it was (its completedAt
 *     stays) and still advances the onboarding step.
 */
const db = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db)),
}));

const repo = {
    listAssessments: jest.fn(),
    createAssessment: jest.fn(),
    lockAssessmentStatusForShare: jest.fn(),
    getQuestionById: jest.fn(),
    upsertAnswer: jest.fn(),
    markAssessmentCompleted: jest.fn(),
};
jest.mock('@/app-layer/repositories/Nis2GapAssessmentRepository', () => ({
    Nis2GapAssessmentRepository: repo,
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const onboarding = { getOnboardingState: jest.fn(), completeOnboardingStep: jest.fn() };
jest.mock('@/app-layer/usecases/onboarding', () => onboarding);
jest.mock('@/app-layer/usecases/nis2-readiness', () => ({ snapshotNis2Readiness: jest.fn() }));

import { saveNis2Answer, completeNis2Assessment } from '@/app-layer/usecases/onboarding-nis2';
import { ConflictError } from '@/lib/errors/types';
import { isFinalizedNis2Run } from '@/lib/nis2-run-status';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const run = (status: string) => ({ id: 'run_1', status, completedAt: status === 'COMPLETED' ? new Date('2026-10-01') : null });

beforeEach(() => {
    for (const fn of Object.values(repo)) fn.mockReset();
    onboarding.getOnboardingState.mockReset().mockResolvedValue({ status: 'COMPLETED', completedSteps: [] });
    onboarding.completeOnboardingStep.mockReset();
    repo.getQuestionById.mockResolvedValue({ id: 'gap-0-01' });
    repo.upsertAnswer.mockResolvedValue({ id: 'ans_1' });
});

describe('isFinalizedNis2Run', () => {
    it('treats COMPLETED, ARCHIVED and a missing run as finalised', () => {
        expect(isFinalizedNis2Run('COMPLETED')).toBe(true);
        expect(isFinalizedNis2Run('ARCHIVED')).toBe(true);
        expect(isFinalizedNis2Run(null)).toBe(true);
        expect(isFinalizedNis2Run(undefined)).toBe(true);
        expect(isFinalizedNis2Run('IN_PROGRESS')).toBe(false);
    });
});

describe('saveNis2Answer', () => {
    it('refuses an answer to a completed run, by name, and writes nothing', async () => {
        repo.listAssessments.mockResolvedValue([run('COMPLETED')]);
        repo.lockAssessmentStatusForShare.mockResolvedValue({ status: 'COMPLETED' });

        const err = await saveNis2Answer(ctx, { questionId: 'gap-0-01', answer: 'YES' }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ConflictError);
        expect((err as ConflictError).details).toEqual({ reason: 'NIS2_RUN_FINALISED' });
        expect(repo.lockAssessmentStatusForShare).toHaveBeenCalledWith(db, ctx, 'run_1');
        expect(repo.upsertAnswer).not.toHaveBeenCalled();
    });

    it('still saves an answer to a run in progress', async () => {
        repo.listAssessments.mockResolvedValue([run('IN_PROGRESS')]);
        repo.lockAssessmentStatusForShare.mockResolvedValue({ status: 'IN_PROGRESS' });

        await saveNis2Answer(ctx, { questionId: 'gap-0-01', answer: 'NO' });

        expect(repo.upsertAnswer).toHaveBeenCalledWith(db, ctx, expect.objectContaining({ assessmentId: 'run_1', answer: 'NO' }));
    });
});

describe('completeNis2Assessment', () => {
    it('leaves a completed run as it was, and still advances the onboarding step', async () => {
        const completed = run('COMPLETED');
        repo.listAssessments.mockResolvedValue([completed]);
        onboarding.getOnboardingState.mockResolvedValue({ status: 'IN_PROGRESS', completedSteps: [] });

        const result = await completeNis2Assessment(ctx);

        expect(repo.markAssessmentCompleted).not.toHaveBeenCalled();
        expect(result).toBe(completed);
        expect(onboarding.completeOnboardingStep).toHaveBeenCalledWith(ctx, 'NIS2_SELF_ASSESSMENT');
    });

    it('marks a run in progress completed', async () => {
        repo.listAssessments.mockResolvedValue([run('IN_PROGRESS')]);
        repo.markAssessmentCompleted.mockResolvedValue(run('COMPLETED'));

        await completeNis2Assessment(ctx);

        expect(repo.markAssessmentCompleted).toHaveBeenCalledWith(db, ctx, 'run_1');
    });
});
