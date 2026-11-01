/**
 * #4873 — the SharePoint health page tells healthy from never tested from
 * switched off from failed to load, and its figures lead to the files.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations/sharepoint-health',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce((o: Record<string, unknown>, k) => (o?.[k] as Record<string, unknown>) ?? {}, en);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => t(key);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import SharePointHealthPage from '@/app/t/[tenantSlug]/(app)/admin/integrations/sharepoint-health/page';

const HEALTH = {
    connections: [] as unknown[],
    executions: [] as unknown[],
    evidenceCoverage: { synced: 0, stale: 0, failed: 0, total: 0 },
    problems: [] as unknown[],
    problemsTotal: 0,
    policyLinks: 0,
};
const conn = (over: Record<string, unknown>) => ({
    id: 'c1',
    name: 'Contoso SharePoint',
    isEnabled: true,
    lastTestedAt: '2026-10-30T09:00:00Z',
    lastTestStatus: 'ok',
    ...over,
});

function mockFetch(ok: boolean, body: unknown, status = ok ? 200 : 500) {
    global.fetch = jest.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe('the SharePoint health page', () => {
    it('reads OK only for a passed test; never tested and disabled say so', async () => {
        mockFetch(true, {
            ...HEALTH,
            connections: [
                conn({ id: 'c1' }),
                conn({ id: 'c2', lastTestedAt: null, lastTestStatus: null }),
                conn({ id: 'c3', isEnabled: false }),
            ],
        });
        render(<SharePointHealthPage />);

        expect(await screen.findByTestId('sharepoint-connection-c1')).toHaveTextContent('OK');
        expect(screen.getByTestId('sharepoint-connection-c2')).toHaveTextContent('Never tested');
        expect(screen.getByTestId('sharepoint-connection-c2')).not.toHaveTextContent('OK');
        expect(screen.getByTestId('sharepoint-connection-c3')).toHaveTextContent('Disabled');
    });

    it('a failed read is an error, not four zeros', async () => {
        mockFetch(false, { error: { code: 'FORBIDDEN', message: 'Admin only' } }, 403);
        render(<SharePointHealthPage />);
        expect(await screen.findByText('Admin only')).toBeInTheDocument();
        expect(screen.queryByText('No SharePoint activity yet.')).toBeNull();
    });

    it('with no connection, says SharePoint is not connected and links to Integrations', async () => {
        mockFetch(true, HEALTH);
        render(<SharePointHealthPage />);
        expect(await screen.findByText(/SharePoint is not connected to this workspace/)).toBeInTheDocument();
        const notice = document.getElementById('sharepoint-health-not-connected') as HTMLElement;
        expect(within(notice).getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/t/acme/admin/integrations');
    });

    it('names each run in words', async () => {
        mockFetch(true, {
            ...HEALTH,
            connections: [conn({})],
            executions: [
                { id: 'e1', automationKey: 'sharepoint.audit_pack_export', status: 'PASSED', triggeredBy: 'manual', executedAt: '2026-10-30T09:00:00Z', durationMs: 10 },
            ],
        });
        render(<SharePointHealthPage />);
        expect(await screen.findByText('Audit pack export')).toBeInTheDocument();
        expect(screen.getByText('Passed')).toBeInTheDocument();
        expect(screen.getByText('Manual')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('sharepoint.audit_pack_export');
    });

    it('explains Stale and Failed, and lists the documents behind them', async () => {
        mockFetch(true, {
            ...HEALTH,
            connections: [conn({})],
            evidenceCoverage: { synced: 10, stale: 30, failed: 1, total: 41 },
            problems: [
                { mappingId: 'm1', status: 'FAILED', evidenceId: 'ev1', evidenceTitle: 'Access policy.pdf', errorMessage: 'Access denied', lastSyncedAt: null },
            ],
            problemsTotal: 31,
        });
        render(<SharePointHealthPage />);

        expect(await screen.findByText(/Deleted or moved in SharePoint/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Access policy.pdf' })).toHaveAttribute('href', '/t/acme/evidence?ev=ev1');
        expect(screen.getByText('Access denied')).toBeInTheDocument();
        expect(document.getElementById('sharepoint-health-problems-more')).toHaveTextContent('Showing 1 of 31');
    });
});
