/**
 * ONE CONSTRUCTOR FOR THE MANAGED AGENTS ENGINE'S CLIENT (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165).
 *
 * `managedAgentsClientFor` builds a client per run from the connection's
 * decrypted key, with the connection's workspace header. Two halves:
 *
 *   BEHAVIOUR  the client it builds carries the CONNECTION's key and workspace
 *              id, never the deployment's; an empty key and an ambient header
 *              set build nothing; two calls build two clients.
 *   STRUCTURE  `local/anthropic-client-single-seam` already confines every SDK
 *              load to `tool-runner/client.ts`. Inside that file, this holds
 *              that exactly two clients are constructed, one by each named
 *              constructor; and across `src/` (from git), that only the
 *              engine's driver, the provisioning usecase and Step 5c's
 *              clean-up usecase call this one, and
 *              that no file of the engine reaches the deployment's
 *              `clientForRun`, whose key is Inflect's, not the customer's.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@anthropic-ai/sdk', () => {
    const actual = jest.requireActual('@anthropic-ai/sdk');
    const Ctor = jest.fn((opts: unknown) => new actual.default(opts));
    return { __esModule: true, ...actual, default: Ctor };
});

import * as fs from 'fs';
import * as path from 'path';

import type Anthropic from '@anthropic-ai/sdk';

import { answeredWorkspace } from '@/lib/ai/anthropic-workspace';
import {
    ManagedAgentsWorkspaceMismatchError,
    REFUSE_MISSING_WORKSPACE_HEADER,
    failsTheCall,
    isManagedAgentsWorkspaceMismatch,
    workspaceMismatchSeen,
} from '@/lib/agentic/managed-agents/workspace-header';
import { managedAgentsClientFor } from '@/lib/agentic/tool-runner/client';
import { logger } from '@/lib/observability/logger';
import { repoRelativeFiles } from '../../helpers/repo-files';
import { codeOf, functionBodyOf } from '../../helpers/source-blocks';

const sdk = jest.requireMock('@anthropic-ai/sdk') as { default: jest.Mock };
const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const originalFetch = global.fetch;

beforeEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    // The deployment's own key: the engine's client must never carry it.
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-deployment-key'; // pragma: allowlist secret
    sdk.default.mockClear();
});

afterEach(() => {
    global.fetch = originalFetch;
});

describe('managedAgentsClientFor', () => {
    it('builds a client keyed with the connection\'s key and workspace, and pinned to Anthropic\'s API', async () => {
        const seen: Array<{ url: string; key: string | null; workspace: string | null }> = [];
        global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            // SDK 1.x sends the key as a bearer token, not `x-api-key`.
            seen.push({ url: String(input), key: headers.get('authorization'), workspace: headers.get('anthropic-workspace-id') });
            return new Response(JSON.stringify({ id: 'sesn_1', type: 'session', status: 'idle' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
        const choice = managedAgentsClientFor({ apiKey: ' sk-ant-connection-key ', workspaceId: 'wrkspc_abc' }); // pragma: allowlist secret
        if (!choice.ok) throw new Error(choice.reason);
        await choice.client.beta.sessions.retrieve('sesn_1');
        expect(seen).toEqual([
            { url: expect.stringMatching(/^https:\/\/api\.anthropic\.com\/v1\/sessions\/sesn_1/), key: 'Bearer sk-ant-connection-key', workspace: 'wrkspc_abc' },
        ]);
    });

    it('refuses a request outside the engine\'s calls before it leaves', async () => {
        const fetched = jest.fn();
        global.fetch = fetched as unknown as typeof fetch;
        const choice = managedAgentsClientFor({ apiKey: 'k', workspaceId: 'wrkspc_abc' });
        if (!choice.ok) throw new Error(choice.reason);
        await expect(
            choice.client.beta.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
        ).rejects.toThrow(/engine's own calls only/);
        expect(fetched).not.toHaveBeenCalled();
    });

    it('builds nothing for an empty key or with ambient SDK headers set', () => {
        expect(managedAgentsClientFor({ apiKey: '  ', workspaceId: 'wrkspc_abc' })).toEqual({ ok: false, reason: 'WORKSPACE_KEY_MISSING' });
        mockEnv.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-beta: x';
        expect(managedAgentsClientFor({ apiKey: 'k', workspaceId: 'wrkspc_abc' })).toEqual({ ok: false, reason: 'SDK_AMBIENT_HEADERS_SET' });
        expect(sdk.default).not.toHaveBeenCalled();
    });

    it('dials the loopback faux in a Playwright run only, decided by the deployment\'s two flags (Step 5d)', async () => {
        const urls: string[] = [];
        global.fetch = (async (input: RequestInfo | URL) => {
            urls.push(String(input));
            return new Response(JSON.stringify({ id: 'sesn_1', type: 'session', status: 'idle' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
        const before = process.env.NEXT_TEST_MODE;
        try {
            // One flag is not a Playwright run: Anthropic's host, as everywhere.
            process.env.NEXT_TEST_MODE = '1';
            mockEnv.AUTH_TEST_MODE = undefined;
            const pinned = managedAgentsClientFor({ apiKey: 'k', workspaceId: 'wrkspc_abc' });
            if (!pinned.ok) throw new Error(pinned.reason);
            await pinned.client.beta.sessions.retrieve('sesn_1');
            // Both flags: the constant loopback port, and the middleware pins THAT
            // origin, so nothing else is reachable from it either.
            mockEnv.AUTH_TEST_MODE = '1';
            const faux = managedAgentsClientFor({ apiKey: 'k', workspaceId: 'wrkspc_abc' });
            if (!faux.ok) throw new Error(faux.reason);
            await faux.client.beta.sessions.retrieve('sesn_1');
            expect(urls.map((u) => new URL(u).origin)).toEqual(['https://api.anthropic.com', 'http://127.0.0.1:3008']);
        } finally {
            if (before === undefined) delete process.env.NEXT_TEST_MODE;
            else process.env.NEXT_TEST_MODE = before;
            mockEnv.AUTH_TEST_MODE = undefined;
        }
    });

    it('builds a new client per call', () => {
        const a = managedAgentsClientFor({ apiKey: 'k1', workspaceId: 'wrkspc_a' });
        const b = managedAgentsClientFor({ apiKey: 'k2', workspaceId: 'wrkspc_b' });
        if (!a.ok || !b.ok) throw new Error('refused');
        expect(a.client).not.toBe(b.client);
        expect(sdk.default).toHaveBeenCalledTimes(2);
    });
});

describe('every response names the workspace the client was built for (#5854 finding 4)', () => {
    // The SDK binds `fetch` when the client is built: each test sets it first.
    beforeEach(() => {
        global.fetch = (async () => {
            throw new Error('no network in this suite');
        }) as typeof fetch;
    });

    const json = (status: number, workspace: string | null, body: unknown = { id: 'sesn_1', type: 'session', status: 'idle' }) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json', ...(workspace ? { 'anthropic-workspace-id': workspace } : {}) },
        });

    function built(): Anthropic {
        const choice = managedAgentsClientFor({ apiKey: 'k', workspaceId: 'wrkspc_abc' });
        if (!choice.ok) throw new Error(choice.reason);
        return choice.client;
    }

    it('the comparison is the connection Test\'s: trimmed, blank is missing', () => {
        const h = (v: string | null) => new Headers(v === null ? {} : { 'anthropic-workspace-id': v });
        expect(answeredWorkspace(h('wrkspc_abc'), 'wrkspc_abc')).toBe('MATCH');
        expect(answeredWorkspace(h(' wrkspc_abc\n'), ' wrkspc_abc ')).toBe('MATCH');
        expect(answeredWorkspace(h('wrkspc_other'), 'wrkspc_abc')).toBe('MISMATCH');
        expect(answeredWorkspace(h(null), 'wrkspc_abc')).toBe('MISSING');
        expect(answeredWorkspace(h('   '), 'wrkspc_abc')).toBe('MISSING');
    });

    it('the switch: a mismatch always fails the call; a missing header only once it is flipped, and it is not yet', () => {
        expect(failsTheCall('MATCH', true)).toBe(false);
        expect(failsTheCall('MISMATCH', false)).toBe(true);
        expect(failsTheCall('MISSING', false)).toBe(false);
        expect(failsTheCall('MISSING', true)).toBe(true);
        // The owner's decision of 2026-11-25: refusing a missing header waits
        // for the real-workspace evidence.
        expect(REFUSE_MISSING_WORKSPACE_HEADER).toBe(false);
    });

    it('a response from another workspace fails the call with no status to read, a 404 included, and latches the client', async () => {
        global.fetch = (async () => json(404, 'wrkspc_other', { type: 'error', error: { type: 'not_found_error', message: 'x' } })) as typeof fetch;
        const client = built();
        const thrown = await client.beta.sessions.retrieve('sesn_1').catch((e: unknown) => e);
        expect(isManagedAgentsWorkspaceMismatch(thrown)).toBe(true);
        expect((thrown as { status?: unknown }).status).toBeUndefined();
        expect(workspaceMismatchSeen(client)).toBe('MISMATCH');
        // Latched per client: another client has heard nothing.
        expect(workspaceMismatchSeen(built())).toBeNull();
    });

    it('the event stream\'s initial response is checked before its body is read, and its body is cancelled', async () => {
        const cancelled = jest.fn();
        global.fetch = (async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start: (c) => c.enqueue(new TextEncoder().encode('event: agent.message\ndata: {"id":"e1","type":"agent.message","content":[]}\n\n')),
                    cancel: cancelled,
                }),
                { status: 200, headers: { 'content-type': 'text/event-stream', 'anthropic-workspace-id': 'wrkspc_other' } },
            )) as typeof fetch;
        const client = built();
        const thrown = await client.beta.sessions.events.stream('sesn_1').catch((e: unknown) => e);
        expect(isManagedAgentsWorkspaceMismatch(thrown)).toBe(true);
        expect((thrown as ManagedAgentsWorkspaceMismatchError).endpoint).toBe('sessions.events.stream');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cancelled).toHaveBeenCalled();
    });

    it('the call is not retried into the same answer: one request, though the SDK retries a 5xx', async () => {
        const fetched = jest.fn(async () => json(503, 'wrkspc_other', { type: 'error', error: { type: 'api_error', message: 'x' } }));
        global.fetch = fetched as unknown as typeof fetch;
        const client = built();
        await expect(client.beta.sessions.retrieve('sesn_1')).rejects.toBeInstanceOf(ManagedAgentsWorkspaceMismatchError);
        expect(fetched).toHaveBeenCalledTimes(1);
    });

    it('a response naming no workspace passes, and is logged once per client with no workspace id', async () => {
        const info = jest.spyOn(logger, 'info');
        try {
            global.fetch = (async () => json(200, null)) as typeof fetch;
            const client = built();
            await client.beta.sessions.retrieve('sesn_1');
            await client.beta.sessions.retrieve('sesn_1');
            expect(workspaceMismatchSeen(client)).toBeNull();
            const logged = info.mock.calls.filter(([message]) => /named no workspace/.test(String(message)));
            expect(logged).toHaveLength(1);
            expect(JSON.stringify(logged[0])).not.toMatch(/wrkspc_/);
        } finally {
            info.mockRestore();
        }
    });

    it('positive control: a response from the configured workspace passes untouched', async () => {
        global.fetch = (async () => json(200, 'wrkspc_abc')) as typeof fetch;
        const client = built();
        await expect(client.beta.sessions.retrieve('sesn_1')).resolves.toMatchObject({ id: 'sesn_1' });
        expect(workspaceMismatchSeen(client)).toBeNull();
    });
});

describe('the engine\'s client has one constructor', () => {
    const CLIENT = 'src/lib/agentic/tool-runner/client.ts';
    const source = read(CLIENT);

    it('the seam constructs exactly two clients, one in each named constructor', () => {
        expect(codeOf(source).match(/new Anthropic\(/g)).toHaveLength(2);
        expect(codeOf(functionBodyOf(source, 'managedAgentsClientFor')).match(/new Anthropic\(/g)).toHaveLength(1);
        expect(codeOf(functionBodyOf(source, 'clientForRun')).match(/new Anthropic\(/g)).toHaveLength(1);
        // The engine's client carries the engine's middleware, and only that one.
        expect(codeOf(functionBodyOf(source, 'managedAgentsClientFor'))).toMatch(/middleware: \[managedAgentsOnlyFor\(/);
        expect(codeOf(functionBodyOf(source, 'managedAgentsClientFor'))).not.toMatch(/messagesOnlyFor/);
    });

    it('only the engine\'s driver, the provisioning usecase and the clean-up call it, and no file of the engine calls clientForRun', () => {
        const callers: string[] = [];
        const deploymentClientInEngine: string[] = [];
        let scanned = 0;
        for (const rel of repoRelativeFiles()) {
            if (!rel.startsWith('src/') || !/\.(ts|tsx)$/.test(rel) || rel === CLIENT) continue;
            scanned += 1;
            const code = codeOf(read(rel));
            if (/\bmanagedAgentsClientFor\s*\(/.test(code)) callers.push(rel);
            if (rel.startsWith('src/lib/agentic/managed-agents/') && /\bclientForRun\b/.test(code)) deploymentClientInEngine.push(rel);
        }
        expect(scanned).toBeGreaterThan(1000);
        expect(callers.sort()).toEqual([
            'src/app-layer/usecases/agent-profile-provision.ts',
            // Step 5c (#4166): the purge, connection-removal and DSAR clean-up
            // and the lost-delete reconciliation, each with the connection's key.
            'src/app-layer/usecases/managed-agents-cleanup.ts',
            'src/lib/agentic/managed-agents/driver.ts',
        ]);
        expect(deploymentClientInEngine).toEqual([]);
    });
});
