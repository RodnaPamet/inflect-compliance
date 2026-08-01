/**
 * Unit coverage for the Anthropic (direct Claude API) AI risk provider — the
 * arm that shares the compliance-posture summary's key. Every branch is
 * exercised with a mocked global `fetch`; no live API call.
 *
 * The cases that matter most here are the ones that differ from the OpenRouter
 * sibling: the Claude Messages API has no request-level JSON mode, so the
 * provider must tolerate fenced / prose-wrapped output, and it reports usage as
 * input_tokens/output_tokens rather than prompt_/completion_.
 */
jest.mock('../../../src/app-layer/ai/risk-assessment/prompt-builder', () => ({
    buildRiskAssessmentPrompt: () => ({ system: 'sys', user: 'usr', responseSchema: '{}' }),
}));
jest.mock('../../../src/app-layer/ai/risk-assessment/schemas', () => ({
    RiskSuggestionOutputSchema: { parse: (x: unknown) => x },
}));
jest.mock('../../../src/app-layer/ai/risk-assessment/stub-provider', () => ({
    StubRiskSuggestionProvider: jest.fn().mockImplementation(() => ({
        generateSuggestions: jest.fn().mockResolvedValue({ suggestions: [], provider: 'stub', isFallback: true }),
    })),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import {
    AnthropicRiskSuggestionProvider,
    DEFAULT_ANTHROPIC_MODEL,
    extractJsonObject,
} from '@/app-layer/ai/risk-assessment/anthropic-provider';
import { logger } from '@/lib/observability/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const input: any = { tenantIndustry: 'fin', frameworks: [], assets: [] };
function mockFetch(impl: () => unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(impl);
}
function okResponse(body: unknown) {
    return { ok: true, json: async () => body } as unknown as Response;
}
const SUGG = { suggestions: [{ title: 'R', rationale: 'because' }] };
/** A minimal Claude Messages API success body. */
function claudeBody(text: string, extra: Record<string, unknown> = {}) {
    return { content: [{ type: 'text', text }], ...extra };
}

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('AnthropicRiskSuggestionProvider — construction', () => {
    it('warns once when the model is overridden from the pinned default', () => {
        new AnthropicRiskSuggestionProvider('key', 'claude-opus-5');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/overridden/i), expect.any(Object));
    });

    it('does not warn when using the pinned default model', () => {
        new AnthropicRiskSuggestionProvider('key');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('pins the same small model the posture summary defaults to', () => {
        expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-haiku-4-5');
    });
});

describe('AnthropicRiskSuggestionProvider — request shape', () => {
    it('sends x-api-key + anthropic-version, not a bearer token', async () => {
        mockFetch(() => Promise.resolve(okResponse(claudeBody(JSON.stringify(SUGG)))));
        await new AnthropicRiskSuggestionProvider('secret-key').generateSuggestions(input);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [url, init] = (global as any).fetch.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(init.headers['x-api-key']).toBe('secret-key');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        expect(init.headers.Authorization).toBeUndefined();

        // The prompt's system half rides the top-level `system` field, not a
        // system-role message — the Messages API has no system role.
        const body = JSON.parse(init.body);
        expect(body.system).toBe('sys');
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe('user');
        expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    });
});

describe('AnthropicRiskSuggestionProvider — response handling', () => {
    it('maps defaults + usage and flags a served-model mismatch', async () => {
        mockFetch(() => Promise.resolve(okResponse(claudeBody(JSON.stringify(SUGG), {
            model: 'claude-something-else',
            usage: { input_tokens: 3, output_tokens: 4 },
        }))));
        const out = await new AnthropicRiskSuggestionProvider('key').generateSuggestions(input);

        expect(out.provider).toBe('anthropic');
        expect(out.modelName).toBe(DEFAULT_ANTHROPIC_MODEL);
        expect(out.isFallback).toBe(false);
        expect(out.modelMismatch).toBe(true);
        // Anthropic reports input_/output_tokens; totalTokens is derived.
        expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
        expect(out.suggestions[0].confidence).toBe('medium');
        expect(out.suggestions[0].structuredRationale.whyThisRisk).toBe('because');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/different model/i), expect.any(Object));
    });

    it('omits usage when the API reports none, and reports no mismatch', async () => {
        mockFetch(() => Promise.resolve(okResponse(claudeBody(JSON.stringify(SUGG)))));
        const out = await new AnthropicRiskSuggestionProvider('key').generateSuggestions(input);
        expect(out.usage).toBeUndefined();
        expect(out.modelMismatch).toBe(false);
    });

    it('accepts a ```json fenced body (no request-level JSON mode on this API)', async () => {
        const fenced = '```json\n' + JSON.stringify(SUGG) + '\n```';
        mockFetch(() => Promise.resolve(okResponse(claudeBody(fenced))));
        const out = await new AnthropicRiskSuggestionProvider('key').generateSuggestions(input);
        expect(out.isFallback).toBe(false);
        expect(out.suggestions[0].title).toBe('R');
    });

    it('accepts a body wrapped in prose', async () => {
        const prose = `Here are the risks:\n${JSON.stringify(SUGG)}\nHope that helps.`;
        mockFetch(() => Promise.resolve(okResponse(claudeBody(prose))));
        const out = await new AnthropicRiskSuggestionProvider('key').generateSuggestions(input);
        expect(out.isFallback).toBe(false);
    });
});

describe('AnthropicRiskSuggestionProvider — degradation (never throws)', () => {
    it('falls back to the stub on a non-OK response', async () => {
        mockFetch(() => Promise.resolve({ ok: false, status: 429, text: async () => 'rate' } as unknown as Response));
        await expect(
            new AnthropicRiskSuggestionProvider('key').generateSuggestions(input),
        ).resolves.toMatchObject({ isFallback: true });
    });

    it('falls back on a network throw', async () => {
        mockFetch(() => Promise.reject(new Error('ECONNRESET')));
        await expect(
            new AnthropicRiskSuggestionProvider('key').generateSuggestions(input),
        ).resolves.toMatchObject({ isFallback: true });
    });

    it('falls back on empty content', async () => {
        mockFetch(() => Promise.resolve(okResponse({ content: [] })));
        await expect(
            new AnthropicRiskSuggestionProvider('key').generateSuggestions(input),
        ).resolves.toMatchObject({ isFallback: true });
    });

    it('falls back on unparseable text', async () => {
        mockFetch(() => Promise.resolve(okResponse(claudeBody('not json at all'))));
        await expect(
            new AnthropicRiskSuggestionProvider('key').generateSuggestions(input),
        ).resolves.toMatchObject({ isFallback: true });
    });

    it('names truncation explicitly rather than reporting a JSON error', async () => {
        // stop_reason=max_tokens yields a half-written object; without the
        // explicit check the log would blame JSON parsing for a budget problem.
        mockFetch(() => Promise.resolve(okResponse(claudeBody('{"suggestions":[{"title":"R"', {
            stop_reason: 'max_tokens',
        }))));
        const out = await new AnthropicRiskSuggestionProvider('key').generateSuggestions(input);
        expect(out.isFallback).toBe(true);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringMatching(/failed, using fallback/i),
            expect.objectContaining({ error: expect.stringMatching(/truncated at max_tokens/i) }),
        );
    });
});

describe('extractJsonObject', () => {
    it('parses a bare object', () => {
        expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    });

    it('strips a ```json fence', () => {
        expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('strips a bare ``` fence', () => {
        expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('recovers an object embedded in prose', () => {
        expect(extractJsonObject('Sure!\n{"a":1}\nDone.')).toEqual({ a: 1 });
    });

    it('throws when there is no object at all', () => {
        expect(() => extractJsonObject('no json here')).toThrow(/No parseable JSON object/);
    });
});
