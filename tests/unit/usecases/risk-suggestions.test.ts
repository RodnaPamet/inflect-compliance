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

// The real detector was running unmocked, which coupled every test in this
// file to its heuristics and left the `flagged` arm unreachable without
// crafting an input it happens to trip on. Mocked and defaulted to
// not-flagged in `beforeEach`, which is what it returned for these inputs
// anyway — so the existing expectations are unchanged.
jest.mock('@/app-layer/ai/risk-assessment/input-anomaly', () => ({
    detectInputAnomalies: jest.fn(() => ({ flagged: false, anomalies: [] })),
}));

import {
    generateRiskSuggestions,
    getSession,
    applySession,
    dismissSession,
} from '@/app-layer/usecases/risk-suggestions';
import { detectInputAnomalies } from '@/app-layer/ai/risk-assessment/input-anomaly';
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
const mockDetectAnomalies = detectInputAnomalies as jest.MockedFunction<typeof detectInputAnomalies>;

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
    mockEnforceGate.mockImplementation(() => Promise.resolve());
    mockCheckRateLimit.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSanitiseInput.mockImplementation((x: any) => x);
    mockDetectAnomalies.mockReturnValue({ flagged: false, anomalies: [] });
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

// ─── getSession ─────────────────────────────────────────────────────
//
// This export had ZERO references in this file before now, which is most of
// why the usecase sat at 37.5% FUNCTION coverage — low function coverage
// means whole entry points nothing calls, not a few missed conditionals.
//
// It is a read of AI-generated suggestions that have not been applied yet,
// so the tenant scoping is the assertion that matters: `findFirst` is given
// BOTH the id and `ctx.tenantId`, and an id alone must never be enough.

describe('getSession', () => {
    const seedSession = (row: unknown) => {
        const findFirst = jest.fn().mockResolvedValue(row);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ riskSuggestionSession: { findFirst } } as never),
        );
        return findFirst;
    };

    it('returns the session with its items', async () => {
        seedSession({ id: 's1', status: 'GENERATED', items: [{ id: 'i1' }] });
        await expect(getSession(makeRequestContext('READER'), 's1')).resolves.toMatchObject({
            id: 's1',
            items: [{ id: 'i1' }],
        });
    });

    it('scopes the lookup to ctx.tenantId, not the id alone', async () => {
        const findFirst = seedSession({ id: 's1', items: [] });
        await getSession(makeRequestContext('READER', { tenantId: 'tenant-Z' }), 's1');
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 's1', tenantId: 'tenant-Z' },
                include: { items: true },
            }),
        );
    });

    // A session id from another tenant resolves to null through the scoped
    // `where`, so notFound is the cross-tenant response as well as the
    // genuinely-absent one. Both must be the same 404 — a distinguishable
    // error would confirm the id exists somewhere.
    it('throws notFound when the scoped lookup finds nothing', async () => {
        seedSession(null);
        await expect(getSession(makeRequestContext('ADMIN'), 'other-tenants-id'))
            .rejects.toThrow(/Session not found/);
    });

    // canRead is true for every built-in role (`ROLE_ORDER[role] >= 1`), so
    // the refusal is only reachable through a custom role that withholds it.
    // Overriding the permission is how that configuration is expressed here.
    it('refuses a context without canRead, before touching the db', async () => {
        await expect(
            getSession(
                makeRequestContext('READER', {
                    permissions: {
                        canRead: false, canWrite: false, canAdmin: false,
                        canAudit: false, canExport: false,
                    },
                }),
                's1',
            ),
        ).rejects.toThrow(/Insufficient permissions/);
        // Load-bearing: the throw alone does not say the read was skipped.
        expect(mockRunInTx).not.toHaveBeenCalled();
    });
});

// ─── AISVS C12.2.3 / C12.2.4 — flagged-input threat event ───────────

describe('generateRiskSuggestions — input-anomaly threat event', () => {
    const apiInput = { assetIds: [], frameworks: ['ISO27001'] } as never;

    // The provider is rejected on purpose. The anomaly event is emitted
    // between session creation and the model call, so a failing provider
    // proves the event does not depend on generation succeeding — which is
    // the whole point of it being separate from the generation event.
    const runWithFailingProvider = async () => {
        mockGetProvider.mockReturnValueOnce({
            providerName: 'mock-provider',
            generateSuggestions: jest.fn().mockRejectedValue(new Error('provider_down')),
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
        ).rejects.toThrow(/provider_down/);
    };

    const anomalyEvents = () =>
        mockLog.mock.calls.filter((c) => c[2]?.action === 'AI_RISK_INPUT_ANOMALY');

    it('emits AI_RISK_INPUT_ANOMALY when the input screen flags something', async () => {
        mockDetectAnomalies.mockReturnValue({
            flagged: true,
            anomalies: [
                { field: 'tenantContext', kind: 'zero-width', snippet: 'ab​cd' },
                { field: 'frameworks[0]', kind: 'base64', snippet: 'aWdub3Jl' },
            ],
        } as never);

        await runWithFailingProvider();

        const [event] = anomalyEvents();
        expect(event).toBeDefined();
        expect(event[2]).toMatchObject({
            action: 'AI_RISK_INPUT_ANOMALY',
            entityType: 'RiskSuggestionSession',
            entityId: 's1',
            detailsJson: expect.objectContaining({
                category: 'custom',
                event: 'ai_risk_input_anomaly',
            }),
            metadata: expect.objectContaining({ anomalyCount: 2 }),
        });
        // Kinds are de-duplicated into a set; two distinct kinds stay two.
        expect(event[2].metadata).toMatchObject({ kinds: ['zero-width', 'base64'] });
    });

    // Without this, the assertion above is satisfied by a usecase that emits
    // the threat event unconditionally — which would be worse than not
    // emitting it, because every generation would look like an attack.
    it('emits nothing when the input screen flags nothing', async () => {
        mockDetectAnomalies.mockReturnValue({ flagged: false, anomalies: [] });
        await runWithFailingProvider();
        expect(anomalyEvents()).toHaveLength(0);
        // The ordinary generation event still fires, so this is not just a
        // silent path.
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'AI_RISK_SUGGESTIONS_GENERATED' }),
        );
    });
});

// ─── applySession — the refusals below the state guard ──────────────

describe('applySession — permission and lookup refusals', () => {
    it('refuses a READER before opening a transaction', async () => {
        await expect(
            applySession(makeRequestContext('READER'), 's1', { acceptedItemIds: [] }),
        ).rejects.toThrow(/Only editors and admins/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    // Same shape as getSession: `findFirst` carries both the id and the
    // tenant, so another tenant's session id resolves to null and answers
    // the same 404 as a genuinely absent one.
    it('throws notFound for a session id outside the tenant', async () => {
        const findFirst = jest.fn().mockResolvedValue(null);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ riskSuggestionSession: { findFirst } } as never),
        );

        await expect(
            applySession(
                makeRequestContext('EDITOR', { tenantId: 'tenant-Q' }),
                'other-tenants-id',
                { acceptedItemIds: ['i1'] },
            ),
        ).rejects.toThrow(/not found/i);

        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'other-tenants-id', tenantId: 'tenant-Q' },
            }),
        );
    });

    // The gate runs before the permission check, so a feature-gated tenant
    // gets the gate's error rather than a misleading "permission denied" —
    // the same ordering the generate path asserts at the top of this file.
    it('runs enforceFeatureGate before the canWrite check', async () => {
        mockEnforceGate.mockImplementationOnce(() => {
            throw new Error('feature_gate');
        });
        await expect(
            applySession(makeRequestContext('READER'), 's1', { acceptedItemIds: [] }),
        ).rejects.toThrow(/feature_gate/);
    });
});

// ─── generateRiskSuggestions — the successful path ──────────────────
//
// Nothing exercised a generation that actually SUCCEEDS: every existing test
// stops at a gate, a rate limit, or a rejected provider. So the item-writing
// arm — including the asset match that decides whether a suggestion lands
// attached to an asset or orphaned — had never run.

describe('generateRiskSuggestions — successful generation', () => {
    const suggestion = (over: Record<string, unknown> = {}) => ({
        title: 'Unpatched web tier',
        description: 'Public web servers are behind on patches.',
        category: 'TECHNICAL',
        threat: 'Exploitation of a known CVE',
        vulnerability: 'Missing patches',
        likelihood: 3,
        impact: 4,
        confidence: 0.9,
        rationale: 'Derived from the asset inventory.',
        suggestedControls: ['A.8.8'],
        // Required by the REAL `applyOutputGuard`, which is deliberately not
        // mocked here — it is the gate that redacts prompt leaks and drops
        // below-floor confidence before anything is persisted, so a fixture
        // that bypassed it would be testing a path production never takes.
        structuredRationale: {
            whyThisRisk: 'Known CVE with a public exploit.',
            affectedAssetCharacteristics: ['internet-facing'],
            suggestedControlThemes: ['patch-management'],
        },
        ...over,
    });

    const runGeneration = async (opts: {
        assets: Array<{ id: string; name: string }>;
        suggestions: Array<Record<string, unknown>>;
    }) => {
        const itemCreate = jest.fn().mockImplementation((args: { data: unknown }) =>
            Promise.resolve({ id: 'item-x', ...(args.data as object) }),
        );
        const sessionUpdate = jest.fn().mockResolvedValue({ id: 's1', status: 'GENERATED' });
        mockGetProvider.mockReturnValueOnce({
            providerName: 'mock-provider',
            generateSuggestions: jest.fn().mockResolvedValue({
                provider: 'mock-provider',
                modelName: 'mock-1',
                suggestions: opts.suggestions,
                usage: { promptTokens: 120, completionTokens: 340 },
            }),
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                tenant: { findUnique: jest.fn().mockResolvedValue({ industry: 'saas', maxRiskScale: 5 }) },
                // Non-empty so the untrusted-text assembly walks the asset
                // names as well as the framework list.
                asset: { findMany: jest.fn().mockResolvedValue(opts.assets) },
                control: { findMany: jest.fn().mockResolvedValue([{ title: 'Patch management' }]) },
                tenantSecuritySettings: { findUnique: jest.fn().mockResolvedValue(null) },
                riskSuggestionSession: {
                    create: jest.fn().mockResolvedValue({ id: 's1' }),
                    update: sessionUpdate,
                },
                riskSuggestionItem: { create: itemCreate },
            } as never),
        );
        const result = await generateRiskSuggestions(
            makeRequestContext('ADMIN'),
            { assetIds: opts.assets.map((a) => a.id), frameworks: ['ISO27001'] } as never,
        );
        return { result, itemCreate, sessionUpdate };
    };

    it('writes one item per suggestion and marks the session GENERATED', async () => {
        const { itemCreate, sessionUpdate } = await runGeneration({
            assets: [{ id: 'a1', name: 'Web Server' }],
            suggestions: [suggestion(), suggestion({ title: 'Weak backups' })],
        });

        expect(itemCreate).toHaveBeenCalledTimes(2);
        expect(sessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 's1' },
                data: expect.objectContaining({ status: 'GENERATED', provider: 'mock-provider' }),
            }),
        );
        // Quota is burned only on success — the mirror of the existing
        // "failed gens do NOT burn quota" test.
        expect(mockRecordGeneration).toHaveBeenCalled();
    });

    // The match is `a.name.toLowerCase() === s.relatedAssetName?.toLowerCase()`,
    // so it is case-insensitive by design. A regression to `===` on the raw
    // strings would silently orphan every suggestion whose asset name the
    // model echoed with different casing.
    it('attaches a suggestion to an asset matched case-insensitively', async () => {
        const { itemCreate } = await runGeneration({
            assets: [{ id: 'a1', name: 'Web Server' }],
            suggestions: [suggestion({ relatedAssetName: 'wEB sERVER' })],
        });
        expect(itemCreate.mock.calls[0][0].data).toMatchObject({ assetId: 'a1' });
    });

    it('leaves assetId null when the name matches nothing', async () => {
        const { itemCreate } = await runGeneration({
            assets: [{ id: 'a1', name: 'Web Server' }],
            suggestions: [suggestion({ relatedAssetName: 'Mail Relay' })],
        });
        expect(itemCreate.mock.calls[0][0].data).toMatchObject({ assetId: null });
    });

    it('leaves assetId null when the model named no asset at all', async () => {
        const { itemCreate } = await runGeneration({
            assets: [{ id: 'a1', name: 'Web Server' }],
            suggestions: [suggestion()],
        });
        expect(itemCreate.mock.calls[0][0].data).toMatchObject({ assetId: null });
    });
});
