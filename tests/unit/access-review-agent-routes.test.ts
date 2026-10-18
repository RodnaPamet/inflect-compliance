/**
 * #3674 — the routes an AGENT campaign is driven through.
 *
 * The verdict route is shared with CONNECTED_APP and LEGACY_APP subjects, so
 * the property worth pinning is the dispatch: an AGENT subject goes to the
 * agent decide, which holds the owner rule and waits for the pack and the
 * narrowings, and every other subject goes where it always went. The new
 * routes forward the campaign id from the URL, so a narrowing or a sample is
 * answered only inside its own campaign. Each route's permission key is held
 * by `route-permissions.ts` and its coverage guard.
 */
const mockScopeOf = jest.fn();
const mockSubmitConnected = jest.fn();
const mockSubmitAgent = jest.fn();
const mockCreateAgent = jest.fn();
const mockPrepare = jest.fn();
const mockGetPacks = jest.fn();
const mockDecideNarrowing = jest.fn();
const mockRecordSample = jest.fn();

jest.mock('@/app-layer/usecases/access-review-connected', () => ({
    scopeOfConnectedDecision: (...a: unknown[]) => mockScopeOf(...a),
    submitConnectedDecision: (...a: unknown[]) => mockSubmitConnected(...a),
}));
jest.mock('@/app-layer/usecases/access-review-agent', () => ({
    submitAgentDecision: (...a: unknown[]) => mockSubmitAgent(...a),
    createAgentAccessReview: (...a: unknown[]) => mockCreateAgent(...a),
    prepareAgentReviewPacks: (...a: unknown[]) => mockPrepare(...a),
    getAgentReviewPacks: (...a: unknown[]) => mockGetPacks(...a),
    decideAgentNarrowing: (...a: unknown[]) => mockDecideNarrowing(...a),
    recordAgentDecisionSampleOutcome: (...a: unknown[]) => mockRecordSample(...a),
}));
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (_key: string, handler: unknown) => handler,
}));
jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (handler: unknown) => handler,
}));

import { POST as decide } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/connected-decisions/[decisionId]/route';
import { POST as createAgents } from '@/app/api/t/[tenantSlug]/access-reviews/agents/route';
import { GET as readPacks, POST as preparePacks } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/agent-packs/route';
import { POST as decideNarrowing } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/agent-narrowings/[narrowingId]/route';
import { POST as answerSample } from '@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/agent-samples/[sampleId]/route';
import { resolveRoutePermission } from '@/lib/security/route-permissions';

type Handler = (r: Request, a: unknown, c: unknown) => Promise<Response>;
const ctx = { tenantId: 't1', userId: 'u1' } as never;
const call = (h: unknown, params: Record<string, string>, body?: unknown, method = 'POST') =>
    (h as Handler)(
        new Request('https://x/api/t/acme/access-reviews/x', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: { tenantSlug: 'acme', ...params } },
        ctx,
    );

beforeEach(() => {
    jest.clearAllMocks();
    mockSubmitConnected.mockResolvedValue({ via: 'connected' });
    mockSubmitAgent.mockResolvedValue({ via: 'agent' });
    mockDecideNarrowing.mockResolvedValue({ outcome: 'ACCEPTED' });
    mockRecordSample.mockResolvedValue({ outcome: 'CONCURRED' });
});

describe('the verdict route dispatches an AGENT subject to the agent decide', () => {
    it('AGENT → submitAgentDecision, and never the generic decide', async () => {
        mockScopeOf.mockResolvedValue('AGENT');
        const res = await call(decide, { reviewId: 'ar-1', decisionId: 'd-1' }, { decision: 'CONFIRM' });
        expect(mockSubmitAgent).toHaveBeenCalledWith(ctx, 'd-1', { decision: 'CONFIRM' });
        expect(mockSubmitConnected).not.toHaveBeenCalled();
        expect(await res.json()).toEqual({ via: 'agent' });
    });

    it.each(['CONNECTED_APP', 'LEGACY_APP', null])('%s → the generic decide, unchanged', async (scope) => {
        mockScopeOf.mockResolvedValue(scope);
        await call(decide, { reviewId: 'ar-1', decisionId: 'd-1' }, { decision: 'REVOKE' });
        expect(mockSubmitConnected).toHaveBeenCalledWith(ctx, 'd-1', { decision: 'REVOKE' });
        expect(mockSubmitAgent).not.toHaveBeenCalled();
    });
});

describe('the agent routes forward the campaign from the URL', () => {
    it('create → createAgentAccessReview, 201', async () => {
        mockCreateAgent.mockResolvedValue({ accessReviewId: 'ar-1', subjectCount: 2 });
        const res = await call(createAgents, {}, { name: 'Q4', reviewerUserId: 'u-rev' });
        expect(res.status).toBe(201);
        expect(mockCreateAgent).toHaveBeenCalledWith(ctx, { name: 'Q4', reviewerUserId: 'u-rev' });
    });

    it('packs: GET reads, POST prepares', async () => {
        mockGetPacks.mockResolvedValue({ packs: [] });
        mockPrepare.mockResolvedValue({ packs: 2 });
        await call(readPacks, { reviewId: 'ar-1' }, undefined, 'GET');
        expect(mockGetPacks).toHaveBeenCalledWith(ctx, 'ar-1');
        const res = await call(preparePacks, { reviewId: 'ar-1' });
        expect(res.status).toBe(201);
        expect(mockPrepare).toHaveBeenCalledWith(ctx, 'ar-1');
    });

    it('a narrowing and a sample are answered with their campaign’s id', async () => {
        await call(decideNarrowing, { reviewId: 'ar-1', narrowingId: 'n-1' }, { outcome: 'ACCEPT' });
        expect(mockDecideNarrowing).toHaveBeenCalledWith(ctx, 'ar-1', 'n-1', { outcome: 'ACCEPT' });
        await call(answerSample, { reviewId: 'ar-1', sampleId: 's-1' }, { outcome: 'CONCURRED' });
        expect(mockRecordSample).toHaveBeenCalledWith(ctx, 'ar-1', 's-1', { outcome: 'CONCURRED' });
    });
});

describe('each agent route resolves to the key the roadmap names', () => {
    it.each([
        ['/api/t/acme/access-reviews/agents', 'POST', 'access_reviews.create'],
        ['/api/t/acme/access-reviews/ar-1/agent-packs', 'GET', 'access_reviews.view'],
        ['/api/t/acme/access-reviews/ar-1/agent-packs', 'POST', 'access_reviews.create'],
        ['/api/t/acme/access-reviews/ar-1/agent-narrowings/n-1', 'POST', 'access_reviews.decide'],
        ['/api/t/acme/access-reviews/ar-1/agent-samples/s-1', 'POST', 'access_reviews.decide'],
    ] as const)('%s %s → %s', (p, method, key) => {
        expect(resolveRoutePermission(p, method)?.permission).toBe(key);
    });
});
