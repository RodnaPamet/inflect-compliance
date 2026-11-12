/**
 * Unit tests for the AI-governance self-assessment usecase — the conditional
 * architecture resolution, save+audit, and the opt-in gap→finding linkage.
 * The DB layer, audit, and createFinding are mocked.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockTx = {
    aiGovSelfAssessment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    aiGovDomain: { findMany: jest.fn() },
    aiGovQuestion: { findMany: jest.fn(), findUnique: jest.fn() },
    aiGovSelfAssessmentAnswer: { findMany: jest.fn(), upsert: jest.fn() },
    finding: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx)),
    PrismaTx: undefined,
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
const createFinding = jest.fn();
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: (...a: unknown[]) => createFinding(...a) }));

import {
    getAiGovAssessmentState,
    saveAiGovAnswer,
    raiseFindingsFromAiGovGaps,
} from '@/app-layer/usecases/ai-gov-self-assessment';

const ctx = makeRequestContext('ADMIN');

const QUESTIONS = [
    { id: 'aig-4-01', domainId: 4, criticality: 'HIGH', conditional: null, text: 'input?', mappingsJson: { aisvs: ['C2'], iso42001: ['8.2'], euAiAct: ['Art.15'] } },
    { id: 'aig-5-03', domainId: 5, criticality: 'MEDIUM', conditional: 'RAG', text: 'rag?', mappingsJson: { aisvs: ['C8'], iso42001: ['8.2'], euAiAct: [] } },
    { id: 'aig-1-05', domainId: 1, criticality: 'CRITICAL', conditional: null, text: 'tier?', mappingsJson: { aisvs: [], iso42001: ['6.1'], euAiAct: ['Art.6'] } },
];

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.aiGovSelfAssessment.findFirst.mockResolvedValue({ id: 'as1', status: 'IN_PROGRESS', questionSetVersion: 1 });
    mockTx.aiGovDomain.findMany.mockResolvedValue([{ id: 1 }, { id: 4 }, { id: 5 }]);
    mockTx.aiGovQuestion.findMany.mockResolvedValue(QUESTIONS);
    createFinding.mockResolvedValue({ id: 'f1' });
});

describe('getAiGovAssessmentState', () => {
    it('resolves a conditional (RAG) question to N/A when the architecture is NONE', async () => {
        mockTx.aiGovSelfAssessmentAnswer.findMany.mockResolvedValue([
            { questionId: 'aig-4-01', answer: 'YES' },
        ]);
        const state = await getAiGovAssessmentState(ctx, { architecture: 'NONE' });
        const rag = state.questions.find((q) => q.id === 'aig-5-03')!;
        expect(rag.applicable).toBe(false); // RAG question not applicable
        // Coverage computed; the RAG question is excluded (NA), not a penalty.
        expect(state.coverage.aisvs.percent).toBe(100); // only aig-4-01 (YES) counts
    });

    it('returns each answer\'s stored note, so the wizard can seed it (#5128)', async () => {
        mockTx.aiGovSelfAssessmentAnswer.findMany.mockResolvedValue([
            { questionId: 'aig-4-01', answer: 'PARTIALLY', note: 'Pilot only in EU region.' },
        ]);
        const state = await getAiGovAssessmentState(ctx, { architecture: 'NONE' });
        expect(state.questions.find((q) => q.id === 'aig-4-01')!.note).toBe('Pilot only in EU region.');
        expect(state.questions.find((q) => q.id === 'aig-1-05')!.note).toBeNull();
    });

    it('includes a RAG question when the architecture is RAG', async () => {
        mockTx.aiGovSelfAssessmentAnswer.findMany.mockResolvedValue([]);
        const state = await getAiGovAssessmentState(ctx, { architecture: 'RAG' });
        expect(state.questions.find((q) => q.id === 'aig-5-03')!.applicable).toBe(true);
    });
});

describe('saveAiGovAnswer', () => {
    it('rejects an invalid answer value', async () => {
        await expect(
            saveAiGovAnswer(ctx, { questionId: 'aig-4-01', answer: 'MAYBE' as never }),
        ).rejects.toThrow();
    });

    it('upserts a valid answer', async () => {
        mockTx.aiGovQuestion.findUnique.mockResolvedValue(QUESTIONS[0]);
        mockTx.aiGovSelfAssessmentAnswer.upsert.mockResolvedValue({ id: 'ans1' });
        await saveAiGovAnswer(ctx, { questionId: 'aig-4-01', answer: 'YES', note: 'ok' });
        expect(mockTx.aiGovSelfAssessmentAnswer.upsert).toHaveBeenCalledTimes(1);
    });

    it('an answer-only change leaves the stored note; null clears it (#5128)', async () => {
        mockTx.aiGovQuestion.findUnique.mockResolvedValue(QUESTIONS[0]);
        mockTx.aiGovSelfAssessmentAnswer.upsert.mockResolvedValue({ id: 'ans1' });

        await saveAiGovAnswer(ctx, { questionId: 'aig-4-01', answer: 'YES' });
        const answerOnly = mockTx.aiGovSelfAssessmentAnswer.upsert.mock.calls[0][0];
        expect(answerOnly.update).not.toHaveProperty('note');
        expect(answerOnly.update.answer).toBe('YES');

        await saveAiGovAnswer(ctx, { questionId: 'aig-4-01', answer: 'YES', note: null });
        expect(mockTx.aiGovSelfAssessmentAnswer.upsert.mock.calls[1][0].update.note).toBeNull();
    });
});

describe('raiseFindingsFromAiGovGaps', () => {
    it('creates findings for HIGH+ NO/PARTIALLY answers, idempotently', async () => {
        mockTx.aiGovSelfAssessmentAnswer.findMany.mockResolvedValue([
            { questionId: 'aig-4-01', answer: 'NO' }, // HIGH gap → finding
            { questionId: 'aig-1-05', answer: 'YES' }, // not a gap → skip
        ]);
        mockTx.finding.findMany.mockResolvedValue([]); // none yet
        const r = await raiseFindingsFromAiGovGaps(ctx, { architecture: 'NONE' });
        expect(createFinding).toHaveBeenCalledTimes(1);
        expect(r.created).toEqual(['f1']);
    });

    it('does not duplicate a finding that already exists (idempotent marker)', async () => {
        mockTx.aiGovSelfAssessmentAnswer.findMany.mockResolvedValue([
            { questionId: 'aig-4-01', answer: 'NO' },
        ]);
        mockTx.finding.findMany.mockResolvedValue([
            { title: 'AI-governance gap (aig-4-01) [AI_GOV_SELF_ASSESSMENT:aig-4-01]' },
        ]);
        const r = await raiseFindingsFromAiGovGaps(ctx, { architecture: 'NONE' });
        expect(createFinding).not.toHaveBeenCalled();
        expect(r.created).toEqual([]);
    });
});
