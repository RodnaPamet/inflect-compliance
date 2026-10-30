/**
 * `clientForRun` — the one place an Anthropic client is built for an agent run
 * (Step 2a of `docs/claude-tool-runner-design.md`, #4148).
 *
 * Four things are proved here, each by a test that goes red if it breaks:
 *
 *   1. Residency decides first. A LOCAL_ONLY run is refused with a named
 *      reason and the SDK's constructor is NEVER called, even on a deployment
 *      with a key, and even when another refusal would also apply.
 *   2. Every other refusal is named, and builds nothing either.
 *   3. What the SDK would read from the environment is pinned: with
 *      `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` set to hostile values in
 *      `process.env`, the client still talks to Anthropic's API at 'warn'. The
 *      request a client sends is read off a `fetch` double, so the test sees
 *      the host, the key and the workspace header exactly as they leave.
 *   4. No two runs share a client. Two calls, for two tenants, in flight at the
 *      same time, get two instances with two header maps, and each request
 *      carries its own model.
 *   5. A run's client sends Messages calls only. Another API, a server-held
 *      thread, an MCP connector or a server tool is refused before `fetch` is
 *      reached.
 *
 * The SDK is the real one. Its default export is wrapped in a `jest.fn` that
 * constructs the real class, so the test can both count constructions and use
 * what was constructed.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@anthropic-ai/sdk', () => {
    const actual = jest.requireActual('@anthropic-ai/sdk');
    const Ctor = jest.fn((opts: unknown) => new actual.default(opts));
    return { __esModule: true, ...actual, default: Ctor };
});

import {
    clientForRun,
    inspectRequest,
    requestRefusal,
    toolRunnerModelFor,
    ANTHROPIC_API_BASE_URL,
    TOOL_RUNNER_DEFAULT_MODELS,
} from '@/lib/agentic/tool-runner/client';
import { residencyTermsFrom } from '@/lib/agentic/flue/model-selection';
import { logger } from '@/lib/observability';

const sdk = jest.requireMock('@anthropic-ai/sdk') as { default: jest.Mock };

const PROCESS_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_LOG', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_WEBHOOK_SIGNING_KEY'] as const;
const savedProcessEnv: Record<string, string | undefined> = {};
const originalFetch = global.fetch;

beforeEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    sdk.default.mockClear();
    for (const key of PROCESS_ENV_KEYS) savedProcessEnv[key] = process.env[key];
});

afterEach(() => {
    for (const key of PROCESS_ENV_KEYS) {
        if (savedProcessEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedProcessEnv[key];
    }
    global.fetch = originalFetch;
});

const EXTERNAL = residencyTermsFrom({ aiResidency: 'EXTERNAL', aiLocalBaseUrl: null, aiLocalModel: null });
const LOCAL_ONLY = residencyTermsFrom({ aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: 'http://gateway.internal', aiLocalModel: 'local-model' });

/** A request as it leaves the client. */
type Sent = { url: string; headers: Headers; body: { model: string; messages: Array<{ content: string }> } };

/**
 * A `fetch` double that records every request and holds each open until the
 * test releases it, so two requests can be provably in flight together.
 */
function gatedFetch() {
    const sent: Sent[] = [];
    const gates: Array<() => void> = [];
    const impl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        await new Promise<void>((resolve) => gates.push(resolve));
        return new Response(
            JSON.stringify({
                id: `msg_${sent.length}`,
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    });
    return { impl: impl as unknown as typeof fetch, sent, gates };
}

/** The constructor's options, as the SDK received them. */
const optionsOf = (call: number) => sdk.default.mock.calls[call][0] as Record<string, unknown>;

describe('1. residency decides first', () => {
    it('refuses a LOCAL_ONLY run by name and never constructs a client', () => {
        expect(clientForRun(LOCAL_ONLY)).toEqual({ ok: false, reason: 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED' });
        expect(sdk.default).not.toHaveBeenCalled();
    });

    it('refuses LOCAL_ONLY before reading anything external, so its reason wins over every other', () => {
        delete mockEnv.ANTHROPIC_API_KEY;
        mockEnv.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-beta: something';
        expect(clientForRun(LOCAL_ONLY)).toEqual({ ok: false, reason: 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED' });
        expect(sdk.default).not.toHaveBeenCalled();
    });

    it('builds a client for an EXTERNAL run, and for a tenant with no posture row', () => {
        for (const selection of [EXTERNAL, undefined]) {
            const choice = clientForRun(selection);
            expect(choice.ok).toBe(true);
            if (choice.ok) expect(choice.residency).toBe('EXTERNAL');
        }
        expect(sdk.default).toHaveBeenCalledTimes(2);
    });
});

describe('2. every other refusal is named, and builds nothing', () => {
    it.each([
        ['absent', undefined],
        ['empty', ''],
        ['whitespace', '   '],
    ])('no key (%s) is EXTERNAL_CREDENTIAL_NOT_CONFIGURED', (_label, key) => {
        mockEnv.ANTHROPIC_API_KEY = key;
        expect(clientForRun(EXTERNAL)).toEqual({ ok: false, reason: 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED' });
        expect(sdk.default).not.toHaveBeenCalled();
    });

    it('ANTHROPIC_CUSTOM_HEADERS set is SDK_AMBIENT_HEADERS_SET: the SDK would add it to every request', () => {
        mockEnv.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-beta: some-beta';
        expect(clientForRun(EXTERNAL)).toEqual({ ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' });
        expect(sdk.default).not.toHaveBeenCalled();
    });

    it('the refusal is not over-eager: a blank ANTHROPIC_CUSTOM_HEADERS refuses nothing', () => {
        mockEnv.ANTHROPIC_CUSTOM_HEADERS = '  ';
        expect(clientForRun(EXTERNAL).ok).toBe(true);
    });
});

describe('3. what the SDK would take from the environment is pinned', () => {
    it('passes the pinned options to the constructor', () => {
        clientForRun(EXTERNAL);
        expect(optionsOf(0)).toEqual(
            expect.objectContaining({
                apiKey: 'sk-ant-test-key',
                baseURL: 'https://api.anthropic.com',
                webhookKey: null,
                logLevel: 'warn',
                openTelemetry: { propagation: false, traces: { enabled: true, contentMode: 'metadata_only' } },
            }),
        );
        expect(ANTHROPIC_API_BASE_URL).toBe('https://api.anthropic.com');
    });

    it('a hostile process environment moves neither the host nor the log level', async () => {
        process.env.ANTHROPIC_BASE_URL = 'https://collector.example';
        process.env.ANTHROPIC_LOG = 'debug';
        process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY = 'whsec_from_env';
        const net = gatedFetch();
        global.fetch = net.impl;

        const choice = clientForRun(EXTERNAL);
        if (!choice.ok) throw new Error(choice.reason);
        expect(choice.client.baseURL).toBe('https://api.anthropic.com');
        expect(choice.client.logLevel).toBe('warn');
        expect(choice.client.webhookKey).toBeNull();
        expect(choice.client.openTelemetry.traces).toEqual(expect.objectContaining({ contentMode: 'metadata_only' }));
        expect(choice.client.openTelemetry.propagation).toBe(false);

        const reply = choice.client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        await waitFor(() => net.sent.length === 1);
        net.gates.forEach((release) => release());
        await reply;
        expect(new URL(net.sent[0].url).origin).toBe('https://api.anthropic.com');
        // SDK 1.x sends the key as a bearer token, not `x-api-key`.
        expect(net.sent[0].headers.get('authorization')).toBe('Bearer sk-ant-test-key');
    });

    it('speaks API version 2026-10-21, so a bump that moves it fails here rather than in a run', async () => {
        // The SDK hard-codes the version it speaks, and 2026-10-21 changes what
        // a Messages request may carry (no temperature / top_p / top_k; no
        // document block in an assistant turn; no cited text in a user turn).
        // The Tool Runner engine is written against this version; an SDK
        // release that moves it is a change to the engine's contract, so it
        // has to be seen, and this is where.
        const net = gatedFetch();
        global.fetch = net.impl;
        const choice = clientForRun(EXTERNAL);
        if (!choice.ok) throw new Error(choice.reason);
        const reply = choice.client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        await waitFor(() => net.sent.length === 1);
        net.gates.forEach((release) => release());
        await reply;
        expect(net.sent[0].headers.get('anthropic-version')).toBe('2026-10-21');
    });

    it('carries the workspace header when one is configured, and none when not', async () => {
        const net = gatedFetch();
        global.fetch = net.impl;
        mockEnv.ANTHROPIC_WORKSPACE_ID = 'wrkspc_test';
        const withWorkspace = clientForRun(EXTERNAL);
        delete mockEnv.ANTHROPIC_WORKSPACE_ID;
        const without = clientForRun(EXTERNAL);
        if (!withWorkspace.ok || !without.ok) throw new Error('expected two clients');

        const params = { model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user' as const, content: 'hi' }] };
        const replies = [withWorkspace.client.messages.create(params), without.client.messages.create(params)];
        await waitFor(() => net.sent.length === 2);
        net.gates.forEach((release) => release());
        await Promise.all(replies);
        const workspaces = net.sent.map((s) => s.headers.get('anthropic-workspace-id'));
        expect(workspaces.sort()).toEqual([null, 'wrkspc_test'].sort());
    });
});

describe('4. no two runs share a client', () => {
    it('two calls in flight together get two instances, two header maps, and keep their own requests', async () => {
        const net = gatedFetch();
        global.fetch = net.impl;
        mockEnv.ANTHROPIC_WORKSPACE_ID = 'wrkspc_shared';

        // Tenant A and tenant B, both EXTERNAL, start at the same moment.
        const a = clientForRun(EXTERNAL);
        const b = clientForRun(EXTERNAL);
        if (!a.ok || !b.ok) throw new Error('expected two clients');
        expect(a.client).not.toBe(b.client);
        expect(sdk.default).toHaveBeenCalledTimes(2);
        expect(optionsOf(0).defaultHeaders).not.toBe(optionsOf(1).defaultHeaders);

        const replyA = a.client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'tenant A' }] });
        const replyB = b.client.messages.create({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'tenant B' }] });
        // Both requests are on the wire before either is answered.
        await waitFor(() => net.sent.length === 2);
        expect(net.gates).toHaveLength(2);
        net.gates.forEach((release) => release());
        await Promise.all([replyA, replyB]);

        const byContent = Object.fromEntries(net.sent.map((s) => [s.body.messages[0].content, s.body.model]));
        expect(byContent).toEqual({ 'tenant A': 'claude-sonnet-5-5', 'tenant B': 'claude-opus-5-5' });
        for (const s of net.sent) expect(s.headers.get('anthropic-workspace-id')).toBe('wrkspc_shared');
    });

    it('a LOCAL_ONLY tenant starting beside an EXTERNAL one is still refused, and builds nothing', () => {
        const a = clientForRun(EXTERNAL);
        const b = clientForRun(LOCAL_ONLY);
        expect(a.ok).toBe(true);
        expect(b).toEqual({ ok: false, reason: 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED' });
        expect(sdk.default).toHaveBeenCalledTimes(1);
    });
});

describe('5. a run\'s client sends Messages calls only', () => {
    const MESSAGES = 'https://api.anthropic.com/v1/messages';
    const post = (body: unknown, url = MESSAGES) => ({ method: 'POST', url, body: JSON.stringify(body) });
    const base = { model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

    it.each([
        ['a plain Messages call', post(base)],
        ['the beta endpoint, which adds only a query', post(base, `${MESSAGES}?beta=true`)],
        ['a custom tool, with and without its type', post({ ...base, tools: [{ name: 'list_risks', input_schema: {} }, { type: 'custom', name: 'b', input_schema: {} }] })],
        ['thread: null, the explicit none', post({ ...base, thread: null })],
    ])('allows %s', (_label, request) => {
        expect(requestRefusal(request)).toBeNull();
    });

    it.each([
        ['another origin', post(base, 'https://collector.example/v1/messages'), 'NOT_THE_PINNED_ORIGIN'],
        ['the Files API', { method: 'GET', url: 'https://api.anthropic.com/v1/files' }, 'NOT_A_MESSAGES_CALL'],
        ['token counting, not needed yet', post(base, `${MESSAGES}/count_tokens`), 'NOT_A_MESSAGES_CALL'],
        ['a GET of the messages path', { method: 'GET', url: MESSAGES }, 'NOT_A_MESSAGES_CALL'],
        ['a body that is not text', { method: 'POST', url: MESSAGES, body: new Uint8Array([1]) }, 'BODY_UNREADABLE'],
        ['a body that is not JSON', { method: 'POST', url: MESSAGES, body: '{' }, 'BODY_UNREADABLE'],
        ['a body that is an array', post([base]), 'BODY_UNREADABLE'],
        ['a server-held thread', post({ ...base, thread: { type: 'create' } }), 'SERVER_HELD_STATE'],
        ['a container', post({ ...base, container: 'container_1' }), 'SERVER_HELD_STATE'],
        ['the MCP connector', post({ ...base, mcp_servers: [{ type: 'url', url: 'https://mcp.example', name: 'x' }] }), 'SERVER_HELD_STATE'],
        ['a server tool', post({ ...base, tools: [{ type: 'web_search_20260209', name: 'web_search' }] }), 'SERVER_TOOL'],
        ['an Anthropic-defined client tool, which the funnel does not run', post({ ...base, tools: [{ type: 'bash_20250124', name: 'bash' }] }), 'SERVER_TOOL'],
        ['a tools member that is not a list', post({ ...base, tools: {} }), 'BODY_UNREADABLE'],
    ])('refuses %s', (_label, request, reason) => {
        expect(requestRefusal(request)).toBe(reason);
    });

    it('a real client refuses before fetch: another API, and a Messages call asking for a thread', async () => {
        const net = gatedFetch();
        global.fetch = net.impl;
        const choice = clientForRun(EXTERNAL);
        if (!choice.ok) throw new Error(choice.reason);

        await expect(choice.client.models.list()).rejects.toMatchObject({ details: { reason: 'NOT_A_MESSAGES_CALL' } });
        await expect(
            choice.client.beta.messages.create({ ...base, messages: [{ role: 'user', content: 'hi' }], thread: { type: 'create' } }),
        ).rejects.toMatchObject({ details: { reason: 'SERVER_HELD_STATE' } });
        expect(net.impl).not.toHaveBeenCalled();
    });
});

describe('6. every request is logged by shape: names, never values (Step 2H)', () => {
    const PROMPT = 'PROMPT-TEXT-THAT-MUST-NOT-BE-LOGGED-91';
    const body = {
        model: 'claude-sonnet-5-5',
        max_tokens: 16,
        system: [{ type: 'text' as const, text: PROMPT }],
        messages: [{ role: 'user' as const, content: PROMPT }],
    };

    it('reads the method, the path and the member names, and whether a thread member is there', () => {
        const url = 'https://api.anthropic.com/v1/messages?beta=true';
        expect(inspectRequest({ method: 'post', url, body: JSON.stringify(body) }).shape).toEqual({
            method: 'POST',
            path: '/v1/messages',
            bodyKeys: ['max_tokens', 'messages', 'model', 'system'],
            threadMember: 'absent',
        });
        expect(inspectRequest({ method: 'POST', url, body: JSON.stringify({ ...body, thread: { type: 'create' } }) })).toMatchObject({
            refusal: 'SERVER_HELD_STATE',
            shape: { threadMember: 'present' },
        });
        expect(inspectRequest({ method: 'POST', url, body: '{' }).shape.bodyKeys).toEqual([]);
    });

    it('a real client logs each request it sends, with its run id, and no value from the body', async () => {
        const info = jest.spyOn(logger, 'info');
        try {
            const net = gatedFetch();
            global.fetch = net.impl;
            const choice = clientForRun(EXTERNAL, { runId: 'run-log-1' });
            if (!choice.ok) throw new Error(choice.reason);
            const sent = choice.client.beta.messages.create(body);
            await new Promise((resolve) => setImmediate(resolve));
            net.gates.splice(0).forEach((release) => release());
            await sent;

            const lines = info.mock.calls.filter(([message]) => message === 'tool-runner: request');
            expect(lines).toHaveLength(1);
            expect(lines[0][1]).toEqual({
                component: 'agentic',
                runId: 'run-log-1',
                method: 'POST',
                path: '/v1/messages',
                bodyKeys: ['max_tokens', 'messages', 'model', 'system'],
                threadMember: 'absent',
                refused: null,
            });
            // The request did carry the text, so its absence from the log is the log's doing.
            expect(JSON.stringify(net.sent[0].body)).toContain(PROMPT);
            expect(JSON.stringify(info.mock.calls)).not.toContain(PROMPT);
        } finally {
            info.mockRestore();
        }
    });

    it('a refused request is logged with its reason before it is refused', async () => {
        const info = jest.spyOn(logger, 'info');
        try {
            const net = gatedFetch();
            global.fetch = net.impl;
            const choice = clientForRun(EXTERNAL, { runId: 'run-log-2' });
            if (!choice.ok) throw new Error(choice.reason);
            await expect(choice.client.beta.messages.create({ ...body, thread: { type: 'create' } })).rejects.toMatchObject({
                details: { reason: 'SERVER_HELD_STATE' },
            });
            const lines = info.mock.calls.filter(([message]) => message === 'tool-runner: request');
            expect(lines.map(([, fields]) => fields)).toEqual([
                expect.objectContaining({ runId: 'run-log-2', threadMember: 'present', refused: 'SERVER_HELD_STATE' }),
            ]);
            expect(net.impl).not.toHaveBeenCalled();
        } finally {
            info.mockRestore();
        }
    });
});

describe('the model a profile tier runs on', () => {
    it('defaults to Sonnet for balanced and Opus for deep', () => {
        expect(TOOL_RUNNER_DEFAULT_MODELS).toEqual({ balanced: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' });
        expect(toolRunnerModelFor('balanced')).toBe('claude-sonnet-5-5');
        expect(toolRunnerModelFor('deep')).toBe('claude-opus-5-5');
    });

    it('takes each tier from its own variable, and a blank one falls back', () => {
        mockEnv.AGENT_TOOL_RUNNER_MODEL_BALANCED = 'claude-haiku-5-5';
        mockEnv.AGENT_TOOL_RUNNER_MODEL_DEEP = '  ';
        expect(toolRunnerModelFor('balanced')).toBe('claude-haiku-5-5');
        expect(toolRunnerModelFor('deep')).toBe('claude-opus-5-5');
    });
});

/** Polls until `ready` holds; the SDK awaits internally before it calls fetch. */
async function waitFor(ready: () => boolean, attempts = 200): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('condition never held');
}
