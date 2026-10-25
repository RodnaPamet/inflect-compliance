/**
 * The assistant's tool loop carries the model's thinking blocks between turns
 * on the Anthropic provider (#4153).
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * `buildMessages` rebuilt each assistant turn from the loop's provider-neutral
 * `text` + `toolCalls`, so every `thinking` and `redacted_thinking` block the
 * API returned was dropped before the next request. On the Claude 5 models
 * thinking is on by default, and those blocks carry the model's reasoning and
 * its progress notes between tool calls. The API expects them back unchanged.
 *
 * ═══ WHAT THIS FILE HOLDS ═══
 *
 *   1. The second request carries the first response's content BYTE FOR BYTE,
 *      in order, over a faux Anthropic transport, and the prefix the replay
 *      depends on (system, tools, the question) does not move.
 *   2. A provider that sets no part gets exactly the history it always got.
 *      The assistant has one provider today (the Anthropic one), so the
 *      control is a provider written for this test, plus the two shapes
 *      `buildMessages` must keep rebuilding: a hand-built turn, and a part
 *      that is not ours.
 *   3. No thinking text reaches a log line, the decision-log row or the
 *      answer. Proved with a sentinel through the real usecase.
 */
const mockLogged: unknown[] = [];
jest.mock('@/lib/observability/logger', () => {
    const actual = jest.requireActual('@/lib/observability/logger');
    const rec =
        (level: string) =>
        (msg: string, fields?: unknown): void => {
            mockLogged.push([level, msg, fields]);
        };
    return {
        ...actual,
        log: (level: string, msg: string, fields?: unknown) => mockLogged.push([level, msg, fields]),
        logger: {
            ...actual.logger,
            debug: rec('debug'),
            info: rec('info'),
            warn: rec('warn'),
            error: rec('error'),
            fatal: rec('fatal'),
        },
    };
});

// ── The usecase's seams, as in `assistant-proposes-through-the-loop.test.ts`.
// The provider and the loop are REAL here; that is what is under test.
jest.mock('@/app-layer/ai/risk-assessment/feature-gate', () => ({ enforceFeatureGate: jest.fn() }));
jest.mock('@/app-layer/ai/risk-assessment/rate-limiter', () => ({
    checkRateLimit: jest.fn(),
    recordGeneration: jest.fn(),
}));
jest.mock('@/app-layer/ai/guard', () => ({
    guardUntrustedInput: jest.fn().mockResolvedValue({ blocked: false, reviewRequired: false }),
    guardEgress: jest.fn().mockResolvedValue({ blocked: false, reviewRequired: false }),
    assertGuardAllowed: jest.fn(),
    assertNoReviewRequired: jest.fn(),
    sanitizePlainText: (s: string) => s,
}));
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(),
    AGENTIC_SUMMARY_MAX: 4000,
    summaryCapFor: () => 4000,
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => null } }),
    ),
}));
jest.mock('@/app-layer/usecases/dashboard', () => ({
    getDashboardData: jest.fn().mockResolvedValue({ stats: {}, recentActivity: [] }),
}));
jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async () => ({ ctx: { tenantId: 't1' } })),
}));
jest.mock('@/lib/agentic/flue/model-selection', () => {
    const actual = jest.requireActual('@/lib/agentic/flue/model-selection');
    return {
        ...actual,
        RESIDENCY_SELECT: { aiResidency: true },
        residencyTermsFrom: () => ({}),
        resolveFlueModel: () => ({
            ok: true,
            residency: 'EXTERNAL',
            specifier: `${actual.FLUE_PROVIDER_IDS.external}/claude-opus-5-5`,
        }),
    };
});
jest.mock('@/app-layer/ai/assistant/turn-provider', () => {
    const actual = jest.requireActual('@/app-layer/ai/assistant/turn-provider');
    return { ...actual, assistantProviderFor: () => new actual.AnthropicAssistantProvider('sk-test') };
});
jest.mock('@/app-layer/ai/assistant/tools', () => {
    const actual = jest.requireActual('@/app-layer/ai/assistant/tools');
    return { ...actual, assistantTools: jest.fn() };
});

import { logAiDecision } from '@/app-layer/ai/decision-log';
import { assistantTools } from '@/app-layer/ai/assistant/tools';
import { askAssistant } from '@/app-layer/usecases/assistant';
import { AnthropicAssistantProvider, buildMessages, parseTurn } from '@/app-layer/ai/assistant/turn-provider';
import {
    runAssistantLoop,
    type AssistantTurnProvider,
    type LoopTool,
    type ProviderRequest,
    type ProviderTurn,
} from '@/app-layer/ai/assistant/tool-loop';
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import { makeRequestContext } from '../../helpers/make-context';

const SENTINEL = 'SENTINEL-THINKING-7f3a';
const SPECIFIER = `${FLUE_PROVIDER_IDS.external}/claude-opus-5-5`;

/** The first reply: reasoning, a note, a progress update, a redacted block and a call. */
const FIRST_CONTENT = [
    { type: 'thinking', thinking: `${SENTINEL} I should read the risks first.`, signature: 'sig-one==' },
    { type: 'text', text: '  Let me check the risk register.  ' },
    { type: 'redacted_thinking', data: 'ZW5jcnlwdGVkLWJsb2Nr' },
    { type: 'thinking', thinking: '', signature: 'sig-progress==' },
    { type: 'tool_use', id: 'toolu_01', name: 'list_risks', input: { limit: 3, status: 'OPEN' } },
];
const SECOND_CONTENT = [
    { type: 'thinking', thinking: `${SENTINEL} Three open risks.`, signature: 'sig-two==' },
    { type: 'text', text: 'You have three open risks.' },
];

/** A faux Anthropic transport: returns the scripted replies in order and records each body. */
function scriptedAnthropic(replies: unknown[]) {
    const bodies: Array<Record<string, unknown>> = [];
    let i = 0;
    const impl = jest.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        const body = replies[Math.min(i++, replies.length - 1)];
        return {
            ok: true,
            status: 200,
            json: async () => JSON.parse(JSON.stringify(body)),
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    });
    return { impl: impl as unknown as typeof fetch, bodies };
}

const REPLIES = [
    { content: FIRST_CONTENT, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
    { content: SECOND_CONTENT, stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 6 } },
];

const listRisks: LoopTool = {
    name: 'list_risks',
    description: 'list risks',
    jsonSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: async () => '[{"id":"r1"},{"id":"r2"},{"id":"r3"}]',
};

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});
beforeEach(() => {
    mockLogged.length = 0;
    jest.clearAllMocks();
});

describe('1. the second request carries the first reply byte for byte', () => {
    it('replays the assistant turn exactly as returned, in order, thinking blocks included', async () => {
        const t = scriptedAnthropic(REPLIES);
        global.fetch = t.impl;

        const result = await runAssistantLoop({
            provider: new AnthropicAssistantProvider('sk-test'),
            specifier: SPECIFIER,
            system: 'you are a compliance assistant',
            question: 'how many open risks?',
            tools: [listRisks],
        });

        expect(result.outcome).toBe('answered');
        expect(t.bodies).toHaveLength(2);
        const [first, second] = t.bodies as Array<{
            system: unknown;
            tools: unknown;
            messages: Array<{ role: string; content: unknown }>;
        }>;

        // The replayed turn, byte for byte: the same JSON, so the same blocks,
        // the same order, the same signatures and the untrimmed text.
        expect(second.messages[1].role).toBe('assistant');
        expect(JSON.stringify(second.messages[1].content)).toBe(JSON.stringify(FIRST_CONTENT));
        const thinking = (second.messages[1].content as Array<{ type: string }>).filter(
            (b) => b.type === 'thinking' || b.type === 'redacted_thinking',
        );
        expect(thinking).toEqual(FIRST_CONTENT.filter((b) => b.type !== 'text' && b.type !== 'tool_use'));

        // Then the call's result, answering the replayed tool_use by id.
        expect(second.messages[2]).toEqual({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '[{"id":"r1"},{"id":"r2"},{"id":"r3"}]' }],
        });

        // The prefix a replayed block depends on does not move between
        // round-trips: the system prompt, the tools array and the question.
        expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
        expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
        expect(JSON.stringify(second.messages[0])).toBe(JSON.stringify(first.messages[0]));
        expect(second.messages).toHaveLength(3);
    });

    it('a three-round turn keeps every earlier assistant turn unchanged', async () => {
        const middle = [
            { type: 'thinking', thinking: 'more', signature: 'sig-mid==' },
            { type: 'tool_use', id: 'toolu_02', name: 'list_risks', input: { limit: 1 } },
        ];
        const t = scriptedAnthropic([
            REPLIES[0],
            { content: middle, stop_reason: 'tool_use' },
            REPLIES[1],
        ]);
        global.fetch = t.impl;

        await runAssistantLoop({
            provider: new AnthropicAssistantProvider('sk-test'),
            specifier: SPECIFIER,
            system: 's',
            question: 'q',
            tools: [listRisks],
        });

        expect(t.bodies).toHaveLength(3);
        const second = t.bodies[1].messages as Array<{ content: unknown }>;
        const third = t.bodies[2].messages as Array<{ content: unknown }>;
        // APPEND-ONLY: the third request starts with every message the second sent.
        expect(JSON.stringify(third.slice(0, second.length))).toBe(JSON.stringify(second));
        expect(JSON.stringify(third[3].content)).toBe(JSON.stringify(middle));
    });
});

describe('2. a provider that sets no part gets the history it always got', () => {
    it('the loop adds nothing to a turn whose provider set no part', async () => {
        const seen: ProviderRequest[] = [];
        const turns: ProviderTurn[] = [
            { text: 'checking', toolCalls: [{ id: 'a', name: 'list_risks', args: { limit: 3 } }], stopReason: 'tool_use' },
            { text: 'done', toolCalls: [], stopReason: 'end' },
        ];
        let i = 0;
        const provider: AssistantTurnProvider = {
            complete: async (req) => {
                seen.push(JSON.parse(JSON.stringify(req)));
                return turns[i++];
            },
        };

        await runAssistantLoop({ provider, specifier: 'x/y', system: 's', question: 'q', tools: [listRisks] });

        // EXACT, keys included: no `providerPart` key appears, not even as undefined.
        expect(seen[1].history).toEqual([
            { role: 'assistant', text: 'checking', toolCalls: [{ id: 'a', name: 'list_risks', args: { limit: 3 } }] },
            { role: 'tool', id: 'a', name: 'list_risks', content: '[{"id":"r1"},{"id":"r2"},{"id":"r3"}]' },
        ]);
        expect(Object.keys(seen[1].history[0])).toEqual(['role', 'text', 'toolCalls']);
    });

    const base: Omit<ProviderRequest, 'history'> = {
        specifier: SPECIFIER,
        system: 's',
        question: 'q',
        tools: [],
    };

    it('a hand-built turn, and a part that is not ours, are rebuilt as before', () => {
        const toolCalls = [{ id: 'a', name: 'list_risks', args: { limit: 5 } }];
        const rebuilt = [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'a', name: 'list_risks', input: { limit: 5 } }];
        for (const providerPart of [undefined, { kind: 'someone-else', content: [{ type: 'x' }] }, { kind: 'anthropic-content' }]) {
            const msgs = buildMessages({
                ...base,
                history: [{ role: 'assistant', text: 'Let me check.', toolCalls, ...(providerPart ? { providerPart } : {}) }],
            });
            expect(msgs[1]).toEqual({ role: 'assistant', content: rebuilt });
        }
    });

    it('a reply with an unusable tool_use carries no part, so its turn is rebuilt from what was parsed', () => {
        const turn = parseTurn({
            content: [
                { type: 'thinking', thinking: '', signature: 's' },
                { type: 'tool_use', name: 'list_risks', input: {} },
                { type: 'tool_use', id: 'b', name: 'list_risks', input: {} },
            ],
            stop_reason: 'tool_use',
        });
        expect(turn.toolCalls).toHaveLength(1);
        expect(turn.providerPart).toBeUndefined();
    });

    it('a well-formed reply carries its content as the part', () => {
        const turn = parseTurn({ content: FIRST_CONTENT, stop_reason: 'tool_use' });
        expect(turn.providerPart).toEqual({ kind: 'anthropic-content', content: FIRST_CONTENT });
        // The loop-facing text never includes thinking.
        expect(turn.text).toBe('Let me check the risk register.');
    });
});

describe('3. no thinking text reaches a log line, the decision log or the answer', () => {
    it('holds through the real usecase, with a sentinel in every thinking block', async () => {
        (assistantTools as jest.Mock).mockReturnValue({
            tools: [listRisks],
            reviewRequired: () => false,
            omitted: [],
            proposals: () => [],
        });
        const t = scriptedAnthropic(REPLIES);
        global.fetch = t.impl;

        const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });
        const res = await askAssistant(ctx, { question: 'how many open risks?' });

        // The turn really went through the model, twice, with the blocks replayed.
        expect(t.bodies).toHaveLength(2);
        expect(JSON.stringify(t.bodies[1])).toContain(SENTINEL);

        expect(res.message).toContain('You have three open risks.');
        expect(JSON.stringify(res)).not.toContain(SENTINEL);

        const decisionRows = (logAiDecision as jest.Mock).mock.calls;
        expect(decisionRows.length).toBeGreaterThan(0);
        expect(JSON.stringify(decisionRows.map((c) => c.slice(1)))).not.toContain(SENTINEL);
        expect(JSON.stringify(mockLogged)).not.toContain(SENTINEL);
    });

    it('and on the path that does write a log line', async () => {
        // The happy path logs nothing at all, which would make "no log line
        // holds the sentinel" true for want of a line. A failed decision-log
        // write is the assistant's log line, so it is forced here.
        (logAiDecision as jest.Mock).mockRejectedValueOnce(new Error('decision log unavailable'));
        (assistantTools as jest.Mock).mockReturnValue({
            tools: [listRisks],
            reviewRequired: () => false,
            omitted: [],
            proposals: () => [],
        });
        global.fetch = scriptedAnthropic(REPLIES).impl;

        const ctx = makeRequestContext('ADMIN', { tenantId: 't1', userId: 'u1' });
        const res = await askAssistant(ctx, { question: 'how many open risks?' });

        expect(res.message).toContain('You have three open risks.');
        expect(mockLogged.some((entry) => (entry as unknown[])[1] === 'assistant: decision log write failed')).toBe(true);
        expect(JSON.stringify(mockLogged)).not.toContain(SENTINEL);
    });
});
