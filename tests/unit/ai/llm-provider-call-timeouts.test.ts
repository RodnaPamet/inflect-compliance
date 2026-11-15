/**
 * Every OpenRouter / local-gateway call is bounded (#5305).
 *
 * The Anthropic and posture providers abort a call that takes too long; these
 * four did not. A gateway that accepted the connection and then stalled held
 * the questionnaire autofill (a loop over every item), a risk suggestion or a
 * vendor-document extraction until undici's 300 s default, so the fallback
 * each of them has never fired in time.
 *
 * `AbortSignal.timeout` is replaced with a signal the test aborts by hand, so
 * the bound is proven without waiting for it: the call carries the signal,
 * the signal's budget is the documented one, and a stalled call that the
 * signal aborts ends in the provider's own fallback rather than a hang.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));
jest.mock('@/lib/observability', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/app-layer/ai/risk-assessment/prompt-builder', () => ({
    buildRiskAssessmentPrompt: () => ({ system: 'sys', user: 'usr', responseSchema: '{}' }),
}));
jest.mock('@/app-layer/ai/risk-assessment/stub-provider', () => ({
    StubRiskSuggestionProvider: jest.fn().mockImplementation(() => ({
        generateSuggestions: jest.fn().mockResolvedValue({ suggestions: [], provider: 'stub', isFallback: true }),
    })),
}));

import {
    OpenRouterQuestionnaireProvider,
    QUESTIONNAIRE_DRAFT_TIMEOUT_MS,
} from '@/app-layer/ai/questionnaire/openrouter-provider';
import {
    OpenRouterRiskSuggestionProvider,
    OPENROUTER_RISK_TIMEOUT_MS,
} from '@/app-layer/ai/risk-assessment/openrouter-provider';
import {
    LocalRiskSuggestionProvider,
    LOCAL_RISK_TIMEOUT_MS,
} from '@/app-layer/ai/risk-assessment/local-provider';
import { extractDocument, VENDOR_DOC_EXTRACTION_TIMEOUT_MS } from '@/app-layer/ai/vendor-doc';

/** A fetch that never answers; it rejects only when its signal aborts. */
function stalledFetch(): jest.Mock {
    return jest.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
    );
}

let controller: AbortController;
let timeoutSpy: jest.SpyInstance;

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    controller = new AbortController();
    timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal);
});
afterEach(() => timeoutSpy.mockRestore());

/** Let the call reach `fetch`, then fire the bound. */
async function fireBoundOnceCalled(fetchMock: jest.Mock): Promise<void> {
    for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i += 1) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    controller.abort();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const riskInput: any = { tenantIndustry: 'fin', frameworks: [], assets: [] };

describe('each provider call carries a bound and falls back when it fires', () => {
    it('questionnaire draft: bounded, and the stall throws so the usecase falls back to the stub', async () => {
        const fetchMock = stalledFetch();
        const provider = new OpenRouterQuestionnaireProvider('key', 'model', fetchMock as unknown as typeof fetch);
        const pending = provider.draftAnswer({ question: 'q', grounding: [] } as never);
        await fireBoundOnceCalled(fetchMock);
        await expect(pending).rejects.toThrow();
        expect(timeoutSpy).toHaveBeenCalledWith(QUESTIONNAIRE_DRAFT_TIMEOUT_MS);
    });

    it('OpenRouter risk suggestions: bounded, and the stall falls back', async () => {
        const fetchMock = stalledFetch();
        global.fetch = fetchMock as unknown as typeof fetch;
        const pending = new OpenRouterRiskSuggestionProvider('key').generateSuggestions(riskInput);
        await fireBoundOnceCalled(fetchMock);
        await expect(pending).resolves.toMatchObject({ provider: 'stub', isFallback: true });
        expect(timeoutSpy).toHaveBeenCalledWith(OPENROUTER_RISK_TIMEOUT_MS);
    });

    it('local-gateway risk suggestions: bounded, and the stall falls back', async () => {
        const fetchMock = stalledFetch();
        global.fetch = fetchMock as unknown as typeof fetch;
        const pending = new LocalRiskSuggestionProvider('http://gw.local').generateSuggestions(riskInput);
        await fireBoundOnceCalled(fetchMock);
        await expect(pending).resolves.toMatchObject({ provider: 'stub', isFallback: true });
        expect(timeoutSpy).toHaveBeenCalledWith(LOCAL_RISK_TIMEOUT_MS);
    });

    it('vendor-document extraction: bounded, and the stall returns the empty extraction', async () => {
        mockEnv.AI_RISK_PROVIDER = 'openrouter';
        mockEnv.OPENROUTER_API_KEY = 'or-key';
        const fetchMock = stalledFetch();
        global.fetch = fetchMock as unknown as typeof fetch;
        const pending = extractDocument('doc');
        await fireBoundOnceCalled(fetchMock);
        await expect(pending).resolves.toMatchObject({ ok: false, provider: 'openrouter' });
        expect(timeoutSpy).toHaveBeenCalledWith(VENDOR_DOC_EXTRACTION_TIMEOUT_MS);
    });

    it('every bound is finite and below undici\'s 300 s default', () => {
        for (const ms of [
            QUESTIONNAIRE_DRAFT_TIMEOUT_MS,
            OPENROUTER_RISK_TIMEOUT_MS,
            LOCAL_RISK_TIMEOUT_MS,
            VENDOR_DOC_EXTRACTION_TIMEOUT_MS,
        ]) {
            expect(ms).toBeGreaterThan(0);
            expect(ms).toBeLessThan(300_000);
        }
    });
});
