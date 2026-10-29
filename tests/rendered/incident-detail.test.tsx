/**
 * Render test for the NIS2 incident detail page — exercises the Overview
 * (phase tracker, Article 23 deadlines, containment runbook, forensic
 * checklist, IR RACI), Timeline, and Controls tabs across reportable /
 * not-reportable + CLOSED states. Covers the detail-page statements that
 * the integration suite (usecase-only) doesn't.
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
    useParams: () => ({ tenantSlug: 'acme', incidentId: 'inc_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/incidents/inc_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/hooks/use-hydrated-now', () => ({
    useHydratedNow: () => new Date('2026-06-02T00:00:00.000Z'),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

// TP-2 — the page now derives canWrite (for the linked-tasks tab) from the
// tenant context, so the render harness must provide it. `incidents.manage`
// is what shows the page's write controls (#4463); each test sets it.
let mockCanManage = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true },
        appPermissions: {
            incidents: { view: true, manage: mockCanManage },
            tasks: { create: true, edit: true },
        },
    }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import IncidentDetailPage from '@/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page';

function makeIncident(overrides: Record<string, unknown> = {}) {
    return {
        id: 'inc_1',
        reference: 'INC-2026-001',
        title: 'Ransomware on the billing cluster',
        description: 'Attacker encrypted the primary billing database.',
        severity: 'CRITICAL',
        phase: 'CONTAINMENT',
        incidentType: 'RANSOMWARE',
        detectedAt: '2026-06-01T00:00:00.000Z',
        reportable: true,
        reportedAt: null,
        ownerUserId: 'user_1',
        linkedControlIds: ['ctrl_1'],
        completedContainmentSteps: ['RANSOMWARE-1'],
        notifications: [
            { id: 'n1', kind: 'EARLY_WARNING_24H', dueAt: '2026-06-02T00:00:00.000Z', status: 'OVERDUE', submittedAt: null, submissionRef: null },
            { id: 'n2', kind: 'DETAILED_72H', dueAt: '2026-06-04T00:00:00.000Z', status: 'DUE', submittedAt: null, submissionRef: null },
            { id: 'n3', kind: 'FINAL_1MONTH', dueAt: '2026-07-01T00:00:00.000Z', status: 'PENDING', submittedAt: null, submissionRef: null },
        ],
        timeline: [
            { id: 't1', at: '2026-06-01T01:00:00.000Z', actorUserId: 'user_1', entry: 'Incident opened.', phaseAtTime: 'DETECTION' },
        ],
        evidenceLinks: [
            { id: 'e1', evidenceId: 'ev_1', forensicCategory: 'SYSTEM_LOGS', evidence: { id: 'ev_1', title: 'Auth logs', type: 'LINK', status: 'DRAFT' } },
        ],
        ...overrides,
    };
}

function withSWR(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{ui}</SWRConfig>;
}

describe('IncidentDetailPage render', () => {
    afterEach(() => {
        mockSWR.mockReset();
        mockCanManage = true;
    });

    it('renders the reportable RANSOMWARE incident overview (tracker, deadlines, runbook, forensic, RACI)', () => {
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));
        expect(screen.getAllByText(/INC-2026-001/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Not legal advice/i).length).toBeGreaterThan(0);
        expect(screen.getByLabelText(/7-phase incident response tracker/i)).toBeInTheDocument();
        expect(screen.getByText(/Article 23 notification deadlines/i)).toBeInTheDocument();
        expect(screen.getByText(/Containment runbook/i)).toBeInTheDocument();
        expect(screen.getAllByText(/Forensic evidence/i).length).toBeGreaterThan(0);
        expect(screen.getByText(/Incident response roles/i)).toBeInTheDocument();
    });

    it('opens the submit + link-evidence affordances', () => {
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));
        // Submit a notification.
        fireEvent.click(screen.getAllByText('Submit')[0]);
        expect(screen.getByText(/File .* notification|Record the report/i)).toBeInTheDocument();
    });

    it('shows the mark-reportable prompt when not yet reportable', () => {
        mockSWR.mockReturnValue({
            data: makeIncident({ reportable: false, notifications: [] }),
            isLoading: false, error: null, mutate: jest.fn(),
        });
        render(withSWR(<IncidentDetailPage />));
        expect(screen.getByText(/not yet marked reportable/i)).toBeInTheDocument();
        expect(screen.getByText(/Mark reportable/i)).toBeInTheDocument();
    });

    it('renders the timeline + controls tabs', () => {
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));
        fireEvent.click(screen.getByRole('tab', { name: /Timeline/i }));
        expect(screen.getByText(/Incident opened\./)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: /Controls/i }));
        expect(screen.getByText(/Art\.21\(2\) controls/i)).toBeInTheDocument();
    });

    it('renders the loading skeleton when data is absent', () => {
        mockSWR.mockReturnValue({ data: undefined, isLoading: true, error: null, mutate: jest.fn() });
        const { container } = render(withSWR(<IncidentDetailPage />));
        expect(container).toBeTruthy();
    });
});

// #4463 — every write on the page is `incidents.manage` at the route and in
// the usecase. A role without it (Editor, Reader, Auditor, AI admin by
// default) must not be offered a control the server will refuse.
describe('IncidentDetailPage — incidents.manage gates the write controls', () => {
    afterEach(() => {
        mockSWR.mockReset();
        mockCanManage = true;
    });

    const notReportable = () =>
        makeIncident({ reportable: false, notifications: [] });

    it('shows no write control to a viewer without incidents.manage', () => {
        mockCanManage = false;
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        const { container, unmount } = render(withSWR(<IncidentDetailPage />));

        expect(screen.queryByRole('button', { name: 'Advance phase' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Link evidence' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
        // The containment steps are listed with their state, but no box to tick.
        expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Not done').length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole('tab', { name: /Timeline/i }));
        expect(screen.queryByRole('button', { name: 'Add entry' })).not.toBeInTheDocument();
        unmount();

        mockSWR.mockReturnValue({ data: notReportable(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));
        // The explanation stays; the button that acts on it does not.
        expect(screen.getByText(/not yet marked reportable/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Mark reportable' })).not.toBeInTheDocument();
    });

    it('shows every write control to a holder of incidents.manage', () => {
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        const { container, unmount } = render(withSWR(<IncidentDetailPage />));

        expect(screen.getByRole('button', { name: 'Advance phase' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Submit' }).length).toBeGreaterThan(0);
        expect(screen.getByRole('button', { name: 'Link evidence' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
        expect(container.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole('tab', { name: /Timeline/i }));
        expect(screen.getByRole('button', { name: 'Add entry' })).toBeInTheDocument();
        unmount();

        mockSWR.mockReturnValue({ data: notReportable(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));
        expect(screen.getByRole('button', { name: 'Mark reportable' })).toBeInTheDocument();
    });
});

describe('IncidentDetailPage — a refused action shows the server reason', () => {
    const origFetch = global.fetch;
    afterEach(() => {
        global.fetch = origFetch;
        mockSWR.mockReset();
    });

    it('renders the message from the error envelope, not a generic "Action failed"', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({
                error: { code: 'BAD_REQUEST', message: 'Incident is already in that phase.' },
            }),
        }) as unknown as typeof fetch;
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));

        fireEvent.click(screen.getByRole('button', { name: 'Advance phase' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Incident is already in that phase.');
        expect(screen.queryByText('Action failed')).not.toBeInTheDocument();
    });

    it('falls back to "Action failed" when the response carries no reason', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: async () => {
                throw new Error('not json');
            },
        }) as unknown as typeof fetch;
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));

        fireEvent.click(screen.getByRole('button', { name: 'Advance phase' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Action failed');
    });
});
