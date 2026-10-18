/**
 * THE SCANNER-KEY REGISTER on the harness tab, rendered (#3687).
 *
 *   1. THE REGISTER IS LISTED AS WHAT IT IS: active keys carry a revoke
 *      action, revoked keys carry the day they were revoked and no action, and
 *      NO KEY AT ALL is a finding — without one, no report can be accepted.
 *   2. REGISTERING picks the scanner from the register (never a typed id) and
 *      POSTs exactly `{ agentId, publicKey }`; a refusal (409: already
 *      registered) is the server's sentence, inline, with the dialog open.
 *      With no agent that can hold a key, there is nothing to submit.
 *   3. REVOKING is confirmed with the canonical verb, sends DELETE to that
 *      key's own path and refreshes; a refusal keeps the confirmation open
 *      over the server's sentence.
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
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh, back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/reports',
    useSearchParams: () => new URLSearchParams('tab=harness'),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
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

import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import type { HarnessMatrixView, HarnessScannerKeysView } from '@/lib/agentic/harness-read-model';

const K = (
    jest.requireActual('../../messages/en.json') as {
        agents: { harness: { keys: Record<string, string>; keysModal: Record<string, string> } };
    }
).agents.harness;

const NO_SCANS: HarnessMatrixView = {
    generatedAt: '2026-10-17T09:00:00.000Z',
    scanWindow: 50,
    scans: { rows: [], truncated: false },
    sections: [],
    scannersNotShown: 0,
    scannersWithoutScan: { rows: [], truncated: false },
    shadow: { rows: [], truncated: false, basis: 'NOT_EVIDENCED', basisAsOf: null },
    acceptances: { rows: [], truncated: false },
};

const ACTIVE = {
    id: 'key_active',
    agentId: 'agt_scanner',
    agentName: 'Estate scanner',
    keyFingerprint: 'a'.repeat(64),
    createdAt: '2026-10-01T10:00:00.000Z',
    revokedAt: null,
};
const REVOKED = {
    id: 'key_old',
    agentId: 'agt_scanner',
    agentName: 'Estate scanner',
    keyFingerprint: 'b'.repeat(64),
    createdAt: '2026-09-01T10:00:00.000Z',
    revokedAt: '2026-09-20T10:00:00.000Z',
};

const keysView = (over: Partial<HarnessScannerKeysView> = {}): HarnessScannerKeysView => ({
    keys: { rows: [ACTIVE, REVOKED], truncated: false },
    candidates: {
        rows: [
            { id: 'agt_scanner', name: 'Estate scanner' },
            { id: 'agt_second', name: 'Second scanner' },
        ],
        truncated: false,
    },
    ...over,
});

const renderTab = (scannerKeys: HarnessScannerKeysView = keysView()) =>
    render(
        <ReportsClient
            tab="harness"
            tenantSlug="acme"
            harness={NO_SCANS}
            scannerKeys={scannerKeys}
            canReviewProposals
            canInvestigate
            canExport={false}
        />,
    );

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    mockRefresh.mockClear();
    Object.values(mockToast).forEach((m) => m.mockClear());
    global.fetch = fetchMock as unknown as typeof fetch;
});

// ─── 1. The register ────────────────────────────────────────────────────────

describe('the key register', () => {
    it('renders with no scan at all — a key is what lets the first report be accepted', () => {
        renderTab();
        // The no-scans finding and the key card are on the same page.
        expect(screen.getByTestId('harness-no-scans')).toBeInTheDocument();
        expect(screen.getByTestId('harness-scanner-keys')).toBeInTheDocument();
    });

    it('an active key carries a revoke action; a revoked one carries its day and no action', () => {
        renderTab();
        const table = screen.getByTestId('harness-scanner-keys-table');
        expect(within(table).getByTestId('harness-key-status-key_active').textContent).toBe(K.keys.statusActive);
        expect(within(table).getByTestId('harness-key-status-key_old').textContent).toContain('Revoked');
        expect(within(table).getByTestId('harness-key-status-key_old').textContent).toContain('2026');
        expect(within(table).getByTestId('harness-key-revoke-key_active')).toBeInTheDocument();
        expect(within(table).queryByTestId('harness-key-revoke-key_old')).not.toBeInTheDocument();
        expect(table.textContent).toContain('a'.repeat(64));
    });

    it('no key at all is a finding, not an empty table', () => {
        renderTab(keysView({ keys: { rows: [], truncated: false } }));
        expect(screen.getByTestId('harness-scanner-keys-empty').textContent).toBe(K.keys.empty);
        expect(screen.queryByTestId('harness-scanner-keys-table')).not.toBeInTheDocument();
        // …and the register action is still there.
        expect(screen.getByTestId('harness-key-register-button')).toBeInTheDocument();
    });
});

// ─── 2. Registering ─────────────────────────────────────────────────────────

describe('registering a key', () => {
    async function openAndFill() {
        const user = userEvent.setup();
        renderTab();
        await user.click(screen.getByTestId('harness-key-register-button'));
        const dialog = screen.getByTestId('harness-key-register-modal');
        await user.click(within(dialog).getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: /Second scanner/ }));
        fireEvent.change(document.getElementById('harness-key-public-key') as HTMLInputElement, {
            target: { value: `  ${'c'.repeat(64)} ` },
        });
        return { user, dialog };
    }

    it('POSTs exactly the chosen register row and the trimmed key, then refreshes', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'key_new' }) });
        const { user } = await openAndFill();
        await user.click(screen.getByTestId('harness-key-register-submit'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/harness-scanner-keys');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ agentId: 'agt_second', publicKey: 'c'.repeat(64) });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('harness-key-register-modal')).not.toBeInTheDocument();
    });

    it('a 409 is the server\'s sentence, inline, with the dialog still open and nothing refreshed', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 409,
            json: async () => ({ error: { code: 'CONFLICT', message: 'This key is already registered for this tenant' } }),
        });
        const { user, dialog } = await openAndFill();
        await user.click(screen.getByTestId('harness-key-register-submit'));

        const error = await within(dialog).findByTestId('harness-key-register-error');
        expect(error.getAttribute('role')).toBe('alert');
        expect(error.textContent).toContain('This key is already registered for this tenant');
        expect(mockToast.error).toHaveBeenCalledWith('This key is already registered for this tenant', expect.anything());
        expect(screen.getByTestId('harness-key-register-modal')).toBeInTheDocument();
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('sends nothing without a chosen agent', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(screen.getByTestId('harness-key-register-button'));
        fireEvent.change(document.getElementById('harness-key-public-key') as HTMLInputElement, {
            target: { value: 'c'.repeat(64) },
        });
        expect(screen.getByTestId('harness-key-register-submit')).toBeDisabled();
    });

    it('with no agent that can hold a key, says so and offers nothing to submit', async () => {
        const user = userEvent.setup();
        renderTab(keysView({ candidates: { rows: [], truncated: false } }));
        await user.click(screen.getByTestId('harness-key-register-button'));
        const dialog = screen.getByTestId('harness-key-register-modal');
        const notice = within(dialog).getByTestId('harness-key-no-candidates');
        expect(notice).toHaveTextContent(K.keysModal.noCandidates);
        expect(notice).toHaveTextContent(K.keysModal.noCandidatesHint);
        expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
        fireEvent.change(document.getElementById('harness-key-public-key') as HTMLInputElement, {
            target: { value: 'c'.repeat(64) },
        });
        expect(screen.getByTestId('harness-key-register-submit')).toBeDisabled();
    });
});

// ─── 3. Revoking ────────────────────────────────────────────────────────────

describe('revoking a key', () => {
    function openConfirm() {
        renderTab();
        fireEvent.click(screen.getByTestId('harness-key-revoke-key_active'));
        const dialog = screen.getByRole('dialog');
        const confirm = within(dialog).getByRole('button', { name: K.keys.revokeConfirm });
        return { dialog, confirm };
    }

    it('is confirmed with the canonical verb, then DELETEs that key\'s own path and refreshes', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'key_active', revoked: true }) });
        const { confirm } = openConfirm();
        expect(fetchMock).not.toHaveBeenCalled();
        fireEvent.click(confirm);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/harness-scanner-keys/key_active');
        expect(init.method).toBe('DELETE');
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('a refused DELETE keeps the confirmation open over the server\'s sentence', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 404,
            json: async () => ({ error: { code: 'NOT_FOUND', message: 'Active scanner key not found' } }),
        });
        const { dialog, confirm } = openConfirm();
        fireEvent.click(confirm);

        const error = await within(dialog).findByTestId('harness-key-revoke-error');
        expect(error.getAttribute('role')).toBe('alert');
        expect(error.textContent).toBe('Active scanner key not found');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(mockToast.error).toHaveBeenCalledWith('Active scanner key not found', expect.anything());
    });
});
