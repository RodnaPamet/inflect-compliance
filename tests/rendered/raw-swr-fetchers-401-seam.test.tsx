/**
 * RAW `useSWR` FETCHERS REACH THE 401 SEAM (#5313).
 *
 * `useSwrSessionSeam` (src/app/providers.tsx) marks the session expired from
 * SWR's `onError`, reading `.status` off the thrown error. A raw fetcher that
 * threw a plain `Error` carried no status, and one that answered a non-OK
 * response with an empty value threw nothing at all, so a lapsed session on
 * those surfaces never raised the session-expired notice, and focus
 * revalidation kept re-sending the 401.
 *
 * Each case mounts the real component under the real seam with every request
 * answering 401, and asserts that the session is marked expired.
 */
import * as React from 'react';
import { render, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/r1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
// Permission seams pull tenant context — passthrough them, as reports-client does.
jest.mock('@/components/require-permission', () => ({
    RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/UpgradeGate', () => ({
    UpgradeGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/PdfExportButton', () => ({
    PdfExportButton: ({ label }: { label: string }) => <button>{label}</button>,
}));

import { useSwrSessionSeam } from '@/app/providers';
import { isSessionExpired, __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { RiskTreatmentPlanCard } from '@/components/risks/RiskTreatmentPlanCard';
import { ControlExceptionsPanel } from '@/components/ControlExceptionsPanel';
import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/reports/ReportsClient';
import { useTenantMembers } from '@/components/ui/user-combobox';
import TraceabilityPanel from '@/components/TraceabilityPanel';
import { TooltipProvider } from '@/components/ui/tooltip';

function WithSeam({ children }: { children: React.ReactNode }) {
    const seam = useSwrSessionSeam();
    return (
        <SWRConfig value={{ ...seam, provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            {children}
        </SWRConfig>
    );
}

beforeEach(() => {
    __resetSessionExpiryForTests();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => '',
    }));
});

afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
});

describe('a 401 from a raw useSWR fetcher marks the session expired', () => {
    it('on the risk treatment-plan card', async () => {
        render(
            <WithSeam>
                <RiskTreatmentPlanCard tenantSlug="acme" riskId="r1" ownerChoices={[]} canWrite canAdmin />
            </WithSeam>,
        );
        await waitFor(() => expect(isSessionExpired()).toBe(true));
    });

    it('on the control exceptions panel', async () => {
        render(
            <WithSeam>
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={[]}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />
            </WithSeam>,
        );
        await waitFor(() => expect(isSessionExpired()).toBe(true));
    });

    it('on the Reports page', async () => {
        const fw = { key: 'SOC2', name: 'SOC 2', hasStatementOfApplicability: false };
        const readiness = {
            framework: { key: 'SOC2', name: 'SOC 2', version: null },
            generatedAt: '2026-07-16T00:00:00.000Z',
            coverage: { total: 0, mapped: 0, unmapped: 0, coveragePercent: 0 },
            bySection: [],
            unmappedRequirements: [],
            controlsMissingEvidence: [],
            overdueTasks: [],
            summary: {
                totalRequirements: 0, mappedRequirements: 0, coveragePercent: 0, implementedRequirements: 0,
                gapRequirements: 0, exceptedRequirements: 0, notApplicableCount: 0, missingEvidenceCount: 0,
                overdueTaskCount: 0, readinessScore: 0,
            },
        };
        render(
            <WithSeam>
                <TooltipProvider delayDuration={0}>
                    <ReportsClient
                        installedFrameworks={[fw]}
                        defaultFrameworkKey="SOC2"
                        initialReadiness={readiness as never}
                        tenantSlug="acme"
                        canEdit
                    />
                </TooltipProvider>
            </WithSeam>,
        );
        await waitFor(() => expect(isSessionExpired()).toBe(true));
    });

    it('in the member picker, which falls back to an empty roster', async () => {
        const { result } = renderHook(() => useTenantMembers('acme'), { wrapper: WithSeam });
        await waitFor(() => expect(result.current.data).toEqual([]));
        expect(isSessionExpired()).toBe(true);
    });

    it('on the traceability panel, which falls back to no data', async () => {
        render(
            <WithSeam>
                <TooltipProvider delayDuration={0}>
                    <TraceabilityPanel
                        apiBase="/api/t/acme/"
                        entityType="asset"
                        entityId="asset-1"
                        canLinkControlRisk
                        canLinkAsset
                        tenantHref={(p: string) => p}
                        tenantSlug="acme"
                    />
                </TooltipProvider>
            </WithSeam>,
        );
        await waitFor(() => expect(isSessionExpired()).toBe(true));
    });
});
