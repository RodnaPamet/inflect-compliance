/**
 * Coverage wave E — the compliance-posture provider trio:
 *   • `provider.ts`            — the factory + its misconfiguration fallbacks
 *   • `anthropic-provider.ts`  — direct Claude Messages API call
 *   • `openrouter-provider.ts` — OpenRouter chat-completions call
 *
 * The two real providers are exercised through a mocked `fetch`, so the
 * tests pin the OUTBOUND REQUEST SHAPE (endpoint, auth headers, API
 * version, body) as well as the per-call fallback contract: every failure
 * mode — network throw, non-2xx, empty content, unparseable body — must
 * degrade to the deterministic summary rather than propagate.
 *
 * `prompt-builder`, `parse`, and `stub-provider` are deliberately real:
 * they are pure, and the fallback assertions are only meaningful if the
 * deterministic summary they produce is the real one.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getCompliancePostureProvider } from '@/app-layer/ai/compliance-posture/provider';
import {
    AnthropicCompliancePostureProvider,
    DEFAULT_ANTHROPIC_MODEL,
} from '@/app-layer/ai/compliance-posture/anthropic-provider';
import {
    OpenRouterCompliancePostureProvider,
    DEFAULT_OPENROUTER_MODEL,
} from '@/app-layer/ai/compliance-posture/openrouter-provider';
import { StubCompliancePostureProvider } from '@/app-layer/ai/compliance-posture/stub-provider';
import type { PostureSummaryInput } from '@/app-layer/ai/compliance-posture/types';

const fetchMock = jest.fn();

function makeInput(over: Partial<PostureSummaryInput> = {}): PostureSummaryInput {
    return {
        controls: {
            applicable: 100,
            implemented: 70,
            inProgress: 20,
            notStarted: 10,
            coveragePercent: 70,
        },
        frameworks: [
            { key: 'ISO27001', name: 'ISO/IEC 27001', mapped: 80, total: 100, coveragePercent: 80 },
        ],
        risks: { total: 4, critical: 1, high: 1, medium: 1, low: 1 },
        evidence: { overdue: 2, dueSoon: 1, current: 9 },
        findings: { open: 3 },
        tasks: { open: 5, overdue: 1 },
        policies: { total: 10, overdueReview: 1 },
        vendors: { overdueReview: 1 },
        maturityAverage: 3,
        ...over,
    };
}

const GOOD_JSON = JSON.stringify({
    summaryText: 'Posture is solid.',
    maturityScore: 71,
    postureLabel: 'ESTABLISHED',
    advice: [{ title: 'Close the criticals', detail: 'Two remain', priority: 'high' }],
});

beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});

describe('getCompliancePostureProvider — factory', () => {
    it('defaults to the deterministic stub when unconfigured', () => {
        expect(getCompliancePostureProvider()).toBeInstanceOf(
            StubCompliancePostureProvider,
        );
    });

    it('selects the stub explicitly', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'stub';
        expect(getCompliancePostureProvider()).toBeInstanceOf(
            StubCompliancePostureProvider,
        );
    });

    it('falls back to the stub on an unknown provider name', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'gpt-4';
        expect(getCompliancePostureProvider()).toBeInstanceOf(
            StubCompliancePostureProvider,
        );
    });

    it('is case-insensitive on the provider name', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'ANTHROPIC';
        mockEnv.ANTHROPIC_API_KEY = 'sk-test';
        expect(getCompliancePostureProvider()).toBeInstanceOf(
            AnthropicCompliancePostureProvider,
        );
    });

    it('builds the Anthropic provider when the key is present', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'anthropic';
        mockEnv.ANTHROPIC_API_KEY = 'sk-test';
        const p = getCompliancePostureProvider();
        expect(p).toBeInstanceOf(AnthropicCompliancePostureProvider);
        expect(p.providerName).toBe('anthropic');
    });

    it('falls back to the stub when ANTHROPIC_API_KEY is missing', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'anthropic';
        expect(getCompliancePostureProvider()).toBeInstanceOf(
            StubCompliancePostureProvider,
        );
    });

    it('builds the OpenRouter provider when the key is present', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'openrouter';
        mockEnv.OPENROUTER_API_KEY = 'or-test';
        const p = getCompliancePostureProvider();
        expect(p).toBeInstanceOf(OpenRouterCompliancePostureProvider);
        expect(p.providerName).toBe('openrouter');
    });

    it('falls back to the stub when OPENROUTER_API_KEY is missing', () => {
        mockEnv.AI_POSTURE_PROVIDER = 'openrouter';
        expect(getCompliancePostureProvider()).toBeInstanceOf(
            StubCompliancePostureProvider,
        );
    });
});

describe('AnthropicCompliancePostureProvider', () => {
    const ok = (text: string) => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text }] }),
    });

    it('defaults to the configured Haiku model', () => {
        const p = new AnthropicCompliancePostureProvider('sk-test');
        expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-haiku-4-5');
        expect(p.providerName).toBe('anthropic');
    });

    it('POSTs the Messages API with the documented headers and body shape', async () => {
        fetchMock.mockResolvedValueOnce(ok(GOOD_JSON));

        await new AnthropicCompliancePostureProvider('sk-test').generate(makeInput());

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(init.method).toBe('POST');
        expect(init.headers['x-api-key']).toBe('sk-test');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        expect(init.headers['content-type']).toBe('application/json');

        const body = JSON.parse(init.body);
        expect(body.model).toBe('claude-haiku-4-5');
        expect(body.max_tokens).toBe(600);
        expect(typeof body.system).toBe('string');
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe('user');
        // The response schema is appended to the user turn so the model has it.
        expect(body.messages[0].content).toContain('Respond with ONLY JSON');
        expect(init.signal).toBeDefined();
    });

    it('honours a model override', async () => {
        fetchMock.mockResolvedValueOnce(ok(GOOD_JSON));
        await new AnthropicCompliancePostureProvider('sk-test', 'claude-opus-5').generate(
            makeInput(),
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('claude-opus-5');
    });

    it('parses a successful response and stamps provenance', async () => {
        fetchMock.mockResolvedValueOnce(ok(GOOD_JSON));

        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );

        expect(res.summaryText).toBe('Posture is solid.');
        expect(res.maturityScore).toBe(71);
        expect(res.postureLabel).toBe('ESTABLISHED');
        expect(res.provider).toBe('anthropic');
        expect(res.model).toBe('claude-haiku-4-5');
        expect(res.isFallback).toBe(false);
    });

    it('picks the first text block when the response interleaves block types', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                content: [{ type: 'thinking' }, { type: 'text', text: GOOD_JSON }],
            }),
        });

        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );
        expect(res.isFallback).toBe(false);
    });

    it('falls back to the deterministic summary on a non-2xx response', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 429,
            text: async () => 'rate limited',
        });

        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );
        expect(res.isFallback).toBe(true);
        expect(res.summaryText.length).toBeGreaterThan(0);
    });

    it('falls back when the error body itself cannot be read', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => {
                throw new Error('stream closed');
            },
        });

        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );
        expect(res.isFallback).toBe(true);
    });

    it('falls back when the content array is empty or has no text', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ content: [] }),
        });
        expect(
            (await new AnthropicCompliancePostureProvider('sk-test').generate(makeInput()))
                .isFallback,
        ).toBe(true);

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({}),
        });
        expect(
            (await new AnthropicCompliancePostureProvider('sk-test').generate(makeInput()))
                .isFallback,
        ).toBe(true);
    });

    it('falls back when the model returns unparseable content', async () => {
        fetchMock.mockResolvedValueOnce(ok('I cannot help with that.'));
        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );
        expect(res.isFallback).toBe(true);
    });

    it('falls back on a network throw', async () => {
        fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );
        expect(res.isFallback).toBe(true);
    });

    it('falls back on a non-Error throw', async () => {
        fetchMock.mockRejectedValueOnce('a bare string');
        const res = await new AnthropicCompliancePostureProvider('sk-test').generate(
            makeInput(),
        );
        expect(res.isFallback).toBe(true);
    });
});

describe('OpenRouterCompliancePostureProvider', () => {
    const ok = (content: string) => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
    });

    it('exposes its provider name and default model', () => {
        const p = new OpenRouterCompliancePostureProvider('or-test');
        expect(p.providerName).toBe('openrouter');
        expect(DEFAULT_OPENROUTER_MODEL).toBeTruthy();
    });

    it('POSTs the chat-completions endpoint with bearer auth', async () => {
        fetchMock.mockResolvedValueOnce(ok(GOOD_JSON));

        await new OpenRouterCompliancePostureProvider('or-test').generate(makeInput());

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer or-test');
        expect(JSON.parse(init.body).model).toBe(DEFAULT_OPENROUTER_MODEL);
    });

    it('honours a model override', async () => {
        fetchMock.mockResolvedValueOnce(ok(GOOD_JSON));
        await new OpenRouterCompliancePostureProvider('or-test', 'some/model').generate(
            makeInput(),
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('some/model');
    });

    it('parses a successful response', async () => {
        fetchMock.mockResolvedValueOnce(ok(GOOD_JSON));
        const res = await new OpenRouterCompliancePostureProvider('or-test').generate(
            makeInput(),
        );
        expect(res.provider).toBe('openrouter');
        expect(res.isFallback).toBe(false);
        expect(res.summaryText).toBe('Posture is solid.');
    });

    it('falls back on a non-2xx response', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 402,
            text: async () => 'insufficient credits',
        });
        expect(
            (await new OpenRouterCompliancePostureProvider('or-test').generate(makeInput()))
                .isFallback,
        ).toBe(true);
    });

    it('falls back when the choices array carries no content', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ choices: [] }),
        });
        expect(
            (await new OpenRouterCompliancePostureProvider('or-test').generate(makeInput()))
                .isFallback,
        ).toBe(true);
    });

    it('falls back on a network throw', async () => {
        fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
        expect(
            (await new OpenRouterCompliancePostureProvider('or-test').generate(makeInput()))
                .isFallback,
        ).toBe(true);
    });
});
