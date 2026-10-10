/**
 * `POST /api/t/:tenantSlug/agent-proposals/compose/intent` — the typed-phrase
 * entrance to the compose step.
 *
 * The pieces it orchestrates are tested on their own: the resolver in
 * `intent-grant-resolver.test.ts`, the residency gate in
 * `intent-chooser-for-tenant.test.ts`, compose in
 * `external-write-compose.test.ts`. What is left for this file is the WIRING,
 * and in particular two properties that only exist at this layer:
 *
 *  - the residency gate runs BEFORE the phrase reaches anything, so a tenant
 *    with no local model never has its text read;
 *  - the budget handed to the gate covers the TWO model calls the resolver
 *    actually makes, not one.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intentChooserForTenant = jest.fn<any, any[]>();
const describeIntentChooserRefusal = jest.fn((r: string) => `chooser-refusal:${r}`);
jest.mock('@/app-layer/ai/intent/chooser-for-tenant', () => ({
    intentChooserForTenant: (...a: unknown[]) => intentChooserForTenant(...a),
    describeIntentChooserRefusal: (r: string) => describeIntentChooserRefusal(r),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveGrantIntent = jest.fn<any, any[]>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const describeIntentRefusal = jest.fn<any, any[]>(() => 'intent-refusal-sentence');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const describeIntentForReviewer = jest.fn<any, any[]>(() => 'READINGS · and the phrase');
jest.mock('@/app-layer/ai/intent/grant-intent', () => ({
    resolveGrantIntent: (...a: unknown[]) => resolveGrantIntent(...a),
    describeIntentRefusal: (...a: unknown[]) => describeIntentRefusal(...a),
    describeIntentForReviewer: (...a: unknown[]) => describeIntentForReviewer(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const composeExternalWriteProposal = jest.fn<any, any[]>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const describeComposeRefusal = jest.fn<any, any[]>(() => 'compose-refusal-sentence');
jest.mock('@/app-layer/usecases/external-write-compose', () => ({
    composeExternalWriteProposal: (...a: unknown[]) => composeExternalWriteProposal(...a),
    describeComposeRefusal: (...a: unknown[]) => describeComposeRefusal(...a),
}));

import { LAYA_TIMEOUT_MS } from '@/app-layer/ai/identity-match/laya-provider';
import { POST } from '@/app/api/t/[tenantSlug]/agent-proposals/compose/intent/route';

function post(body: unknown) {
    const req = {
        method: 'POST',
        headers: { get: () => null },
        nextUrl: { pathname: '/api/t/acme/agent-proposals/compose/intent' },
        json: async () => body,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return POST(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}

const RESOLVED = {
    parameterSetId: 'set-1',
    openFieldValues: { target: 'u-1', endDateTime: '2026-11-14T00:00:00.000Z' },
    phrase: 'give ivan vpn until friday',
    readings: ['Template: VPN.', 'End date: 2026-11-14 (UTC).'],
};

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ tenantId: 't-1', role: 'ADMIN' });
    intentChooserForTenant.mockResolvedValue({ ok: true, chooser: { choose: jest.fn() } });
    resolveGrantIntent.mockResolvedValue({ ok: true, resolved: RESOLVED });
    composeExternalWriteProposal.mockResolvedValue({
        ok: true,
        proposalId: 'p-1',
        status: 'PENDING',
        guardVerdict: 'ALLOW',
    });
});

describe('POST compose/intent', () => {
    it('composes a proposal and returns what was understood', async () => {
        const res = await post({ phrase: 'give ivan vpn until friday' });
        expect(res.status).toBe(201);
        await expect(res.json()).resolves.toEqual({
            proposalId: 'p-1',
            status: 'PENDING',
            guardVerdict: 'ALLOW',
            readings: RESOLVED.readings,
        });
    });

    it('puts the reviewer record on the proposal as the rationale', async () => {
        await post({ phrase: 'give ivan vpn until friday' });
        expect(describeIntentForReviewer).toHaveBeenCalledWith(RESOLVED);
        expect(composeExternalWriteProposal).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                parameterSetId: 'set-1',
                rationale: 'READINGS · and the phrase',
            }),
        );
    });

    it('checks residency BEFORE the phrase reaches the resolver', async () => {
        // The property that matters: a tenant with no local model must not
        // have its text read by anything, so the gate is not merely consulted
        // — the resolver is never reached.
        intentChooserForTenant.mockResolvedValue({
            ok: false,
            reason: 'RESIDENCY_NOT_LOCAL_ONLY',
        });
        const res = await post({ phrase: 'give ivan vpn until friday' });
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toEqual({
            error: 'chooser-refusal:RESIDENCY_NOT_LOCAL_ONLY',
        });
        expect(resolveGrantIntent).not.toHaveBeenCalled();
        expect(composeExternalWriteProposal).not.toHaveBeenCalled();
    });

    it('budgets for the TWO model calls the resolver makes', async () => {
        const before = Date.now();
        await post({ phrase: 'x' });
        const opts = intentChooserForTenant.mock.calls[0]![1] as { deadlineAt: number };
        // Strictly more than a single call's timeout — a one-call budget would
        // abort the second question mid-resolution.
        expect(opts.deadlineAt).toBeGreaterThan(before + LAYA_TIMEOUT_MS * 2);
    });

    it('returns the resolver refusal as a 409, not a 500', async () => {
        resolveGrantIntent.mockResolvedValue({ ok: false, refusal: { kind: 'date' } });
        const res = await post({ phrase: 'until some time soon' });
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toEqual({ error: 'intent-refusal-sentence' });
        expect(composeExternalWriteProposal).not.toHaveBeenCalled();
    });

    it('returns a compose refusal as a 409', async () => {
        composeExternalWriteProposal.mockResolvedValue({
            ok: false,
            refusal: { kind: 'value_refused' },
        });
        const res = await post({ phrase: 'give ivan vpn until friday' });
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toEqual({ error: 'compose-refusal-sentence' });
    });

    it('rejects a body with no phrase', async () => {
        // `withApiErrorHandling` turns `badRequest` into a 400 RESPONSE
        // rather than letting it escape, so this asserts the status.
        const res = await post({});
        expect(res.status).toBe(400);
        expect(intentChooserForTenant).not.toHaveBeenCalled();
    });

    it('rejects a body that also tries to name the template', async () => {
        // `.strict()`: choosing the template is the whole job, so a surface
        // accepting one too would be two ways to say the same thing.
        const res = await post({ phrase: 'x', parameterSetId: 'set-9' });
        expect(res.status).toBe(400);
        expect(intentChooserForTenant).not.toHaveBeenCalled();
    });

    it('rejects a body that tries to supply its own rationale', async () => {
        // The readings ARE the misparse check, so they must be server-derived.
        const res = await post({ phrase: 'x', rationale: 'approved by security' });
        expect(res.status).toBe(400);
        expect(intentChooserForTenant).not.toHaveBeenCalled();
    });
});
