/**
 * THE OWNER'S SHORTFALL ACCEPTANCE, rendered (#3687).
 *
 * The harness tab offers the accept action only where the server computed
 * ACCEPT or RENEW (the matrix-tab suite pins that). What is pinned here is the
 * request that action sends and what the dialog does with the answer:
 *
 *   1. THE BODY IS EXACTLY WHAT THE STRICT SCHEMA TAKES. The agent, the
 *      trimmed reason, and the expiry as a full ISO instant at the END of the
 *      chosen UTC day — a date-only string, or an offset one, is refused by
 *      `z.string().datetime()`.
 *   2. THE API'S REFUSAL IS ON SCREEN. A 403 (not the owner) or a 400 (a
 *      past or too-distant expiry) arrives as the server's sentence, inline
 *      with role=alert and as a toast; the dialog stays open, nothing
 *      refreshes, and the owner can try again.
 *   3. NOTHING IS SENT that the server would refuse on its face: no reason
 *      shorter than the rule, no missing day.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// next-intl is ESM; resolve real en.json values, memoised per namespace.
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

// The shared <DatePicker> is exercised by tests/rendered/date-pickers.test.tsx.
// Here it is only the lever that sets the day, so it is driven as an input
// holding the UTC-midnight day the real picker hands back.
jest.mock('@/components/ui/date-picker/date-picker', () => ({
    DatePicker: ({ id, value, onChange }: { id?: string; value?: Date | null; onChange?: (d: Date | null) => void }) => (
        <input
            id={id}
            data-testid="harness-accept-expires-input"
            value={value ? value.toISOString().slice(0, 10) : ''}
            onChange={(e) => onChange?.(e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`) : null)}
        />
    ),
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

// `ReportsClient` loads the harness tab through `next/dynamic`, which resolves a
// tick after the first render in jsdom. What is under test here is the tab, not
// the loading boundary, so the one dynamic import is answered synchronously.
jest.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => require('@/app/t/[tenantSlug]/(app)/agents/reports/harness/HarnessTab').HarnessTab,
}));
import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import type {
    AcceptanceRow,
    HarnessMatrixView,
    HarnessScanRow,
    HarnessScannerSection,
    MatrixRow,
} from '@/lib/agentic/harness-read-model';

const H = (
    jest.requireActual('../../messages/en.json') as {
        agents: { harness: Record<string, string> & { acceptModal: Record<string, string> } };
    }
).agents.harness;
const M = H.acceptModal;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LATEST: HarnessScanRow = {
    id: 'scan_latest',
    scanRef: 'ref-latest',
    scannerAgentId: 'agt_scanner',
    scannerName: 'Estate scanner',
    scannerVersion: '1.2.0',
    asOf: '2026-10-15T03:00:00.000Z',
    ingestedAt: '2026-10-15T03:05:00.000Z',
    completeness: 'COMPLETE',
    agentCount: 2,
    sources: [{ kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null }],
};

const row = (over: Partial<MatrixRow>): MatrixRow => ({
    discoveredAgentId: 'da_1',
    discoveredId: 'entra:sp:one',
    discoveredVia: ['entra-sp'],
    registered: { agentId: 'agt_1', name: 'Reconciler' },
    level: 'H2',
    reach: 'WRITE_OR_EXTERNAL',
    belowBar: true,
    bar: 'H3',
    blockingNextRung: [],
    verdicts: [],
    verdictsUnreadable: false,
    latestIngestedLevel: null,
    acceptance: null,
    acceptAffordance: 'ACCEPT',
    ...over,
});

const RENEWABLE = row({
    discoveredAgentId: 'da_owned',
    discoveredId: 'entra:sp:owned',
    registered: { agentId: 'agt_2', name: 'Ledger bot' },
    acceptAffordance: 'RENEW',
    acceptance: { id: 'acc_1', expiresAt: '2026-12-31T23:59:59.999Z', acceptedLevel: 'H2', renewal: false },
});

const CARD_ROW: AcceptanceRow = {
    id: 'acc_1',
    discoveredAgentId: 'da_owned',
    agentLabel: 'Ledger bot',
    acceptedLevel: 'H2',
    expiresAt: '2026-12-31T23:59:59.999Z',
    inForce: true,
    acceptAffordance: 'RENEW',
};

function harnessView(rows: MatrixRow[]): HarnessMatrixView {
    const section: HarnessScannerSection = {
        scannerAgentId: LATEST.scannerAgentId,
        scannerName: LATEST.scannerName,
        latest: LATEST,
        previous: null,
        baseline: 'FIRST_SCAN',
        drift: null,
        driftUnavailableReason: 'FIRST_SCAN',
        rows,
        rowsUnread: false,
        rowsTruncated: false,
    };
    return {
        generatedAt: '2026-10-17T09:00:00.000Z',
        scanWindow: 50,
        scans: { rows: [LATEST], truncated: false },
        sections: [section],
        scannersNotShown: 0,
        scannersWithoutScan: { rows: [], truncated: false },
        shadow: { rows: [], truncated: false, basis: 'EVIDENCED', basisAsOf: LATEST.asOf },
        acceptances: { rows: [CARD_ROW], truncated: false },
    };
}

function renderTab(rows: MatrixRow[] = [row({}), RENEWABLE]) {
    return render(
        <ReportsClient
            tab="harness"
            tenantSlug="acme"
            harness={harnessView(rows)}
            scannerKeys={{ keys: { rows: [], truncated: false }, candidates: { rows: [], truncated: false } }}
            // No estate declared (#3678): the estate card is its own suite's.
            estateHealth={{ generatedAt: '2026-10-19T00:00:00.000Z', scanWindow: 500, windowTruncated: false, estates: { rows: [], truncated: false } }}
            canReviewProposals
            canInvestigate
            canExport={false}
        />,
    );
}

const REASON = 'Compensating review of every write until the manifests are pinned.';

/** Open the dialog from a matrix row's action, fill it, and return it. */
function openAndFill(testId: string, opts: { reason?: string; day?: string } = {}) {
    fireEvent.click(screen.getByTestId(testId));
    const dialog = screen.getByTestId('harness-accept-modal');
    if (opts.reason !== undefined) {
        fireEvent.change(document.getElementById('harness-accept-justification') as HTMLTextAreaElement, {
            target: { value: opts.reason },
        });
    }
    if (opts.day !== undefined) {
        fireEvent.change(screen.getByTestId('harness-accept-expires-input'), { target: { value: opts.day } });
    }
    return dialog;
}

const submit = () => screen.getByTestId('harness-accept-submit');

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    mockRefresh.mockClear();
    Object.values(mockToast).forEach((m) => m.mockClear());
    global.fetch = fetchMock as unknown as typeof fetch;
});

// ─── 1. The request ─────────────────────────────────────────────────────────

describe('the owner\'s acceptance posts exactly what the schema takes', () => {
    it('POSTs the agent, the TRIMMED reason and the end of the chosen UTC day as a full instant — then refreshes', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'acc_new' }) });
        renderTab();
        openAndFill('harness-accept-scan_latest-da_1', { reason: `   ${REASON}  `, day: '2026-11-30' });
        fireEvent.click(submit());

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/harness-acceptances');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({
            discoveredAgentId: 'da_1',
            justification: REASON,
            expiresAt: '2026-11-30T23:59:59.999Z',
        });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        expect(mockToast.success).toHaveBeenCalledWith(M.saved, expect.anything());
        expect(screen.queryByTestId('harness-accept-modal')).not.toBeInTheDocument();
    });

    it('sends nothing until the reason meets the rule and a day is chosen', () => {
        renderTab();
        openAndFill('harness-accept-scan_latest-da_1');
        expect(submit()).toBeDisabled();

        openAndFillExisting({ reason: 'Too short.' , day: '2026-11-30' });
        expect(submit()).toBeDisabled();

        openAndFillExisting({ reason: REASON, day: '' });
        expect(submit()).toBeDisabled();

        openAndFillExisting({ day: '2026-11-30' });
        expect(submit()).toBeEnabled();

        fireEvent.click(screen.getByText('Cancel'));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a renewal says what it replaces, and is the same POST', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'acc_2' }) });
        renderTab();
        const dialog = openAndFill('harness-accept-scan_latest-da_owned', { reason: REASON, day: '2027-01-31' });
        expect(within(dialog).getByTestId('harness-accept-renew-notice').textContent).toContain(
            M.renewNotice.split('{date}')[0],
        );
        expect(within(dialog).getByTestId('harness-accept-renew-notice').textContent).toContain('2026');
        expect(submit().textContent).toBe(M.submitRenew);
        fireEvent.click(submit());
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            discoveredAgentId: 'da_owned',
            justification: REASON,
            expiresAt: '2027-01-31T23:59:59.999Z',
        });
    });

    it('the acceptances card\'s renew opens the same dialog, for that card\'s agent', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'acc_3' }) });
        renderTab();
        openAndFill('harness-acceptance-renew-da_owned', { reason: REASON, day: '2027-02-01' });
        fireEvent.click(submit());
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).discoveredAgentId).toBe('da_owned');
    });
});

/** Change the open dialog's fields without re-opening it. */
function openAndFillExisting(opts: { reason?: string; day?: string }) {
    if (opts.reason !== undefined) {
        fireEvent.change(document.getElementById('harness-accept-justification') as HTMLTextAreaElement, {
            target: { value: opts.reason },
        });
    }
    if (opts.day !== undefined) {
        fireEvent.change(screen.getByTestId('harness-accept-expires-input'), { target: { value: opts.day } });
    }
}

// ─── 2. The API's refusal ───────────────────────────────────────────────────

describe('the API\'s refusal is shown, and the dialog stays open over it', () => {
    it.each([
        [403, 'FORBIDDEN', 'Only the agent’s owner may accept its harness shortfall'],
        [400, 'BAD_REQUEST', 'expiresAt must be in the future'],
    ])('a %s is the server\'s sentence, inline as an alert and as a toast — no refresh', async (status, code, message) => {
        fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ error: { code, message } }) });
        renderTab();
        const dialog = openAndFill('harness-accept-scan_latest-da_1', { reason: REASON, day: '2026-11-30' });
        fireEvent.click(submit());

        const error = await within(dialog).findByTestId('harness-accept-error');
        expect(error.getAttribute('role')).toBe('alert');
        expect(error.textContent).toContain(message);
        expect(mockToast.error).toHaveBeenCalledWith(message, expect.anything());
        // Still open, nothing refreshed, and the owner can try again.
        expect(screen.getByTestId('harness-accept-modal')).toBeInTheDocument();
        expect(mockRefresh).not.toHaveBeenCalled();
        await waitFor(() => expect(submit()).toBeEnabled());
        expect(mockToast.success).not.toHaveBeenCalled();
    });

    it('a body that is not the error envelope falls back to the generic sentence, never an object', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
        renderTab();
        const dialog = openAndFill('harness-accept-scan_latest-da_1', { reason: REASON, day: '2026-11-30' });
        fireEvent.click(submit());
        const error = await within(dialog).findByTestId('harness-accept-error');
        expect(error.textContent).toContain(M.failed);
        expect(mockRefresh).not.toHaveBeenCalled();
    });
});
