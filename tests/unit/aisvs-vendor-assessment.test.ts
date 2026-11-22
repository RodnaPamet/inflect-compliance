/**
 * Unit tests for the AISVS AI-vendor assessment usecase — the coverage readout
 * + the opt-in finding linkage. The DB layer + the existing createFinding
 * usecase are mocked so we test the decision logic in isolation.
 */
import { makeRequestContext } from '../helpers/make-context';

// runInTenantContext just runs the callback with our mock tx.
const mockTx = {
    vendorAssessment: { findFirst: jest.fn() },
    vendorAssessmentTemplateQuestion: { findMany: jest.fn() },
    vendorAssessmentAnswer: { findMany: jest.fn() },
    vendor: { findFirst: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
}));

// The existing finding usecase — must be reused (not re-implemented).
const createFinding = jest.fn();
jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: (...args: unknown[]) => createFinding(...args),
}));

import {
    getAisvsVendorCoverage,
    raiseFindingFromAisvsCoverage,
} from '@/app-layer/usecases/aisvs-vendor-assessment';

const ctx = makeRequestContext('ADMIN');

function wire(answers: Record<string, string>) {
    mockTx.vendorAssessment.findFirst.mockResolvedValue({
        id: 'a1', vendorId: 'v1', templateVersionId: 'tpl1',
    });
    mockTx.vendorAssessmentTemplateQuestion.findMany.mockResolvedValue([
        { id: 'q1', prompt: 'Screen inputs? (AISVS C2.1.3, L1)' },
        { id: 'q2', prompt: 'Validate output? (AISVS C7.1.1, L1)' },
        { id: 'q3', prompt: 'Confidence? (AISVS C7.2.1, L2)' },
    ]);
    mockTx.vendorAssessmentAnswer.findMany.mockResolvedValue(
        Object.entries(answers).map(([templateQuestionId, v]) => ({
            templateQuestionId, answerJson: { value: v },
        })),
    );
    mockTx.vendor.findFirst.mockResolvedValue({ name: 'TestVendor' });
}

beforeEach(() => {
    jest.clearAllMocks();
    createFinding.mockResolvedValue({ id: 'finding-1' });
});

describe('getAisvsVendorCoverage', () => {
    it('translates answers into an AISVS L1/L2 coverage readout', async () => {
        wire({ q1: 'yes', q2: 'no', q3: 'partial' });
        const readout = await getAisvsVendorCoverage(ctx, 'a1');
        expect(readout.l1).toMatchObject({ applicable: 2, met: 1, percent: 50 });
        expect(readout.l2).toMatchObject({ applicable: 1, partial: 1, percent: 50 });
        expect(readout.byChapter.map((c) => c.chapter).sort()).toEqual(['C2', 'C7']);
    });
});

describe('raiseFindingFromAisvsCoverage', () => {
    it('raises a Finding via the existing createFinding usecase when L1 coverage is low', async () => {
        wire({ q1: 'no', q2: 'no', q3: 'no' }); // L1 = 0%
        const result = await raiseFindingFromAisvsCoverage(ctx, 'a1', { l1Threshold: 70 });
        expect(createFinding).toHaveBeenCalledTimes(1);
        const [, payload] = createFinding.mock.calls[0];
        expect(payload.title).toMatch(/AISVS AI-vendor gap: TestVendor/);
        expect(payload.severity).toBe('HIGH'); // <40% → HIGH
        // A finding the real create accepts (#5181): 'AI vendor security' is
        // not a FindingType, and the enum column refused it.
        const { ProposedFindingSchema } = jest.requireActual('@/lib/schemas');
        expect(ProposedFindingSchema.safeParse(payload).success).toBe(true);
        expect(result).toEqual({ findingId: 'finding-1', l1Percent: 0 });
    });

    it('raises nothing when L1 coverage is at/above the threshold', async () => {
        wire({ q1: 'yes', q2: 'yes', q3: 'yes' }); // L1 = 100%
        const result = await raiseFindingFromAisvsCoverage(ctx, 'a1', { l1Threshold: 70 });
        expect(createFinding).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });
});
