/**
 * Render test for the NIS2 incidents LIST page (`IncidentsClient`) + the
 * create flow (`NewIncidentModal`). Exercises the KPI summary, the table
 * columns (severity / phase badges, next-deadline cell, owner cell),
 * the empty state, and opening the "Open incident" modal — the list /
 * modal statements the usecase-only integration suite doesn't touch.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

// next-intl is ESM (jest cannot parse it); mock resolving real en.json values.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en[ns]);
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v.replace(/<(\w+)>(.*?)<\/\1>/g, (_m: string, _tag: string, inner: string) => inner) : key;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});


jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/incidents',
    useSearchParams: () => new URLSearchParams(),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

// IncidentsClient now derives its detail-route hrefs via useTenantHref,
// which throws outside a TenantProvider. This render harness doesn't mount
// one (same reason it mocks next/navigation + next-intl), so stub the hook
// to the same slug-prefixing shape the provider produces.
jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantHref: () => (path: string) =>
        `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { IncidentsClient, nextOpenDeadline, type IncidentRow } from '@/app/t/[tenantSlug]/(app)/incidents/IncidentsClient';
import { NewIncidentModal } from '@/app/t/[tenantSlug]/(app)/incidents/NewIncidentModal';

function makeRow(overrides: Partial<IncidentRow> = {}): IncidentRow {
    return {
        id: 'inc_1',
        reference: 'INC-2026-001',
        title: 'Ransomware on the billing cluster',
        severity: 'CRITICAL',
        phase: 'CONTAINMENT',
        incidentType: 'RANSOMWARE',
        detectedAt: '2026-06-01T00:00:00.000Z',
        reportable: true,
        ownerUserId: 'user_1',
        createdAt: '2026-06-01T00:00:00.000Z',
        notifications: [
            { kind: 'EARLY_WARNING_24H', dueAt: '2026-06-02T00:00:00.000Z', status: 'OVERDUE' },
            { kind: 'DETAILED_72H', dueAt: '2026-06-04T00:00:00.000Z', status: 'DUE' },
            { kind: 'FINAL_1MONTH', dueAt: '2026-07-01T00:00:00.000Z', status: 'SUBMITTED' },
        ],
        ...overrides,
    };
}

const ROWS: IncidentRow[] = [
    makeRow(),
    makeRow({
        id: 'inc_2',
        reference: 'INC-2026-002',
        title: 'Phishing wave',
        severity: 'LOW',
        phase: 'CLOSED',
        incidentType: 'OTHER',
        reportable: false,
        ownerUserId: null,
        notifications: [],
    }),
];

function withSWR(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{ui}</SWRConfig>;
}

describe('IncidentsClient render', () => {
    afterEach(() => mockSWR.mockReset());

    it('renders the KPI summary + table rows with severity / phase / deadline cells', () => {
        mockSWR.mockReturnValue({ data: ROWS, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));

        // Header + KPI cards.
        expect(screen.getAllByText(/Incidents/).length).toBeGreaterThan(0);
        expect(screen.getByText(/Open incidents/i)).toBeInTheDocument();
        expect(screen.getByText(/Deadlines due \/ overdue/i)).toBeInTheDocument();

        // Rows.
        expect(screen.getByText(/INC-2026-001/)).toBeInTheDocument();
        expect(screen.getByText(/Phishing wave/)).toBeInTheDocument();
        // Severity badge label (Critical) + next-deadline short kind (24h).
        expect(screen.getAllByText(/Critical/).length).toBeGreaterThan(0);
        expect(screen.getByText(/24h/)).toBeInTheDocument();
        // Owner cell — Assigned vs —.
        expect(screen.getAllByText(/Assigned/).length).toBeGreaterThan(0);
    });

    it('opens the create modal from the header button', () => {
        mockSWR.mockReturnValue({ data: ROWS, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));
        fireEvent.click(screen.getByText('Incident'));
        expect(screen.getAllByText(/Open incident/i).length).toBeGreaterThan(0);
        expect(screen.getByPlaceholderText(/Ransomware on the billing cluster/i)).toBeInTheDocument();
    });

    it('hides the create button when canManage is false', () => {
        mockSWR.mockReturnValue({ data: ROWS, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage={false} />));
        expect(screen.queryByText('Incident')).not.toBeInTheDocument();
    });

    it('renders the empty state with no incidents', () => {
        mockSWR.mockReturnValue({ data: [], isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={[]} tenantSlug="acme" canManage />));
        expect(screen.getByText(/No incidents yet/i)).toBeInTheDocument();
    });
});

// #4463 — the Next deadline badge's state (pending / due / overdue) was
// conveyed by its colour alone; the text was only the kind ("24h").
describe('IncidentsClient — the Next deadline badge names its state', () => {
    afterEach(() => mockSWR.mockReset());

    it('reads "24h · Overdue", not a red "24h"', () => {
        mockSWR.mockReturnValue({ data: ROWS, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));
        expect(screen.getByText('24h · Overdue')).toBeInTheDocument();
    });

    it('names a deadline that is due soon, and one that is pending', () => {
        const rows = [
            makeRow({
                notifications: [
                    { kind: 'DETAILED_72H', dueAt: '2026-06-04T00:00:00.000Z', status: 'DUE' },
                ],
            }),
            makeRow({
                id: 'inc_3',
                reference: 'INC-2026-003',
                notifications: [
                    { kind: 'FINAL_1MONTH', dueAt: '2026-07-01T00:00:00.000Z', status: 'PENDING' },
                ],
            }),
        ];
        mockSWR.mockReturnValue({ data: rows, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={rows} tenantSlug="acme" canManage />));
        expect(screen.getByText('72h · Due soon')).toBeInTheDocument();
        expect(screen.getByText('1mo · Pending')).toBeInTheDocument();
    });
});

// #4463 — a search or filter that matches nothing is not an empty register.
describe('IncidentsClient — a search that matches nothing', () => {
    afterEach(() => {
        mockSWR.mockReset();
        window.history.replaceState({}, '', '/');
    });

    it('says nothing matched, not "No incidents yet", and clears back to the register', () => {
        window.history.replaceState({}, '', '/t/acme/incidents?q=no-such-incident');
        mockSWR.mockReturnValue({ data: ROWS, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));

        expect(screen.getByText('No incidents match your search or filters')).toBeInTheDocument();
        expect(screen.queryByText(/No incidents yet/i)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(screen.getByText(/INC-2026-001/)).toBeInTheDocument();
        expect(screen.queryByText('No incidents match your search or filters')).not.toBeInTheDocument();
    });

    it('says nothing matched when a filter hides every row', () => {
        window.history.replaceState({}, '', '/t/acme/incidents?severity=MEDIUM');
        mockSWR.mockReturnValue({ data: ROWS, isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));

        expect(screen.getByText('No incidents match your search or filters')).toBeInTheDocument();
        expect(screen.queryByText(/No incidents yet/i)).not.toBeInTheDocument();
    });
});

// #4463 — the register read stops at the backfill cap. The response says so
// (`truncated`), and the KPI cards come from server counts over every
// incident rather than from the rows that made it into the list.
describe('IncidentsClient — a capped register', () => {
    afterEach(() => mockSWR.mockReset());

    it('shows the truncation banner and the server KPI counts, not counts of the loaded rows', () => {
        mockSWR.mockReturnValue({
            data: {
                rows: ROWS,
                truncated: true,
                kpiCounts: { total: 7200, open: 6100, reportable: 310, deadlinesDueOrOverdue: 12 },
            },
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));

        expect(screen.getByTestId('list-truncation-banner')).toBeInTheDocument();
        // Counted over 7,200 incidents — the two loaded rows would give 1 / 1 / 1.
        expect(screen.getByText('6100')).toBeInTheDocument();
        expect(screen.getByText('310')).toBeInTheDocument();
        expect(screen.getByText('12')).toBeInTheDocument();
        // The rows themselves still render.
        expect(screen.getByText(/INC-2026-001/)).toBeInTheDocument();
    });

    it('shows no banner when the register fits under the cap', () => {
        mockSWR.mockReturnValue({
            data: {
                rows: ROWS,
                truncated: false,
                kpiCounts: { total: 2, open: 1, reportable: 1, deadlinesDueOrOverdue: 1 },
            },
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        });
        render(withSWR(<IncidentsClient initialIncidents={ROWS} tenantSlug="acme" canManage />));
        expect(screen.queryByTestId('list-truncation-banner')).not.toBeInTheDocument();
        expect(screen.getByText(/INC-2026-002/)).toBeInTheDocument();
    });
});

describe('NewIncidentModal submit', () => {
    const origFetch = global.fetch;
    afterEach(() => {
        global.fetch = origFetch;
        jest.clearAllMocks();
    });

    it('POSTs the incident and calls onCreated on success', async () => {
        const onCreated = jest.fn();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'inc_new' }),
        }) as unknown as typeof fetch;

        render(
            withSWR(
                <NewIncidentModal open onClose={jest.fn()} tenantSlug="acme" onCreated={onCreated} />,
            ),
        );
        fireEvent.change(screen.getByPlaceholderText(/Ransomware on the billing cluster/i), {
            target: { value: 'New ransomware event' },
        });
        fireEvent.click(screen.getByText('Create incident'));

        await screen.findByText('Create incident'); // flush microtasks
        await new Promise((r) => setTimeout(r, 0));
        expect(global.fetch).toHaveBeenCalledWith(
            '/api/t/acme/incidents',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(onCreated).toHaveBeenCalledWith('inc_new');
    });

    it('surfaces an API error when the POST fails', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
        render(
            withSWR(
                <NewIncidentModal open onClose={jest.fn()} tenantSlug="acme" onCreated={jest.fn()} />,
            ),
        );
        fireEvent.change(screen.getByPlaceholderText(/Ransomware on the billing cluster/i), {
            target: { value: 'Bad event' },
        });
        fireEvent.click(screen.getByText('Create incident'));
        expect(await screen.findByText(/Failed to open incident/i)).toBeInTheDocument();
    });

    // #4463 — the modal threw its generic message on any non-2xx without
    // reading the body, so the server's reason never reached the person.
    it("shows the server's reason from the error envelope", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({
                error: { code: 'BAD_REQUEST', message: 'Owner must be an active member of this tenant' },
            }),
        }) as unknown as typeof fetch;
        render(
            withSWR(
                <NewIncidentModal open onClose={jest.fn()} tenantSlug="acme" onCreated={jest.fn()} />,
            ),
        );
        fireEvent.change(screen.getByPlaceholderText(/Ransomware on the billing cluster/i), {
            target: { value: 'Event with a stale owner' },
        });
        fireEvent.click(screen.getByText('Create incident'));
        expect(
            await screen.findByText('Owner must be an active member of this tenant'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Failed to open incident/i)).not.toBeInTheDocument();
    });

    it('names an over-long title at its field and sends nothing', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => [] }) as unknown as typeof fetch;
        render(
            withSWR(
                <NewIncidentModal open onClose={jest.fn()} tenantSlug="acme" onCreated={jest.fn()} />,
            ),
        );
        fireEvent.change(screen.getByPlaceholderText(/Ransomware on the billing cluster/i), {
            target: { value: 'x'.repeat(301) },
        });
        fireEvent.click(screen.getByText('Create incident'));
        expect(await screen.findByText(/Keep the title to/)).toBeInTheDocument();
        // (The owner picker loads its members; nothing reaches the create route.)
        expect(global.fetch).not.toHaveBeenCalledWith('/api/t/acme/incidents', expect.anything());
    });
});

// #4463 — "Detected at" is the clock every Article 23 deadline is counted
// from. It was a day-only DatePicker whose value is UTC midnight, so any
// pick moved detection to 00:00 UTC and every deadline fell early.
describe('NewIncidentModal — the detection time', () => {
    const origFetch = global.fetch;
    // 14:37:20 local on 29 Oct 2026 — `advanceTimers` keeps the clock moving
    // so the form's async work still settles.
    const OPENED = new Date(2026, 9, 29, 14, 37, 20);

    beforeEach(() => {
        jest.useFakeTimers({ now: OPENED, advanceTimers: true });
        global.fetch = jest.fn(async (url: string) => ({
            ok: true,
            json: async () => (url === '/api/t/acme/incidents' ? { id: 'inc_new' } : []),
        })) as unknown as typeof fetch;
    });
    afterEach(() => {
        jest.useRealTimers();
        global.fetch = origFetch;
    });

    const createCalls = () =>
        (global.fetch as jest.Mock).mock.calls.filter(([url]) => url === '/api/t/acme/incidents');

    async function submit(onCreated = jest.fn()) {
        fireEvent.change(screen.getByPlaceholderText(/Ransomware on the billing cluster/i), {
            target: { value: 'Ransomware event' },
        });
        fireEvent.click(screen.getByText('Create incident'));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        return onCreated;
    }

    function renderModal(onCreated = jest.fn()) {
        render(
            withSWR(<NewIncidentModal open onClose={jest.fn()} tenantSlug="acme" onCreated={onCreated} />),
        );
        return screen.getByLabelText('Time detected') as HTMLInputElement;
    }

    it('defaults to the minute the form opened, in local time — not midnight', async () => {
        const time = renderModal();
        expect(time.value).toBe('14:37');
        // The day is today's LOCAL date (the picker holds it as that Y/M/D).
        expect(document.querySelector('[data-value="2026-10-29"]')).not.toBeNull();

        await submit();

        expect(createCalls()).toHaveLength(1);
        const body = JSON.parse(createCalls()[0][1].body);
        expect(new Date(body.detectedAt).getTime()).toBe(new Date(2026, 9, 29, 14, 37, 0).getTime());
    });

    it('sends the time the person enters', async () => {
        const time = renderModal();
        fireEvent.change(time, { target: { value: '09:05' } });

        await submit();

        const body = JSON.parse(createCalls()[0][1].body);
        expect(new Date(body.detectedAt).getTime()).toBe(new Date(2026, 9, 29, 9, 5, 0).getTime());
    });

    it('refuses a detection time later than now, and sends nothing', async () => {
        const time = renderModal();
        fireEvent.change(time, { target: { value: '15:00' } });

        await submit();

        expect(screen.getByText('The detection time cannot be in the future.')).toBeInTheDocument();
        expect(createCalls()).toHaveLength(0);
    });

    it('refuses a missing time rather than guess one', async () => {
        const time = renderModal();
        fireEvent.change(time, { target: { value: '' } });

        await submit();

        expect(screen.getByText('Enter the time the incident was detected.')).toBeInTheDocument();
        expect(createCalls()).toHaveLength(0);
    });
});

describe('nextOpenDeadline', () => {
    it('returns the earliest still-open notification, skipping submitted / N-A', () => {
        const next = nextOpenDeadline([
            { kind: 'FINAL_1MONTH', dueAt: '2026-07-01T00:00:00.000Z', status: 'SUBMITTED' },
            { kind: 'DETAILED_72H', dueAt: '2026-06-04T00:00:00.000Z', status: 'DUE' },
            { kind: 'EARLY_WARNING_24H', dueAt: '2026-06-02T00:00:00.000Z', status: 'OVERDUE' },
        ]);
        expect(next?.kind).toBe('EARLY_WARNING_24H');
    });

    it('returns null when every notification is submitted / not-required', () => {
        expect(
            nextOpenDeadline([
                { kind: 'EARLY_WARNING_24H', dueAt: '2026-06-02T00:00:00.000Z', status: 'SUBMITTED' },
                { kind: 'FINAL_1MONTH', dueAt: '2026-07-01T00:00:00.000Z', status: 'NOT_REQUIRED' },
            ]),
        ).toBeNull();
    });
});
