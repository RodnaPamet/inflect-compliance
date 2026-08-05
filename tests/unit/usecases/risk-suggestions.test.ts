/**
 * Unit tests for src/app-layer/usecases/risk-suggestions.ts
 *
 * Wave 4 of GAP-02. AI-assisted risk suggestions — three independent
 * controls protect the privacy + cost surface:
 *
 *   1. Feature gate (global flag + role + plan).
 *   2. Rate limiter (per-tenant daily quota + per-user burst).
 *   3. Privacy sanitiser — strips PII before sending to the AI provider.
 *
 * Each control runs BEFORE the AI call. A bug here is either a
 * cost / abuse bypass OR a privacy regression (PII leaving our perimeter).
 *
 * Behaviours protected:
 *   1. enforceFeatureGate fires first, before canWrite check.
 *   2. canWrite check rejects READER + AUDITOR even with feature gate
 *      satisfied.
 *   3. checkRateLimit fires BEFORE any DB work (early reject for
 *      abuse traffic).
 *   4. sanitizeProviderInput is called between buildProviderInput and
 *      provider.generateSuggestions — the AI provider never sees the
 *      pre-sanitisation object.
 *   5. recordGeneration is called only AFTER provider success
 *      (failed generations don't burn the quota).
 *   6. applySession is idempotent — re-applying with the same accepted
 *      ids on a session whose risks already exist by title does NOT
 *      create duplicates.
 *   7. applySession rejects sessions in APPLIED or DISMISSED state.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/ai/risk-assessment', () => ({
    getProvider: jest.fn(() => ({
        providerName: 'mock-provider',
        generateSuggestions: jest.fn(),
    })),
}));

jest.mock('@/app-layer/ai/risk-assessment/privacy-sanitizer', () => ({
    sanitizeProviderInput: jest.fn((x: unknown) => x),
    describePayload: jest.fn(() => 'SUMMARY'),
}));

jest.mock('@/app-layer/ai/risk-assessment/rate-limiter', () => ({
    checkRateLimit: jest.fn(),
    recordGeneration: jest.fn(),
}));

jest.mock('@/app-layer/ai/risk-assessment/feature-gate', () => ({
    enforceFeatureGate: jest.fn(),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

// The AI decision log (Art 12) is exercised by its own ratchet
// (tests/guards/ai-decision-log.test.ts); mock it here so these tests focus on
// the usecase's own sanitise/provider/apply/dismiss logic.
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn().mockResolvedValue('log-1'),
    recordDecisionOutcome: jest.fn().mockResolvedValue(1),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

import {
    generateRiskSuggestions,
    applySession,
    dismissSession,
} from '@/app-layer/usecases/risk-suggestions';
import { runInTenantContext } from '@/lib/db-context';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { getProvider } from '@/app-layer/ai/risk-assessment';
import { sanitizeProviderInput } from '@/app-layer/ai/risk-assessment/privacy-sanitizer';
import {
    checkRateLimit,
    recordGeneration,
} from '@/app-layer/ai/risk-assessment/rate-limiter';
import { enforceFeatureGate } from '@/app-layer/ai/risk-assessment/feature-gate';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetProvider = getProvider as jest.MockedFunction<typeof getProvider>;
const mockSanitiseInput = sanitizeProviderInput as jest.MockedFunction<typeof sanitizeProviderInput>;
const mockCheckRateLimit = checkRateLimit as jest.MockedFunction<typeof checkRateLimit>;
const mockRecordGeneration = recordGeneration as jest.MockedFunction<typeof recordGeneration>;
const mockEnforceGate = enforceFeatureGate as jest.MockedFunction<typeof enforceFeatureGate>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;
const mockBumpCache = bumpEntityCacheVersion as jest.MockedFunction<typeof bumpEntityCacheVersion>;

/**
 * `applySession` creates risks through `RiskRepository.create`, which mints
 * the per-tenant `RSK-N` key off this counter before inserting. Any fake db
 * that reaches a risk create needs the table stubbed.
 *
 * It previously called a bare `db.risk.create` — which is precisely why
 * every AI-accepted risk landed with `key = NULL` and a blank Code column.
 * The extra stub here is the cost of routing through the repository.
 */
const riskKeySequenceStub = () => ({
    upsert: jest.fn().mockResolvedValue({ tenantId: 't1', lastValue: 1 }),
});

beforeEach(() => {
    jest.clearAllMocks();
    // Default to feature-gate + rate-limit pass.
    mockEnforceGate.mockImplementation(() => undefined);
    mockCheckRateLimit.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSanitiseInput.mockImplementation((x: any) => x);
});

describe('generateRiskSuggestions — pre-AI controls', () => {
    const apiInput = { assetIds: [], frameworks: ['ISO27001'] } as never;

    it('runs enforceFeatureGate FIRST (before any other check)', async () => {
        mockEnforceGate.mockImplementationOnce(() => {
            throw new Error('feature_gate');
        });

        await expect(
            generateRiskSuggestions(makeRequestContext('ADMIN'), apiInput),
        ).rejects.toThrow(/feature_gate/);
        // Regression: if canWrite or rate-limit ran first, a feature-
        // gated tenant would hit a misleading "permission denied" or
        // burn quota before the gate ran.
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('rejects READER + AUDITOR after feature gate (canWrite check)', async () => {
        await expect(
            generateRiskSuggestions(makeRequestContext('READER'), apiInput),
        ).rejects.toThrow(/Only editors and admins/);
        await expect(
            generateRiskSuggestions(makeRequestContext('AUDITOR'), apiInput),
        ).rejects.toThrow();
    });

    it('runs checkRateLimit BEFORE any DB work', async () => {
        mockCheckRateLimit.mockImplementationOnce(() => {
            throw new Error('rate_limit');
        });

        await expect(
            generateRiskSuggestions(makeRequestContext('ADMIN'), apiInput),
        ).rejects.toThrow(/rate_limit/);
        // Regression: rate-limiting AFTER the DB hit gives an attacker
        // free read amplification — they can probe the tenant's asset
        // list without ever hitting the AI quota.
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('sanitises provider input BEFORE calling the AI provider', async () => {
        const generateSpy = jest.fn().mockResolvedValue({
            suggestions: [],
            modelName: 'gpt-x',
            provider: 'mock-provider',
        });
        mockGetProvider.mockReturnValueOnce({
            providerName: 'mock-provider',
            generateSuggestions: generateSpy,
        } as never);

        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                tenant: { findUnique: jest.fn().mockResolvedValue({
                    industry: 'fin', context: 'ctx', maxRiskScale: 5,
                }) },
                asset: { findMany: jest.fn().mockResolvedValue([]) },
                control: { findMany: jest.fn().mockResolvedValue([]) },
                tenantSecuritySettings: { findUnique: jest.fn().mockResolvedValue(null) },
                riskSuggestionSession: {
                    create: jest.fn().mockResolvedValue({ id: 's1' }),
                    update: jest.fn().mockResolvedValue({ id: 's1', status: 'GENERATED' }),
                },
                riskSuggestionItem: {
                    create: jest.fn().mockResolvedValue({}),
                },
            } as never),
        );

        await generateRiskSuggestions(makeRequestContext('ADMIN'), apiInput);

        // sanitizeProviderInput called once with the raw provider input.
        expect(mockSanitiseInput).toHaveBeenCalledTimes(1);
        // Regression: a refactor that flipped the order would send the
        // raw payload (with PII fields like asset names containing
        // customer data) to a third-party AI endpoint.
        const sanitiseCallOrder = (mockSanitiseInput.mock.invocationCallOrder ?? [Infinity])[0];
        const generateCallOrder = (generateSpy.mock.invocationCallOrder ?? [-Infinity])[0];
        expect(sanitiseCallOrder).toBeLessThan(generateCallOrder);
    });

    it('records the generation only AFTER provider success (failed gens do NOT burn quota)', async () => {
        const generateSpy = jest.fn().mockRejectedValue(new Error('provider_oom'));
        mockGetProvider.mockReturnValueOnce({
            providerName: 'mock-provider',
            generateSuggestions: generateSpy,
        } as never);

        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                tenant: { findUnique: jest.fn().mockResolvedValue({ industry: 'x', maxRiskScale: 5 }) },
                asset: { findMany: jest.fn().mockResolvedValue([]) },
                control: { findMany: jest.fn().mockResolvedValue([]) },
                tenantSecuritySettings: { findUnique: jest.fn().mockResolvedValue(null) },
                riskSuggestionSession: {
                    create: jest.fn().mockResolvedValue({ id: 's1' }),
                    update: jest.fn().mockResolvedValue({}),
                },
            } as never),
        );

        await expect(
            generateRiskSuggestions(makeRequestContext('ADMIN'), apiInput),
        ).rejects.toThrow(/provider_oom/);

        expect(mockRecordGeneration).not.toHaveBeenCalled();
        // The audit event still fires (with success: false) so the
        // failure is traceable.
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'AI_RISK_SUGGESTIONS_GENERATED',
                metadata: expect.objectContaining({ success: false }),
            }),
        );
    });
});

describe('applySession — idempotency + state guard', () => {
    it('rejects session in APPLIED state', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'APPLIED', items: [],
                    }),
                },
            } as never),
        );

        await expect(
            applySession(makeRequestContext('ADMIN'), 's1', { acceptedItemIds: [] }),
        ).rejects.toThrow(/already been applied/);
    });

    it('rejects session in DISMISSED state', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'DISMISSED', items: [],
                    }),
                },
            } as never),
        );

        await expect(
            applySession(makeRequestContext('ADMIN'), 's1', { acceptedItemIds: [] }),
        ).rejects.toThrow(/dismissed/);
    });

    it('does NOT create a duplicate Risk when one already exists with the same title', async () => {
        const itemUpdate = jest.fn();
        const riskCreate = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'GENERATED', provider: 'mock', modelName: 'm',
                        items: [
                            { id: 'i1', title: 'Already Exists', status: 'PENDING' },
                        ],
                    }),
                    update: jest.fn().mockResolvedValue({}),
                },
                riskSuggestionItem: { update: itemUpdate },
                tenant: { findUnique: jest.fn().mockResolvedValue({ maxRiskScale: 5 }) },
                // RQ2-7 — accepted AI suggestions land an AI-source ledger event.
                riskScoreEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-ai' }) },
                riskKeySequence: riskKeySequenceStub(),
                risk: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'existing-risk' }),
                    create: riskCreate,
                },
            } as never),
        );

        await applySession(
            makeRequestContext('ADMIN'),
            's1',
            { acceptedItemIds: ['i1'] },
        );

        // Regression: an idempotency miss would create a fresh Risk
        // row each time the user clicked "apply" on the same session,
        // duplicating compliance work AND making the audit trail
        // confusing.
        expect(riskCreate).not.toHaveBeenCalled();
        // The item is still marked ACCEPTED, pointing at the existing
        // risk's id.
        expect(itemUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'i1' },
                data: expect.objectContaining({
                    status: 'ACCEPTED',
                    createdRiskId: 'existing-risk',
                }),
            }),
        );
    });

    it('marks not-accepted PENDING items as REJECTED', async () => {
        const itemUpdate = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'GENERATED', provider: 'm', modelName: 'm',
                        items: [
                            { id: 'i1', title: 't1', status: 'PENDING' },
                            { id: 'i2', title: 't2', status: 'PENDING' },
                        ],
                    }),
                    update: jest.fn().mockResolvedValue({}),
                },
                riskSuggestionItem: { update: itemUpdate },
                tenant: { findUnique: jest.fn().mockResolvedValue({ maxRiskScale: 5 }) },
                // RQ2-7 — accepted AI suggestions land an AI-source ledger event.
                riskScoreEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-ai' }) },
                riskKeySequence: riskKeySequenceStub(),
                risk: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'r-new' }),
                },
            } as never),
        );

        await applySession(
            makeRequestContext('ADMIN'),
            's1',
            { acceptedItemIds: ['i1'] }, // only i1 accepted
        );

        const updates = itemUpdate.mock.calls.map(c => ({
            id: c[0].where.id, status: c[0].data.status,
        }));
        // i1 → ACCEPTED, i2 → REJECTED
        expect(updates).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'i1', status: 'ACCEPTED' }),
            expect.objectContaining({ id: 'i2', status: 'REJECTED' }),
        ]));
    });

    it('accepted suggestions land an AI-source inherent ledger event (RQ2-7)', async () => {
        const scoreEventCreate = jest.fn().mockResolvedValue({ id: 'evt-ai' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'GENERATED', provider: 'm', modelName: 'm',
                        items: [{
                            id: 'i1', title: 't1', status: 'PENDING',
                            likelihoodSuggested: 4, impactSuggested: 5,
                            rationale: 'phishing precedent in sector',
                        }],
                    }),
                    update: jest.fn().mockResolvedValue({}),
                },
                riskSuggestionItem: { update: jest.fn().mockResolvedValue({}) },
                tenant: { findUnique: jest.fn().mockResolvedValue({ maxRiskScale: 5 }) },
                riskScoreEvent: { create: scoreEventCreate },
                riskKeySequence: riskKeySequenceStub(),
                risk: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'r-new' }),
                },
            } as never),
        );

        await applySession(makeRequestContext('ADMIN'), 's1', { acceptedItemIds: ['i1'] });

        expect(scoreEventCreate).toHaveBeenCalledTimes(1);
        const data = scoreEventCreate.mock.calls[0][0].data;
        expect(data).toMatchObject({
            riskId: 'r-new',
            kind: 'INHERENT',
            likelihood: 4,
            impact: 5,
            source: 'AI',
            justification: 'phishing precedent in sector',
        });
    });

    it('invalidates the risk list cache after creating risks', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'GENERATED', provider: 'm', modelName: 'm',
                        items: [{ id: 'i1', title: 't1', status: 'PENDING' }],
                    }),
                    update: jest.fn().mockResolvedValue({}),
                },
                riskSuggestionItem: { update: jest.fn() },
                tenant: { findUnique: jest.fn().mockResolvedValue({ maxRiskScale: 5 }) },
                // RQ2-7 — accepted AI suggestions land an AI-source ledger event.
                riskScoreEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-ai' }) },
                riskKeySequence: riskKeySequenceStub(),
                risk: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockResolvedValue({ id: 'r-new' }),
                },
            } as never),
        );

        const ctx = makeRequestContext('ADMIN');
        await applySession(ctx, 's1', { acceptedItemIds: ['i1'] });

        // Regression: applySession creates Risk rows directly (not via
        // the `createRisk` usecase), so it must bump the risk list-cache
        // version itself. Without this, AI-applied risks stay invisible
        // in the Risk Register until the cache TTL expires.
        expect(mockBumpCache).toHaveBeenCalledWith(ctx, 'risk');
    });

    it('does NOT bump the cache when nothing is accepted (no Risk rows written)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', status: 'GENERATED', provider: 'm', modelName: 'm',
                        items: [{ id: 'i1', title: 't1', status: 'PENDING' }],
                    }),
                    update: jest.fn().mockResolvedValue({}),
                },
                riskSuggestionItem: { update: jest.fn() },
                tenant: { findUnique: jest.fn().mockResolvedValue({ maxRiskScale: 5 }) },
                // RQ2-7 — accepted AI suggestions land an AI-source ledger event.
                riskScoreEvent: { create: jest.fn().mockResolvedValue({ id: 'evt-ai' }) },
                riskKeySequence: riskKeySequenceStub(),
                risk: { findFirst: jest.fn(), create: jest.fn() },
            } as never),
        );

        await applySession(makeRequestContext('ADMIN'), 's1', { acceptedItemIds: [] });

        expect(mockBumpCache).not.toHaveBeenCalled();
    });
});

describe('dismissSession', () => {
    it('rejects READER (canWrite gate)', async () => {
        await expect(
            dismissSession(makeRequestContext('READER'), 's1'),
        ).rejects.toThrow();
    });

    it('emits AI_RISK_SUGGESTIONS_DISMISSED audit on success', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                riskSuggestionSession: {
                    findFirst: jest.fn().mockResolvedValue({
                        id: 's1', provider: 'mock', modelName: 'm',
                    }),
                    update: jest.fn().mockResolvedValue({ id: 's1', status: 'DISMISSED' }),
                },
            } as never),
        );

        await dismissSession(makeRequestContext('ADMIN'), 's1');

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'AI_RISK_SUGGESTIONS_DISMISSED' }),
        );
    });
});
