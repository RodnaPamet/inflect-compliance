/**
 * #4870 — a connection's page names the connection and speaks in words.
 *
 * The title was the provider of the first check run, so a connection that had
 * never run was named nothing; the table printed stored statuses, trigger
 * values and automation keys; Sync was offered on a disabled connection.
 */
import * as React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', connectionId: 'conn_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations/conn_1',
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

jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/LegacyAccessMappingCard', () => ({ LegacyAccessMappingCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/LegacyAccessRunsCard', () => ({ LegacyAccessRunsCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/IntegrationOwnerCard', () => ({ IntegrationOwnerCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/IntegrationPassportCard', () => ({ IntegrationPassportCard: () => null }));
jest.mock('@/components/require-permission', () => ({ RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import ConnectionOutcomePage from '@/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/page';

const run = (over: Record<string, unknown> = {}) => ({
    id: 'run_1',
    provider: 'okta',
    automationKey: 'okta.mfa_enforced',
    controlId: 'ctl_1',
    status: 'PASSED',
    triggeredBy: 'scheduled',
    errorMessage: null,
    executedAt: '2026-10-30T05:00:00Z',
    completedAt: '2026-10-30T05:00:05Z',
    ...over,
});

function mockFetch(connection: Record<string, unknown>, executions: unknown[]) {
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ connection, executions }),
    })) as unknown as typeof fetch;
}

const CONN = { id: 'conn_1', name: 'Okta — EU tenant', provider: 'okta', isEnabled: true, ownerUserId: null };

describe("a connection's page", () => {
    it('is titled by the connection, even before it has ever run', async () => {
        mockFetch(CONN, []);
        render(<ConnectionOutcomePage />);
        expect(await screen.findByRole('heading', { level: 1, name: 'Okta — EU tenant' })).toBeInTheDocument();
        expect(document.getElementById('connection-subtitle')).toHaveTextContent('Okta connection.');
    });

    it('names the check, its status and its trigger in words, and links the control in the app', async () => {
        mockFetch(CONN, [
            run(),
            run({ id: 'run_2', automationKey: 'okta.sync', status: 'PARTIAL', triggeredBy: 'manual', controlId: null }),
        ]);
        render(<ConnectionOutcomePage />);

        expect(await screen.findByText('MFA enforced')).toBeInTheDocument();
        expect(screen.getByText('Sync')).toBeInTheDocument();
        expect(screen.getByText('Passed')).toBeInTheDocument();
        expect(screen.getByText('Partial')).toBeInTheDocument();
        expect(screen.getByText('Scheduled')).toBeInTheDocument();
        expect(screen.getByText('Manual')).toBeInTheDocument();
        for (const raw of ['okta.mfa_enforced', 'PASSED', 'PARTIAL', 'scheduled']) {
            expect(document.body.textContent).not.toContain(raw);
        }
        expect(screen.getByRole('link', { name: 'View control' })).toHaveAttribute('href', '/t/acme/controls/ctl_1');
    });

    it('offers Sync now on an enabled connection only', async () => {
        mockFetch({ ...CONN, isEnabled: false }, []);
        render(<ConnectionOutcomePage />);
        await screen.findByRole('heading', { level: 1, name: 'Okta — EU tenant' });
        expect(document.getElementById('connection-sync-btn')).toBeNull();
        expect(document.getElementById('connection-subtitle')).toHaveTextContent('disabled');
    });

    it('the breadcrumb runs Dashboard, Admin, Integrations, the connection', async () => {
        mockFetch(CONN, []);
        render(<ConnectionOutcomePage />);
        await screen.findByRole('heading', { level: 1, name: 'Okta — EU tenant' });
        const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
        await waitFor(() => {
            for (const label of ['Dashboard', 'Admin', 'Integrations', 'Okta — EU tenant']) {
                expect(within(crumbs).getByText(label)).toBeInTheDocument();
            }
        });
    });
});
