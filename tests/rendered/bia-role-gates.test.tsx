/** @jest-environment jsdom */

/**
 * #4632 — the Business Impact Analysis pages offer only what the server takes,
 * and say why it refused.
 *
 * An analysis's own page used to offer every change to every role: Mark
 * reviewed, Edit, Delete, dependency Remove, Link control, Add point and Save
 * impact profile all rendered for a Reader, and each ended in a fixed "Failed
 * to save changes." whatever the server said. The register printed the stored
 * criticality code and English column headers.
 */
import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: (...a: unknown[]) => toastError(...a), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// Memoised per namespace — a fresh `t` per render invalidates the register's
// filter-def memo and the suite loops instead of failing.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/audits/business-continuity',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { BusinessContinuityClient, type BiaRow } from '@/app/t/[tenantSlug]/(app)/audits/business-continuity/BusinessContinuityClient';
import { BiaDetailClient, type BiaDetail } from '@/app/t/[tenantSlug]/(app)/audits/business-continuity/[id]/BiaDetailClient';

const DETAIL = {
    id: 'bia-1', name: 'Payments ledger', criticality: 'CRITICAL',
    rtoHours: 4, rpoHours: 1, mtpdHours: 24,
    impactProfile: [{ atHours: 4, financial: 2 }],
    notes: null, reviewedAt: null, processNode: null, ownerUser: null,
    dependencies: [{ id: 'dep-1', dependsOnType: 'ASSET', dependsOnId: 'a-1', targetName: 'Ledger DB', targetPath: '/assets/a-1' }],
    linkedControls: [], evidenceLinks: [],
    recovery: { rank: 1, rationale: 'CRITICAL criticality · MTPD 24h · RTO 4h → recovery #1' },
} as unknown as BiaDetail;

const WRITE_CONTROL_IDS = ['#bia-mark-reviewed-btn', '#bia-edit-btn', '#bia-delete-btn', '#bia-impact-add-row'];

function Wrapper({ children }: { children: React.ReactNode }) {
    const [cache] = React.useState(() => new Map());
    return (
        <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
        </SWRConfig>
    );
}

const fetchMock = jest.fn();
beforeEach(() => {
    toastError.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ options: [] }) }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

describe('BIA analysis page — writes follow the server (#4632)', () => {
    it('without continuity.edit the page is read-only', () => {
        const { container, queryByText, queryByRole, getByLabelText } = render(
            <Wrapper><BiaDetailClient bia={DETAIL} tenantSlug="acme" canWrite={false} /></Wrapper>,
        );
        for (const id of WRITE_CONTROL_IDS) expect(container.querySelector(id)).toBeNull();
        expect(queryByRole('button', { name: 'Remove' })).toBeNull();
        expect(queryByText('Link control')).toBeNull();
        expect(queryByRole('button', { name: 'Add' })).toBeNull();
        // The impact profile is still shown, not editable.
        expect((getByLabelText('At') as HTMLInputElement).readOnly).toBe(true);
    });

    it('with continuity.edit every write is offered', () => {
        const { container, getAllByRole, getByLabelText } = render(
            <Wrapper><BiaDetailClient bia={DETAIL} tenantSlug="acme" canWrite /></Wrapper>,
        );
        for (const id of WRITE_CONTROL_IDS) expect(container.querySelector(id)).not.toBeNull();
        expect(getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0);
        expect((getByLabelText('At') as HTMLInputElement).readOnly).toBe(false);
    });

    it('shows the criticality label, not the stored code', () => {
        const { getByTestId } = render(
            <Wrapper><BiaDetailClient bia={DETAIL} tenantSlug="acme" canWrite={false} /></Wrapper>,
        );
        expect(getByTestId('entity-detail-header').textContent).toContain('Critical');
        expect(getByTestId('entity-detail-header').textContent).not.toContain('CRITICAL');
    });

    it("a refused save shows the server's reason", async () => {
        const { container } = render(
            <Wrapper><BiaDetailClient bia={DETAIL} tenantSlug="acme" canWrite /></Wrapper>,
        );
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
            init?.method === 'PUT'
                ? { ok: false, status: 400, json: async () => ({ error: { code: 'VALIDATION', message: 'Review date is in the future.' } }) }
                : { ok: true, status: 200, json: async () => ({ options: [] }) });
        await act(async () => { fireEvent.click(container.querySelector('#bia-mark-reviewed-btn') as Element); });
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastError.mock.calls[0][0]).toBe('Review date is in the future.');
    });
});

function row(id: string, name: string, criticality: string, rank: number): BiaRow {
    return {
        id, name, criticality, rtoHours: 4, rpoHours: 1, mtpdHours: 24,
        reviewedAt: null, reviewOverdue: true, processNode: null, ownerUser: null,
        recovery: { rank, rationale: 'seeded' },
    };
}

describe('BIA register — labels and truncation (#4632)', () => {
    const ROWS = [row('bia-1', 'Payments ledger', 'CRITICAL', 1), row('bia-2', 'Wiki', 'MEDIUM', 2)];

    it('reads criticality as a label', () => {
        const { container } = render(
            <Wrapper>
                <BusinessContinuityClient initialRows={ROWS} summary={{ total: 2, critical: 1, overdue: 2 }} truncated={false} rankComplete tenantSlug="acme" canWrite={false} />
            </Wrapper>,
        );
        const body = container.querySelector('tbody')?.textContent ?? '';
        expect(body).toContain('Critical');
        expect(body).toContain('Medium');
        expect(body).not.toContain('CRITICAL');
        expect(container.querySelector('[data-testid="list-truncation-banner"]')).toBeNull();
    });

    it('says when the register holds more analyses than it shows', () => {
        const { getByTestId } = render(
            <Wrapper>
                <BusinessContinuityClient initialRows={ROWS} summary={{ total: 250, critical: 1, overdue: 2 }} truncated rankComplete tenantSlug="acme" canWrite={false} />
            </Wrapper>,
        );
        const banner = getByTestId('list-truncation-banner').textContent ?? '';
        expect(banner).toContain('They are the first in recovery order');
    });
});
