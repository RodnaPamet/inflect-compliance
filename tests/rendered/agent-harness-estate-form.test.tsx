/**
 * DECLARING, EDITING AND REMOVING A SCANNER ESTATE on the harness tab, rendered
 * (#3807, the form for step 4a's API).
 *
 *   1. A READER WITHOUT THE REGISTER KEY gets no control: the estate routes
 *      take `admin.agent_registry`, so a button would only be refused.
 *   2. DECLARING sends exactly `{ name, cadenceHours, sources, scannerAgentId }`
 *      to the estates route. The scanner comes from the register, and one that
 *      already covers an estate is not offered. Nothing is sent until every
 *      source names its owner. A refusal is the server's sentence, inline, with
 *      the dialog open.
 *   3. EDITING starts from the estate as declared, keeps its scanner, and sends
 *      a PATCH to that estate's own path with no scanner in the body.
 *   4. REMOVING waits out the undo window before the DELETE is sent, and Undo
 *      inside the window sends nothing.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantContext: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The people picker reads `/users/assignable`; the members it would list are
// answered here, as buttons, so the test chooses a person the way a user does.
jest.mock('@/components/ui/user-combobox', () => ({
    __esModule: true,
    UserCombobox: ({
        id,
        selectedId,
        onChange,
    }: {
        id: string;
        selectedId: string | null;
        onChange: (userId: string | null) => void;
    }) => (
        <div data-testid={id} data-selected={selectedId ?? ''}>
            {[
                { id: 'u_jane', name: 'Jane Identity' },
                { id: 'u_bob', name: 'Bob Secrets' },
            ].map((m) => (
                <button key={m.id} type="button" onClick={() => onChange(m.id)}>
                    {m.name}
                </button>
            ))}
        </div>
    ),
}));

const mockToast = {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
    custom: jest.fn(() => 'undo-toast'),
};
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

import { EstateHealthCard } from '@/app/t/[tenantSlug]/(app)/agents/reports/harness/EstateHealthCard';
import { computeEstateHealth, type HarnessEstateHealthView } from '@/lib/agentic/harness-estate-health';

const NOW = new Date('2026-10-20T12:00:00.000Z');

const ACME = computeEstateHealth(
    {
        id: 'est_acme',
        name: 'Acme production',
        scannerAgentId: 'agt_a',
        scannerName: 'Acme scanner',
        scannerLive: true,
        cadenceHours: 12,
        sources: [
            { kind: 'entra-sp', owner: { userId: 'u_jane', name: 'Jane Identity', active: true } },
            { kind: 'mcp', owner: { userId: 'u_bob', name: 'Bob Secrets', active: true } },
        ],
    },
    [],
    NOW,
);

const VIEW: HarnessEstateHealthView = {
    generatedAt: NOW.toISOString(),
    scanWindow: 500,
    windowTruncated: false,
    estates: { truncated: false, rows: [ACME] },
};

const SCANNERS = [
    { id: 'agt_a', name: 'Acme scanner' },
    { id: 'agt_new', name: 'Inflect estate scanner' },
];

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    mockRefresh.mockReset();
    Object.values(mockToast).forEach((f) => f.mockClear());
    global.fetch = fetchMock as unknown as typeof fetch;
});

function lastRequest() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe('the estate controls', () => {
    it('offers none to a reader without the register key', () => {
        render(<EstateHealthCard view={VIEW} manage={null} />);
        expect(screen.getByTestId('harness-estate-est_acme')).toBeInTheDocument();
        expect(screen.queryByTestId('harness-estate-declare-button')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-estate-edit-est_acme')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-estate-remove-est_acme')).not.toBeInTheDocument();
    });
});

describe('declaring an estate', () => {
    it('sends the declaration once every source names an owner, with a scanner that covers no estate', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'est_new' }) });
        render(<EstateHealthCard view={VIEW} manage={{ scanners: SCANNERS }} />);

        await user.click(screen.getByTestId('harness-estate-declare-button'));
        const dialog = await screen.findByTestId('harness-estate-form');
        const submit = screen.getByTestId('harness-estate-form-submit');
        expect(submit).toBeDisabled();

        await user.type(within(dialog).getByLabelText(/^Name/), 'Inflect production estate');

        // The scanner: only the one that covers no estate is offered.
        const [scannerPicker, kindPicker] = within(dialog).getAllByRole('combobox');
        await user.click(scannerPicker);
        expect(screen.queryByRole('option', { name: /Acme scanner/ })).not.toBeInTheDocument();
        await user.click(await screen.findByRole('option', { name: /Inflect estate scanner/ }));

        await user.click(kindPicker);
        await user.click(await screen.findByRole('option', { name: /GitHub Actions/ }));
        // A source with no owner yet: still nothing to send.
        expect(submit).toBeDisabled();
        await user.click(within(screen.getByTestId('harness-estate-source-owner-0')).getByText('Jane Identity'));
        expect(submit).toBeEnabled();

        await user.click(submit);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(lastRequest()).toEqual({
            url: '/api/t/acme/admin/agents/harness-estates',
            method: 'POST',
            body: {
                name: 'Inflect production estate',
                cadenceHours: 24,
                sources: [{ kind: 'cicd', ownerUserId: 'u_jane' }],
                scannerAgentId: 'agt_new',
            },
        });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    });

    it("shows the server's refusal inline and keeps the dialog open", async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: false,
            json: async () => ({ error: { message: 'Every source needs an owner who is an active member of this tenant' } }),
        });
        render(<EstateHealthCard view={VIEW} manage={{ scanners: SCANNERS }} />);

        await user.click(screen.getByTestId('harness-estate-declare-button'));
        const dialog = await screen.findByTestId('harness-estate-form');
        await user.type(within(dialog).getByLabelText(/^Name/), 'Second estate');
        const [scannerPicker, kindPicker] = within(dialog).getAllByRole('combobox');
        await user.click(scannerPicker);
        await user.click(await screen.findByRole('option', { name: /Inflect estate scanner/ }));
        await user.click(kindPicker);
        await user.click(await screen.findByRole('option', { name: /Agent tool servers/ }));
        await user.click(within(screen.getByTestId('harness-estate-source-owner-0')).getByText('Bob Secrets'));
        await user.click(screen.getByTestId('harness-estate-form-submit'));

        expect(await screen.findByTestId('harness-estate-form-error')).toHaveTextContent(
            'Every source needs an owner who is an active member of this tenant',
        );
        expect(screen.getByTestId('harness-estate-form')).toBeInTheDocument();
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('says so when every live agent already covers an estate', async () => {
        const user = userEvent.setup();
        render(<EstateHealthCard view={VIEW} manage={{ scanners: [SCANNERS[0]] }} />);
        await user.click(screen.getByTestId('harness-estate-declare-button'));
        expect(await screen.findByTestId('harness-estate-no-scanners')).toBeInTheDocument();
        expect(screen.getByTestId('harness-estate-form-submit')).toBeDisabled();
    });
});

describe('editing an estate', () => {
    it('starts from the declaration, keeps the scanner, and PATCHes that estate', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'est_acme' }) });
        render(<EstateHealthCard view={VIEW} manage={{ scanners: SCANNERS }} />);

        await user.click(screen.getByTestId('harness-estate-edit-est_acme'));
        const dialog = await screen.findByTestId('harness-estate-form');
        expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Acme production');
        expect(screen.getByTestId('harness-estate-scanner-fixed')).toHaveTextContent('Acme scanner');
        expect(screen.getByTestId('harness-estate-source-owner-0')).toHaveAttribute('data-selected', 'u_jane');
        expect(screen.getByTestId('harness-estate-source-owner-1')).toHaveAttribute('data-selected', 'u_bob');

        // Hand the MCP source to Jane, then save.
        await user.click(within(screen.getByTestId('harness-estate-source-owner-1')).getByText('Jane Identity'));
        await user.click(screen.getByTestId('harness-estate-form-submit'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(lastRequest()).toEqual({
            url: '/api/t/acme/admin/agents/harness-estates/est_acme',
            method: 'PATCH',
            body: {
                name: 'Acme production',
                cadenceHours: 12,
                sources: [
                    { kind: 'entra-sp', ownerUserId: 'u_jane' },
                    { kind: 'mcp', ownerUserId: 'u_jane' },
                ],
            },
        });
    });
});

describe('removing an estate', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('sends the DELETE only after the undo window', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ removed: true }) });
        render(<EstateHealthCard view={VIEW} manage={{ scanners: SCANNERS }} />);

        fireEvent.click(screen.getByTestId('harness-estate-remove-est_acme'));
        expect(screen.queryByTestId('harness-estate-est_acme')).not.toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();

        await act(async () => {
            jest.advanceTimersByTime(5_000);
        });
        expect(lastRequest()).toEqual({
            url: '/api/t/acme/admin/agents/harness-estates/est_acme',
            method: 'DELETE',
            body: undefined,
        });
    });

    it('sends nothing when Undo is chosen inside the window', async () => {
        render(<EstateHealthCard view={VIEW} manage={{ scanners: SCANNERS }} />);
        fireEvent.click(screen.getByTestId('harness-estate-remove-est_acme'));

        // The toast the hook rendered carries the Undo button.
        const rendered = (mockToast.custom.mock.calls[0] as unknown as [(id: string) => React.ReactElement])[0]('undo-toast');
        render(rendered);
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

        await act(async () => {
            jest.advanceTimersByTime(5_000);
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('harness-estate-est_acme')).toBeInTheDocument();
    });
});
