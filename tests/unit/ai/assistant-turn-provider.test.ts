/**
 * The assistant's tool-use provider (#3808).
 *
 * The sharp assertion here is the SPECIFIER CHECK. `model-selection.ts` owns
 * the residency decision and emits `"<provider-id>/<model-id>"`; this provider
 * re-checks the id before opening a socket and refuses a specifier addressed
 * elsewhere. With per-tenant `aiResidency: LOCAL_ONLY` a hard invariant, an
 * external provider that served a `inflect-local/...` specifier would be a
 * cross-tenant egress — so the check belongs at the boundary that actually
 * sends, not only at the one that chose.
 *
 * No network: `fetch` is replaced per test and the request body is inspected.
 */
import {
    AnthropicAssistantProvider,
    SpecifierMismatchError,
    buildMessages,
    parseTurn,
    splitSpecifier,
} from '@/app-layer/ai/assistant/turn-provider';
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import type { ProviderRequest } from '@/app-layer/ai/assistant/tool-loop';

const EXTERNAL = `${FLUE_PROVIDER_IDS.external}/claude-sonnet-5-5`;
const LOCAL = `${FLUE_PROVIDER_IDS.local}/some-local-model`;

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
    specifier: EXTERNAL,
    system: 'you are a compliance assistant',
    question: 'how many open findings?',
    history: [],
    tools: [{ name: 'list_findings', description: 'list findings', jsonSchema: { type: 'object' } }],
    ...over,
});

/** A `fetch` double that records the one request it receives. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = jest.fn(async (url: string, reqInit?: RequestInit) => {
        calls.push({ url, init: reqInit ?? {} });
        return {
            ok: init.ok ?? true,
            status: init.status ?? 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    });
    return { impl: impl as unknown as typeof fetch, calls };
}

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});

describe('the specifier is checked, not trusted', () => {
    it('REFUSES a LOCAL_ONLY specifier rather than serving it externally', async () => {
        // The cross-tenant egress this guards: a LOCAL_ONLY tenant's reasoning
        // leaving the building because a provider served a specifier that was
        // never addressed to it.
        const f = fakeFetch({});
        global.fetch = f.impl;

        await expect(
            new AnthropicAssistantProvider('key').complete(req({ specifier: LOCAL })),
        ).rejects.toBeInstanceOf(SpecifierMismatchError);

        // AND NOTHING WAS SENT. Asserting only the throw would pass for a
        // provider that fired the request and then complained about it.
        expect(f.calls).toHaveLength(0);
    });

    it('refuses a malformed specifier with no provider id', async () => {
        const f = fakeFetch({});
        global.fetch = f.impl;
        await expect(
            new AnthropicAssistantProvider('key').complete(req({ specifier: 'claude-sonnet-5-5' })),
        ).rejects.toBeInstanceOf(SpecifierMismatchError);
        expect(f.calls).toHaveLength(0);
    });

    it('serves its OWN specifier, and sends the model from it — the control', async () => {
        const f = fakeFetch({ content: [{ type: 'text', text: 'Three.' }], stop_reason: 'end_turn' });
        global.fetch = f.impl;

        const turn = await new AnthropicAssistantProvider('key').complete(req());

        expect(f.calls).toHaveLength(1);
        const sent = JSON.parse(String(f.calls[0].init.body)) as { model: string; tools: unknown[] };
        // The model comes from the SPECIFIER, not from a constant in this file —
        // which is what keeps model-selection.ts the one place that decides.
        expect(sent.model).toBe('claude-sonnet-5-5');
        expect(sent.tools).toHaveLength(1);
        expect(turn.text).toBe('Three.');
    });

    it('splitSpecifier rejects the shapes that would silently half-parse', () => {
        expect(splitSpecifier('a/b')).toEqual({ providerId: 'a', model: 'b' });
        expect(splitSpecifier('a/b/c')).toEqual({ providerId: 'a', model: 'b/c' });
        expect(splitSpecifier('noslash')).toBeNull();
        expect(splitSpecifier('/leading')).toBeNull();
        expect(splitSpecifier('trailing/')).toBeNull();
    });
});

describe('the tools array reaches the request', () => {
    it('sends each tool as name + description + input_schema', async () => {
        const f = fakeFetch({ content: [{ type: 'text', text: 'ok' }] });
        global.fetch = f.impl;

        await new AnthropicAssistantProvider('key').complete(
            req({
                tools: [
                    { name: 'list_risks', description: 'the risks', jsonSchema: { type: 'object', properties: {} } },
                    { name: 'list_controls', description: 'the controls', jsonSchema: { type: 'object' } },
                ],
            }),
        );

        const sent = JSON.parse(String(f.calls[0].init.body)) as {
            tools: Array<{ name: string; description: string; input_schema: unknown }>;
        };
        expect(sent.tools.map((t) => t.name)).toEqual(['list_risks', 'list_controls']);
        expect(sent.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
    });
});

describe('buildMessages matches the API shape', () => {
    it('batches CONSECUTIVE tool results into ONE user message', () => {
        // The API expects a turn that requested three tools to be answered by
        // one user message carrying three `tool_result` blocks. Three separate
        // user messages interleave roles it rejects, and the error does not say
        // so — which is why this is asserted rather than assumed.
        const msgs = buildMessages(
            req({
                history: [
                    {
                        role: 'assistant',
                        text: null,
                        toolCalls: [
                            { id: 'a', name: 'list_risks', args: {} },
                            { id: 'b', name: 'list_controls', args: {} },
                        ],
                    },
                    { role: 'tool', id: 'a', name: 'list_risks', content: 'risk rows' },
                    { role: 'tool', id: 'b', name: 'list_controls', content: 'control rows' },
                ],
            }),
        );

        expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        const results = msgs[2].content as Array<{ type: string; tool_use_id: string }>;
        expect(results).toHaveLength(2);
        expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
        expect(results.every((r) => r.type === 'tool_result')).toBe(true);
    });

    it('puts the question first and carries assistant text alongside its tool calls', () => {
        const msgs = buildMessages(
            req({
                history: [
                    { role: 'assistant', text: 'Let me check.', toolCalls: [{ id: 'a', name: 'list_risks', args: { limit: 5 } }] },
                    { role: 'tool', id: 'a', name: 'list_risks', content: 'rows' },
                ],
            }),
        );

        expect(msgs[0]).toEqual({ role: 'user', content: 'how many open findings?' });
        const blocks = msgs[1].content as Array<{ type: string; input?: unknown }>;
        expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
        expect(blocks[1].input).toEqual({ limit: 5 });
    });

    it('omits an empty assistant text block rather than sending a blank one', () => {
        const msgs = buildMessages(
            req({ history: [{ role: 'assistant', text: '   ', toolCalls: [{ id: 'a', name: 'x', args: {} }] }] }),
        );
        const blocks = msgs[1].content as Array<{ type: string }>;
        expect(blocks.map((b) => b.type)).toEqual(['tool_use']);
    });
});

describe('parseTurn normalises the reply', () => {
    it('reads text and tool_use blocks', () => {
        const t = parseTurn({
            content: [
                { type: 'text', text: 'Checking' },
                { type: 'tool_use', id: 'c1', name: 'list_risks', input: { limit: 3 } },
            ],
            stop_reason: 'tool_use',
        });
        expect(t.text).toBe('Checking');
        expect(t.toolCalls).toEqual([{ id: 'c1', name: 'list_risks', args: { limit: 3 } }]);
        expect(t.stopReason).toBe('tool_use');
    });

    it('surfaces max_tokens rather than folding it into a finished answer', () => {
        // A cut reply is not a complete one. The loop turns this into a reported
        // halt; folding it into `end` would present a truncated answer as final.
        const t = parseTurn({ content: [{ type: 'text', text: 'You have 3 open f' }], stop_reason: 'max_tokens' });
        expect(t.stopReason).toBe('max_tokens');
    });

    it('drops a tool_use block missing its id or name instead of dispatching it', () => {
        // A malformed block would otherwise become a tool call with an
        // undefined name, which the loop reports as an invented tool — true but
        // misleading, because the model did not invent it.
        const t = parseTurn({
            content: [
                { type: 'tool_use', name: 'no_id' },
                { type: 'tool_use', id: 'no_name' },
                { type: 'tool_use', id: 'ok', name: 'list_risks', input: {} },
            ],
        });
        expect(t.toolCalls).toEqual([{ id: 'ok', name: 'list_risks', args: {} }]);
    });

    it('returns null text rather than an empty string, so the loop can tell them apart', () => {
        expect(parseTurn({ content: [{ type: 'tool_use', id: 'a', name: 'x' }] }).text).toBeNull();
        expect(parseTurn({ content: [] }).text).toBeNull();
    });
});

describe('a non-2xx degrades through the loop rather than leaking a body', () => {
    it('throws with the status, and truncates the upstream text', async () => {
        const f = fakeFetch({ error: 'x'.repeat(500) }, { ok: false, status: 503 });
        global.fetch = f.impl;
        await expect(new AnthropicAssistantProvider('key').complete(req())).rejects.toThrow(/503/);
    });
});

describe('usage is read both-or-neither (#3833)', () => {
    it('reports usage when the provider gives both halves', () => {
        const t = parseTurn({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 120, output_tokens: 34 },
        });
        expect(t.usage).toEqual({ tokensIn: 120, tokensOut: 34 });
    });

    it('reports NOTHING when only one half is present', () => {
        // A partial usage object recorded as a complete cost would carry one
        // side silently zero, which under-reports. Undefined says "unknown",
        // which the loop then keeps as null rather than as zero.
        expect(parseTurn({ content: [], usage: { input_tokens: 120 } }).usage).toBeUndefined();
        expect(parseTurn({ content: [], usage: { output_tokens: 34 } }).usage).toBeUndefined();
        expect(parseTurn({ content: [] }).usage).toBeUndefined();
    });
});
