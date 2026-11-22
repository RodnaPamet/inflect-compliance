/**
 * materializeNis2Gaps — idempotency + reconciliation, via stateful mocks
 * (no DB). createFinding appends to an in-memory store that
 * FindingRepository.listBySource reads back, so a second run dedupes and a
 * NO→YES answer change closes the corresponding finding.
 */

// Shared mutable state (jest factory may reference `mock`-prefixed vars).
const mockState: {
    answers: Record<string, string>;
    findings: Array<{ id: string; sourceRef: string | null; status: string }>;
    seq: number;
} = { answers: {}, findings: [], seq: 0 };

const mockQuestions = [
    { id: 'q1', domainId: 0, criticality: 'CRITICAL', consequence: 'FINE', fineExposure: true, timeToFix: 'WEEKS', legalBasis: '§1', plainText: { en: 'q1', de: 'q1' } },
    { id: 'q2', domainId: 0, criticality: 'LOW', consequence: 'AUDIT_FINDING', fineExposure: false, timeToFix: 'MONTHS', legalBasis: '§2', plainText: { en: 'q2', de: 'q2' } },
];
const mockDomains = [{ id: 0, code: 'SCOPE', name: { en: 'Scope', de: 'Umfang' } }];

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: any) => fn({}),
}));
jest.mock('@/app-layer/policies/common', () => ({ assertCanWrite: () => {}, assertCanRead: () => {} }));
jest.mock('@/app-layer/policies/onboarding.policies', () => ({ assertCanManageOnboarding: () => {} }));
jest.mock('@/app-layer/repositories/Nis2GapAssessmentRepository', () => ({
    Nis2GapAssessmentRepository: {
        listDomains: jest.fn(async () => mockDomains),
        listQuestions: jest.fn(async () => mockQuestions),
        listAssessments: jest.fn(async () => [{ id: 'a1' }]),
        listAnswers: jest.fn(async () =>
            Object.entries(mockState.answers).map(([questionId, answer]) => ({ questionId, answer })),
        ),
    },
}));
jest.mock('@/app-layer/repositories/FindingRepository', () => ({
    FindingRepository: {
        listBySource: jest.fn(async () => mockState.findings.map((f) => ({ ...f }))),
    },
}));
jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: jest.fn(async (_ctx: any, data: any) => {
        const f = { id: `f${++mockState.seq}`, sourceRef: data.sourceRef, status: 'OPEN' };
        mockState.findings.push(f);
        return f;
    }),
    updateFinding: jest.fn(async (_ctx: any, id: string, data: any) => {
        const f = mockState.findings.find((x) => x.id === id);
        if (f && data.status) f.status = data.status;
        return f;
    }),
}));
jest.mock('@/app-layer/usecases/task', () => ({ createTask: jest.fn(async () => ({ id: 't1' })) }));

import { materializeNis2Gaps } from '@/app-layer/usecases/nis2-readiness';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

beforeEach(() => {
    mockState.answers = {};
    mockState.findings = [];
    mockState.seq = 0;
});

describe('materializeNis2Gaps', () => {
    it('creates a finding (via the finding usecase) for a HIGH+ gap', async () => {
        mockState.answers = { q1: 'NO', q2: 'NO' };
        const r = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH', createTasks: true });
        // q1 is CRITICAL (eligible); q2 is LOW (below HIGH threshold) → 1 finding.
        expect(r.created).toBe(1);
        expect(mockState.findings.filter((f) => f.sourceRef === 'q1')).toHaveLength(1);
    });

    it('is idempotent — running twice does NOT duplicate findings', async () => {
        mockState.answers = { q1: 'NO' };
        await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        const second = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        expect(second.created).toBe(0);
        expect(mockState.findings.filter((f) => f.sourceRef === 'q1')).toHaveLength(1);
    });

    it('reconciles NO→YES by CLOSING the finding', async () => {
        mockState.answers = { q1: 'NO' };
        await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        expect(mockState.findings[0].status).toBe('OPEN');

        // User fixes it: q1 now YES → re-run closes the finding.
        mockState.answers = { q1: 'YES' };
        const r = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        expect(r.closed).toBe(1);
        expect(mockState.findings[0].status).toBe('CLOSED');
    });

    it('reopens a CLOSED finding when the gap returns (YES→NO)', async () => {
        mockState.answers = { q1: 'NO' };
        await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        mockState.answers = { q1: 'YES' };
        await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        expect(mockState.findings[0].status).toBe('CLOSED');

        mockState.answers = { q1: 'NO' };
        const r = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        expect(r.reopened).toBe(1);
        expect(mockState.findings[0].status).toBe('OPEN');
    });

    it('a new, unanswered run closes nothing (#5146)', async () => {
        mockState.answers = { q1: 'NO' };
        await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });

        // A fresh run becomes the latest, with no answers yet.
        mockState.answers = {};
        const preview = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH', dryRun: true });
        expect(preview.closed).toBe(0);
        const r = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH' });
        expect(r.closed).toBe(0);
        expect(mockState.findings[0].status).toBe('OPEN');
    });

    it('a half-answered run closes only the findings it answered YES or NA (#5146)', async () => {
        mockState.answers = { q1: 'NO', q2: 'NO' };
        await materializeNis2Gaps(ctx, { minCriticality: 'LOW' });
        expect(mockState.findings.map((f) => f.status)).toEqual(['OPEN', 'OPEN']);

        mockState.answers = { q2: 'NA' }; // q1 not reached yet
        const r = await materializeNis2Gaps(ctx, { minCriticality: 'LOW' });
        expect(r.closed).toBe(1);
        expect(Object.fromEntries(mockState.findings.map((f) => [f.sourceRef, f.status]))).toEqual({ q1: 'OPEN', q2: 'CLOSED' });
    });

    it('dryRun previews counts without mutating', async () => {
        mockState.answers = { q1: 'NO' };
        const r = await materializeNis2Gaps(ctx, { minCriticality: 'HIGH', dryRun: true });
        expect(r.created).toBe(1);
        expect(mockState.findings).toHaveLength(0);
    });
});
