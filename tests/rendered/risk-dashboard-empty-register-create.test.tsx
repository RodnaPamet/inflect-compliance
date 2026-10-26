/**
 * The risk dashboard's empty register offers Create only to a user the create
 * route accepts.
 *
 * Its status card showed "Create your first risk" to every role, linking to
 * `/risks?create=1`, where the dialog does not open for a role that cannot
 * create. The rule is `riskCanCreate` (the route's `risks.create` and the
 * usecase's write tier), the one the risks list uses; this mounts the real
 * page with an Admin's context and a Reader's.
 */
import { render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';

const mockRoleContext = (role: 'ADMIN' | 'READER') => ({
    tenantName: 'Acme',
    tenantSlug: 'acme',
    permissions: {
        canRead: true,
        canWrite: role === 'ADMIN',
        canAdmin: role === 'ADMIN',
        canAudit: false,
        canExport: true,
    },
    appPermissions: jest.requireActual('@/lib/permissions').getPermissionsForRole(role),
});
let mockTenant = mockRoleContext('ADMIN');

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => mockTenant,
    useMoneyFormatter: () => (v: number | null | undefined) =>
        jest.requireActual('@/lib/risk-coherence').formatCompactCurrency(v),
}));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en[ns],
            );
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});
jest.mock('@visx/responsive', () => ({
    ParentSize: ({ children }: { children: (s: { width: number }) => React.ReactNode }) =>
        children({ width: 600 }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import RiskDashboardPage from '@/app/t/[tenantSlug]/(app)/risks/dashboard/page';

/** A dashboard payload for a workspace with no risks. */
function mockEmptyRegister() {
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith('/risks/dashboard')) {
            return {
                ok: true,
                json: async () => ({
                    risks: [],
                    analytics: {
                        totals: { totalCount: 0, quantifiedCount: 0, totalAle: 0, avgAle: 0, maxAle: 0 },
                        topByAle: [],
                        byCategory: [],
                    },
                    coherence: null,
                    staleness: { staleCount: 0, staleRisks: [] },
                    appetite: null,
                    simulation: null,
                    matrix: null,
                }),
            } as Response;
        }
        return { ok: false, json: async () => null } as Response;
    }) as unknown as typeof fetch;
}

const renderPage = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <RiskDashboardPage />
            </TooltipProvider>
        </SWRConfig>,
    );

describe('Risk dashboard — the empty register offers Create only to a user who can create', () => {
    beforeEach(() => mockEmptyRegister());

    it('an Admin gets the Create button', async () => {
        mockTenant = mockRoleContext('ADMIN');
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-first-run-empty')).toBeInTheDocument());
        expect(screen.getByTestId('risk-first-run-cta')).toBeInTheDocument();
    });

    it('a Reader, whom the create route refuses, gets none', async () => {
        mockTenant = mockRoleContext('READER');
        renderPage();
        await waitFor(() => expect(screen.getByTestId('risk-first-run-empty')).toBeInTheDocument());
        expect(screen.queryByTestId('risk-first-run-cta')).toBeNull();
    });
});
