/**
 * CONNECT A SCANNER, rendered (owner decisions, 2026-11-24).
 *
 *   1. WHO MAY USE IT: a viewer who cannot create keys is told an Owner or
 *      Admin does it; the register tick is offered only with the grant key.
 *   2. AN AGENT THAT IS NOT ACTIVE is explained and linked, never connected.
 *   3. THE CALLS: the public key, then the tool grant when it is missing, then
 *      ONE key carrying every ticked report's scope; a failure stops the steps
 *      after it.
 *   4. THE KEY is shown once, is in no snippet, and is gone on close.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const t = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        return v as string;
    };
    return { useTranslations: (ns: string) => t(ns), useLocale: () => 'en' };
});

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh, back: jest.fn() }),
    usePathname: () => '/t/acme/agents/reports',
    useSearchParams: () => new URLSearchParams('tab=harness'),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ tenantSlug: 'acme' }),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

import { ScannerKeysCard } from '@/app/t/[tenantSlug]/(app)/agents/reports/harness/ScannerKeysCard';
import type { HarnessScannerKeysView } from '@/lib/agentic/harness-read-model';
import { SCANNER_KEY_ENV, SCANNER_KEY_PLACEHOLDER } from '@/lib/agentic/scanner-connect';

const C = (
    jest.requireActual('../../messages/en.json') as { agents: { harness: { connect: Record<string, unknown> } } }
).agents.harness.connect as Record<string, string> & { blocked: Record<string, string> };

const PLAINTEXT = 'iflk_live_secret_value';

const view = (connect: HarnessScannerKeysView['connect'], withLiveKey = false): HarnessScannerKeysView => ({
    keys: {
        rows: withLiveKey
            ? [{ id: 'key_1', agentId: 'agt_active', agentName: 'Estate scanner', keyFingerprint: 'a'.repeat(64), createdAt: '2026-11-01T00:00:00.000Z', revokedAt: null }]
            : [],
        truncated: false,
    },
    candidates: {
        rows: [
            { id: 'agt_active', name: 'Estate scanner', status: 'ACTIVE', autonomyLevel: 2, aiSystemClassified: true, riskScored: true },
            { id: 'agt_draft', name: 'Draft scanner', status: 'DRAFT', autonomyLevel: 1, aiSystemClassified: true, riskScored: false },
        ],
        truncated: false,
    },
    connect,
});

const fetchMock = jest.fn();
const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
const refused = (message: string, status = 400) => ({ ok: false, status, json: async () => ({ error: { message } }) });

beforeEach(() => {
    fetchMock.mockReset();
    mockRefresh.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
});

async function openPanel(v: HarnessScannerKeysView) {
    const user = userEvent.setup();
    render(<ScannerKeysCard view={v} />);
    await user.click(screen.getByTestId('harness-connect-scanner-button'));
    return { user, sheet: await screen.findByTestId('connect-scanner-sheet') };
}

async function chooseAgent(user: ReturnType<typeof userEvent.setup>, sheet: HTMLElement, name: RegExp) {
    await user.click(within(sheet).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name }));
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`);
const bodyOf = (index: number) => JSON.parse((fetchMock.mock.calls[index][1] as RequestInit).body as string);

describe('who may use it', () => {
    it('a viewer who cannot create keys is told who can, and gets no form', async () => {
        const { sheet } = await openPanel(view({ canMintKeys: false, canGrantTools: true }));
        expect(within(sheet).getByTestId('connect-scanner-blocked-permission').textContent).toBe(C.blocked.permission);
        expect(within(sheet).queryByTestId('connect-scanner-form')).not.toBeInTheDocument();
    });

    it('the register tick is offered only to a viewer who can grant the tool', async () => {
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: false }, true));
        await chooseAgent(user, sheet, /Estate scanner/);
        expect(document.getElementById('connect-scanner-agentReport')).not.toBeNull();
        expect(document.getElementById('connect-scanner-readRegister')).toBeNull();
    });
});

describe('an agent that is not active', () => {
    it('is explained, linked to its page, and cannot be connected', async () => {
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: true }));
        await chooseAgent(user, sheet, /Draft scanner/);
        const notice = within(sheet).getByTestId('connect-scanner-agent-unscored');
        expect(notice.textContent).toContain('Draft scanner');
        expect(within(notice).getByRole('link').getAttribute('href')).toBe('/t/acme/agents/agt_draft');
        expect(within(sheet).getByTestId('connect-scanner-submit')).toBeDisabled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('the calls', () => {
    it('registers the public key, grants the tool, then creates ONE key with every ticked scope', async () => {
        fetchMock
            .mockResolvedValueOnce(ok({ id: 'key_new' }, 201))
            .mockResolvedValueOnce(ok({ granted: [] }))
            .mockResolvedValueOnce(ok({ ok: true }, 201))
            .mockResolvedValueOnce(ok({ plaintext: PLAINTEXT }, 201));
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: true }));
        await chooseAgent(user, sheet, /Estate scanner/);
        fireEvent.change(document.getElementById('connect-scanner-public-key') as HTMLInputElement, {
            target: { value: ` ${'b'.repeat(64)} ` },
        });
        await user.click(document.getElementById('connect-scanner-integrations') as HTMLElement);
        await user.click(document.getElementById('connect-scanner-agentRules') as HTMLElement);
        await user.click(document.getElementById('connect-scanner-readRegister') as HTMLElement);
        expect(within(sheet).getByTestId('connect-scanner-scopes').textContent).toBe(
            'admin:agent_rules_ingest, admin:harness_ingest, admin:integrations_ingest, mcp:read',
        );
        await user.click(within(sheet).getByTestId('connect-scanner-submit'));

        await screen.findByTestId('connect-scanner-key');
        expect(calls()).toEqual([
            'POST /api/t/acme/admin/agents/harness-scanner-keys',
            'GET /api/t/acme/admin/agents/agt_active/tools',
            'POST /api/t/acme/admin/agents/agt_active/tools',
            'POST /api/t/acme/admin/api-keys',
        ]);
        expect(bodyOf(0)).toEqual({ agentId: 'agt_active', publicKey: 'b'.repeat(64) });
        expect(bodyOf(2)).toEqual({ toolName: 'get_harness_register' });
        expect(bodyOf(3)).toEqual({
            name: 'Estate scanner scanner',
            scopes: ['admin:agent_rules_ingest', 'admin:harness_ingest', 'admin:integrations_ingest', 'mcp:read'],
            expiresAt: null,
            agentId: 'agt_active',
            // The agent's own level is 2; a scanner key never needs above 1.
            maxAutonomyLevel: 1,
            requiresTokenExchange: true,
        });
    });

    it('an agent with a live key may skip the public key, and a granted tool is not granted again', async () => {
        fetchMock
            .mockResolvedValueOnce(ok({ granted: [{ toolName: 'get_harness_register' }] }))
            .mockResolvedValueOnce(ok({ plaintext: PLAINTEXT }, 201));
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: true }, true));
        await chooseAgent(user, sheet, /Estate scanner/);
        await user.click(document.getElementById('connect-scanner-readRegister') as HTMLElement);
        await user.click(within(sheet).getByTestId('connect-scanner-submit'));
        await screen.findByTestId('connect-scanner-key');
        expect(calls()).toEqual(['GET /api/t/acme/admin/agents/agt_active/tools', 'POST /api/t/acme/admin/api-keys']);
    });

    it('the agent report alone is one key with one scope and no exchange', async () => {
        fetchMock.mockResolvedValueOnce(ok({ plaintext: PLAINTEXT }, 201));
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: false }, true));
        await chooseAgent(user, sheet, /Estate scanner/);
        await user.click(within(sheet).getByTestId('connect-scanner-submit'));
        await screen.findByTestId('connect-scanner-key');
        expect(calls()).toEqual(['POST /api/t/acme/admin/api-keys']);
        expect(bodyOf(0)).toEqual({
            name: 'Estate scanner scanner',
            scopes: ['admin:harness_ingest'],
            expiresAt: null,
            agentId: 'agt_active',
            maxAutonomyLevel: 1,
            requiresTokenExchange: false,
        });
    });

    it('a refused public key stops the steps after it, with the server\'s sentence', async () => {
        fetchMock.mockResolvedValueOnce(refused('publicKey is not an Ed25519 public key (raw 32 bytes, hex or base64)'));
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: true }));
        await chooseAgent(user, sheet, /Estate scanner/);
        fireEvent.change(document.getElementById('connect-scanner-public-key') as HTMLInputElement, {
            target: { value: '-----BEGIN PUBLIC KEY-----' },
        });
        await user.click(within(sheet).getByTestId('connect-scanner-submit'));
        const error = await within(sheet).findByTestId('connect-scanner-error-publicKey');
        expect(error.textContent).toContain('raw 32 bytes');
        expect(calls()).toEqual(['POST /api/t/acme/admin/agents/harness-scanner-keys']);
        expect(within(sheet).queryByTestId('connect-scanner-key')).not.toBeInTheDocument();
    });

    it('nothing ticked cannot be submitted', async () => {
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: false }, true));
        await chooseAgent(user, sheet, /Estate scanner/);
        await user.click(document.getElementById('connect-scanner-agentReport') as HTMLElement);
        expect(within(sheet).getByTestId('connect-scanner-none-ticked')).toBeInTheDocument();
        expect(within(sheet).getByTestId('connect-scanner-submit')).toBeDisabled();
    });
});

describe('the key', () => {
    it('is shown once, is in no snippet, and is gone on close', async () => {
        fetchMock.mockResolvedValueOnce(ok({ plaintext: PLAINTEXT }, 201));
        const { user, sheet } = await openPanel(view({ canMintKeys: true, canGrantTools: false }, true));
        await chooseAgent(user, sheet, /Estate scanner/);
        await user.click(document.getElementById('connect-scanner-agentRules') as HTMLElement);
        await user.click(within(sheet).getByTestId('connect-scanner-submit'));

        expect((await screen.findByTestId('connect-scanner-key')).textContent).toContain(PLAINTEXT);
        const env = screen.getByTestId('connect-scanner-env').textContent ?? '';
        const config = screen.getByTestId('connect-scanner-config').textContent ?? '';
        expect(env).toBe(`${SCANNER_KEY_ENV.agentReport}=${SCANNER_KEY_PLACEHOLDER}\n${SCANNER_KEY_ENV.agentRules}=${SCANNER_KEY_PLACEHOLDER}`);
        expect(JSON.parse(config)).toMatchObject({
            scanner: { agentId: 'agt_active' },
            inflect: { tenantSlug: 'acme', apiKeyEnv: SCANNER_KEY_ENV.agentReport, agentRulesApiKeyEnv: SCANNER_KEY_ENV.agentRules },
        });
        expect(env + config).not.toContain(PLAINTEXT);

        await user.click(screen.getByTestId('connect-scanner-done'));
        await waitFor(() => expect(screen.queryByTestId('connect-scanner-sheet')).not.toBeInTheDocument());
        expect(document.body.textContent).not.toContain(PLAINTEXT);

        await user.click(screen.getByTestId('harness-connect-scanner-button'));
        expect(await screen.findByTestId('connect-scanner-form')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain(PLAINTEXT);
    });
});
