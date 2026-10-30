/**
 * #4545: risk suggestions never dial a gateway address a tenant typed.
 *
 * `TenantSecuritySettings.aiLocalBaseUrl` is written by any `admin.manage`
 * holder. The factory used to prefer it to `AI_LOCAL_BASE_URL`, so the server
 * POSTed to a tenant-chosen host with a bare `fetch`, carrying the
 * deployment's `AI_LOCAL_API_KEY`. These tests drive the real factory and the
 * real local provider over a recording `fetch`, and read what left.
 */
const mutableEnv: Record<string, string | undefined> = {
    AI_RISK_PROVIDER: 'local',
    AI_LOCAL_BASE_URL: 'http://deployment-gateway:8080',
    AI_LOCAL_MODEL: 'llama3.1',
    AI_LOCAL_API_KEY: 'deployment-gateway-key', // pragma: allowlist secret -- unit-test input, not a credential
};
jest.mock('@/env', () => ({ env: mutableEnv }));

const mockWarn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), info: jest.fn() },
}));
jest.mock('@/app-layer/ai/risk-assessment/prompt-builder', () => ({
    buildRiskAssessmentPrompt: () => ({ system: 'sys', user: 'usr', responseSchema: '{}' }),
}));
jest.mock('@/app-layer/ai/risk-assessment/schemas', () => ({
    RiskSuggestionOutputSchema: { parse: (x: unknown) => x },
}));
jest.mock('@/app-layer/ai/risk-assessment/stub-provider', () => ({
    StubRiskSuggestionProvider: jest.fn().mockImplementation(() => ({
        providerName: 'stub',
        generateSuggestions: jest.fn().mockResolvedValue({ suggestions: [], provider: 'stub', isFallback: true }),
    })),
}));

import { getProvider } from '@/app-layer/ai/risk-assessment';

const input = { tenantIndustry: 'fin', frameworks: [], assets: [] } as never;
const FOREIGN = 'https://tenant-chosen.example';

type Sent = { url: string; authorization: string | undefined };
let sent: Sent[] = [];

beforeEach(() => {
    sent = [];
    mockWarn.mockClear();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        sent.push({ url: String(url), authorization: headers.Authorization });
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ suggestions: [] }) } }] }),
        };
    });
});

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe.each(['LOCAL_ONLY', 'EXTERNAL'] as const)('residency %s, AI_RISK_PROVIDER=local', (residency) => {
    it('a tenant address that is not the deployment\'s is never dialled, and the key goes nowhere', async () => {
        const provider = getProvider({ residency, localBaseUrl: FOREIGN, localModel: 'mistral' });
        const out = await provider.generateSuggestions(input);

        expect(sent).toEqual([]);
        expect(out).toMatchObject({ provider: 'stub', isFallback: true });
        expect(mockWarn).toHaveBeenCalledWith(
            expect.stringContaining('not one this deployment serves'),
            expect.objectContaining({ reason: 'LOCAL_GATEWAY_NOT_SERVED' }),
        );
        // The warning names the reason, never the address.
        expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('tenant-chosen');
    });

    it('positive control: the deployment gateway is dialled with its key when the tenant names it or nothing', async () => {
        for (const localBaseUrl of [mutableEnv.AI_LOCAL_BASE_URL, null, undefined]) {
            sent = [];
            await getProvider({ residency, localBaseUrl }).generateSuggestions(input);
            expect(sent).toEqual([
                { url: 'http://deployment-gateway:8080/v1/chat/completions', authorization: 'Bearer deployment-gateway-key' },
            ]);
        }
    });
});

it('with no deployment gateway, a tenant address still is not dialled', async () => {
    const saved = mutableEnv.AI_LOCAL_BASE_URL;
    mutableEnv.AI_LOCAL_BASE_URL = undefined;
    try {
        await getProvider({ residency: 'LOCAL_ONLY', localBaseUrl: FOREIGN }).generateSuggestions(input);
        expect(sent).toEqual([]);
    } finally {
        mutableEnv.AI_LOCAL_BASE_URL = saved;
    }
});
