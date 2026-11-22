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

import { managedAgentsClientFor } from '@/lib/agentic/tool-runner/client';
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

    it('builds a new client per call', () => {
        const a = managedAgentsClientFor({ apiKey: 'k1', workspaceId: 'wrkspc_a' });
        const b = managedAgentsClientFor({ apiKey: 'k2', workspaceId: 'wrkspc_b' });
        if (!a.ok || !b.ok) throw new Error('refused');
        expect(a.client).not.toBe(b.client);
        expect(sdk.default).toHaveBeenCalledTimes(2);
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
