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
