/**
 * The `anthropic-workspace` provider's Test, over a faux transport (Step 5a of
 * docs/claude-managed-agents-design.md).
 *
 * The transport is `safeFetch`, replaced by a jest mock that answers as the
 * Anthropic API would. Everything above it — the host rule, the headers, the
 * byte cap, the classification and the operator's sentence — is the real code.
 *
 * What it holds:
 *   - a working key for the configured workspace is valid, and the request is
 *     ONE `GET /v1/agents?limit=1` to `https://api.anthropic.com` carrying the
 *     key, the version, the Managed Agents beta and `anthropic-workspace-id`;
 *   - an invalid key, a key not tied to a workspace, a key for ANOTHER
 *     workspace, an answer that names no workspace, and an unreachable API are
 *     each invalid, each with its own plain sentence, none quoting Anthropic;
 *   - a host other than api.anthropic.com is refused before any request;
 *   - every Test emits the outcome metric;
 *   - with AGENT_MANAGED_AGENTS unset the provider is not registered;
 *   - the end-to-end seam answers only to both test flags, and the host rule
 *     still runs first under it.
 */
const mockSafeFetch = jest.fn<Promise<Response>, [string, RequestInit | undefined]>();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    ...jest.requireActual('@/app-layer/automation/webhook-safety'),
    safeFetch: (url: string, init?: RequestInit) => mockSafeFetch(url, init),
}));

const mockRecordOutcome = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordAnthropicWorkspaceValidation: (attrs: { outcome: string }) => mockRecordOutcome(attrs),
}));

import {
    AnthropicWorkspaceProvider,
    ANTHROPIC_WORKSPACE_PROVIDER_ID,
} from '@/app-layer/integrations/providers/anthropic-workspace';
import {
    anthropicWorkspaceE2eOrigin,
    ANTHROPIC_WORKSPACE_E2E_FAUX_PORT,
} from '@/app-layer/integrations/providers/anthropic-workspace/e2e-faux';
import { SsrfBlockedError } from '@/app-layer/automation/webhook-safety';
import { validateProviderConfig } from '@/app-layer/integrations/config-schema';

const WS = 'wrkspc_01AbCdEf';
const KEY = 'sk-ant-unit-fixture'; // pragma: allowlist secret — a fixture, too short to be a real key
const config = (over: Record<string, unknown> = {}) => ({ workspaceId: WS, ...over });
const secrets = { apiKey: KEY };

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}
const agentsPage = (workspace: string | null = WS) =>
    answer(200, { data: [], next_page: null }, workspace ? { 'anthropic-workspace-id': workspace } : {});
const apiError = (status: number, type: string, message: string) =>
    answer(status, { type: 'error', error: { type, message }, request_id: 'req_fixture' });

const provider = new AnthropicWorkspaceProvider();

beforeEach(() => {
    mockSafeFetch.mockReset();
    mockRecordOutcome.mockReset();
});

describe('AnthropicWorkspaceProvider — a working key', () => {
    it('is valid when the answer names the configured workspace', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage());
        const r = await provider.validateConnection(config(), secrets);
        expect(r).toEqual({ valid: true });
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'valid' });
    });

    it('sends ONE read to the fixed host, with the key, version, beta and workspace headers', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage());
        await provider.validateConnection(config(), secrets);

        expect(mockSafeFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockSafeFetch.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/agents?limit=1');
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        expect(init?.headers).toMatchObject({
            'x-api-key': KEY,
            'anthropic-version': '2026-10-21',
            'anthropic-beta': 'managed-agents-2026-04-01',
            'anthropic-workspace-id': WS,
        });
    });

    it('accepts an explicitly configured api.anthropic.com, the one host there is', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage());
        const r = await provider.validateConnection(config({ apiHost: 'api.anthropic.com' }), secrets);
        expect(r.valid).toBe(true);
    });
});

describe('AnthropicWorkspaceProvider — each failure, in plain words', () => {
    it('an invalid key (401 authentication_error)', async () => {
        mockSafeFetch.mockResolvedValue(apiError(401, 'authentication_error', 'invalid x-api-key'));
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/did not accept this API key/);
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'key_invalid' });
    });

    it('a key not tied to a workspace (the 400 seen for real on 2026-11-14)', async () => {
        mockSafeFetch.mockResolvedValue(
            apiError(
                400,
                'invalid_request_error',
                'This API key is not scoped to a workspace, so this request must include the ' +
                    'anthropic-workspace-id header with the ID of the workspace',
            ),
        );
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/not tied to a workspace/);
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'key_not_workspace_scoped' });
    });

    it('a key for ANOTHER workspace: the answer names a different one', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage('wrkspc_someoneElse'));
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/belongs to a different workspace/);
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'wrong_workspace' });
    });

    it('a key Anthropic refuses for this workspace (403 permission_error)', async () => {
        mockSafeFetch.mockResolvedValue(apiError(403, 'permission_error', 'not allowed'));
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/refused this key for the workspace/);
    });

    it('an answer that names no workspace is not a confirmation', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage(null));
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/did not say which workspace/);
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'workspace_unconfirmed' });
    });

    it.each([
        ['a refused destination', () => Promise.reject(new SsrfBlockedError('blocked'))],
        ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
        ['a 500', () => Promise.resolve(apiError(500, 'api_error', 'boom'))],
        ['a 529 overloaded', () => Promise.resolve(apiError(529, 'overloaded_error', 'busy'))],
    ])('Anthropic unreachable: %s', async (_label, reply) => {
        mockSafeFetch.mockImplementation(reply);
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/Could not reach Anthropic/);
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'unreachable' });
    });

    it('never shows what Anthropic wrote', async () => {
        mockSafeFetch.mockResolvedValue(apiError(400, 'invalid_request_error', 'SECRET-DETAIL-FROM-THE-FAR-END'));
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(r.error).not.toContain('SECRET-DETAIL');
    });

    it('an oversized answer is not read as a page of agents', async () => {
        mockSafeFetch.mockResolvedValue(
            answer(200, JSON.stringify({ data: [], pad: 'x'.repeat(70 * 1024) }), { 'anthropic-workspace-id': WS }),
        );
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
        expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'unexpected_response' });
    });

    it('a 200 that is not a page of agents is not valid', async () => {
        mockSafeFetch.mockResolvedValue(answer(200, { hello: 'world' }, { 'anthropic-workspace-id': WS }));
        const r = await provider.validateConnection(config(), secrets);
        expect(r.valid).toBe(false);
    });
});

describe('AnthropicWorkspaceProvider — the host is fixed and the configuration is checked first', () => {
    it.each(['evil.example.com', 'api.anthropic.com.evil.tld', 'evil-api.anthropic.com', 'https://user:pw@api.anthropic.com'])(
        'refuses apiHost %s before any request',
        async (apiHost) => {
            const r = await provider.validateConnection(config({ apiHost }), secrets);
            expect(r.valid).toBe(false);
            expect(r.error).toMatch(/only ever talks to api\.anthropic\.com/);
            expect(mockSafeFetch).not.toHaveBeenCalled();
            expect(mockRecordOutcome).toHaveBeenCalledWith({ outcome: 'config_refused' });
        },
    );

    it('refuses a workspace ID that is not one, so nothing odd reaches a header', async () => {
        const r = await provider.validateConnection(config({ workspaceId: 'wrkspc_a\r\nx-evil: 1' }), secrets);
        expect(r.valid).toBe(false);
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('asks for both fields when either is missing, before any request', async () => {
        expect((await provider.validateConnection({}, secrets)).valid).toBe(false);
        expect((await provider.validateConnection(config(), {})).valid).toBe(false);
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('the save path refuses another host too (validateProviderConfig)', () => {
        expect(() => validateProviderConfig(ANTHROPIC_WORKSPACE_PROVIDER_ID, { apiHost: 'evil.example.com' })).toThrow(
            /Refusing to send Anthropic credentials to "evil.example.com".*Expected api\.anthropic\.com\./,
        );
        expect(() => validateProviderConfig(ANTHROPIC_WORKSPACE_PROVIDER_ID, { baseUrl: 'https://evil.example.com' })).toThrow(
            /Unknown configuration field/,
        );
        expect(() => validateProviderConfig(ANTHROPIC_WORKSPACE_PROVIDER_ID, { workspaceId: 'not-a-workspace' })).toThrow(
            /workspace ID/,
        );
        expect(
            validateProviderConfig(ANTHROPIC_WORKSPACE_PROVIDER_ID, {
                apiHost: 'api.anthropic.com',
                workspaceId: WS,
                keepSessions: false,
            }),
        ).toEqual({ apiHost: 'api.anthropic.com', workspaceId: WS, keepSessions: false });
    });
});

describe('AGENT_MANAGED_AGENTS decides whether the provider exists', () => {
    const registeredWith = (value: string | undefined): boolean => {
        const saved = process.env.AGENT_MANAGED_AGENTS;
        if (value === undefined) delete process.env.AGENT_MANAGED_AGENTS;
        else process.env.AGENT_MANAGED_AGENTS = value;
        try {
            let found = false;
            jest.isolateModules(() => {
                require('@/app-layer/integrations/bootstrap');
                const { registry } = require('@/app-layer/integrations/registry');
                found = registry.getProvider(ANTHROPIC_WORKSPACE_PROVIDER_ID) !== undefined;
            });
            return found;
        } finally {
            if (saved === undefined) delete process.env.AGENT_MANAGED_AGENTS;
            else process.env.AGENT_MANAGED_AGENTS = saved;
        }
    };

    it('unset: not registered', () => {
        expect(registeredWith(undefined)).toBe(false);
    });

    it('a value that is not 1 or true: not registered', () => {
        expect(registeredWith('yes')).toBe(false);
        expect(registeredWith('0')).toBe(false);
    });

    it('1 or true: registered', () => {
        expect(registeredWith('1')).toBe(true);
        expect(registeredWith('true')).toBe(true);
    });
});

describe('the end-to-end seam', () => {
    it('answers only when BOTH test flags are set, and only with loopback', () => {
        expect(anthropicWorkspaceE2eOrigin({ nextTestMode: undefined, authTestMode: undefined })).toBeNull();
        expect(anthropicWorkspaceE2eOrigin({ nextTestMode: '1', authTestMode: undefined })).toBeNull();
        expect(anthropicWorkspaceE2eOrigin({ nextTestMode: undefined, authTestMode: '1' })).toBeNull();
        expect(anthropicWorkspaceE2eOrigin({ nextTestMode: '1', authTestMode: '1' })).toBe(
            `http://127.0.0.1:${ANTHROPIC_WORKSPACE_E2E_FAUX_PORT}`,
        );
    });

    describe('under both flags', () => {
        const saved = { next: process.env.NEXT_TEST_MODE, auth: process.env.AUTH_TEST_MODE };
        const realFetch = global.fetch;
        const mockFetch = jest.fn<Promise<Response>, [string, RequestInit | undefined]>();
        let isolated: AnthropicWorkspaceProvider;

        beforeEach(() => {
            process.env.NEXT_TEST_MODE = '1';
            process.env.AUTH_TEST_MODE = '1';
            mockFetch.mockReset();
            global.fetch = mockFetch as unknown as typeof fetch;
            jest.isolateModules(() => {
                // A fresh `env`, built while AUTH_TEST_MODE is set.
                const mod = require('@/app-layer/integrations/providers/anthropic-workspace');
                isolated = new mod.AnthropicWorkspaceProvider();
            });
        });
        afterEach(() => {
            global.fetch = realFetch;
            if (saved.next === undefined) delete process.env.NEXT_TEST_MODE;
            else process.env.NEXT_TEST_MODE = saved.next;
            if (saved.auth === undefined) delete process.env.AUTH_TEST_MODE;
            else process.env.AUTH_TEST_MODE = saved.auth;
        });

        it('dials the loopback faux instead of safeFetch, with the same read', async () => {
            mockFetch.mockResolvedValue(agentsPage());
            const r = await isolated.validateConnection(config(), secrets);
            expect(r.valid).toBe(true);
            expect(mockSafeFetch).not.toHaveBeenCalled();
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch.mock.calls[0][0]).toBe(
                `http://127.0.0.1:${ANTHROPIC_WORKSPACE_E2E_FAUX_PORT}/v1/agents?limit=1`,
            );
        });

        it('still refuses a configured host other than api.anthropic.com', async () => {
            const r = await isolated.validateConnection(config({ apiHost: 'evil.example.com' }), secrets);
            expect(r.valid).toBe(false);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
});
