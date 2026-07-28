/**
 * Epic 69 — DashboardClient SWR-driven behaviour test.
 *
 * Pins the pilot migration's three acceptance criteria from the
 * Epic 69 brief:
 *
 *   1. **Cards load via SWR.** The KPI grid + risk distribution +
 *      evidence-status cards re-render when the SWR cache key
 *      `/api/t/{slug}/dashboard/executive` is updated. The
 *      lifecycle is observable: SSR fallback paints first, then
 *      SWR's revalidation overwrites the cache, then the rendered
 *      KPI numbers reflect the new payload.
 *
 *   2. **Background refresh works.** Calling SWR's keyed
 *      `mutate(...)` from outside the component (the same hook a
 *      future `useTenantMutation` invalidate-array would use)
 *      causes the cards to update without a page reload.
 *
 *   3. **No coarse refresh.** This test deliberately does NOT mock
 *      `useRouter().refresh()` because the new client component
 *      doesn't reach for it. The structural test in
 *      `tests/unit/executive-dashboard-page.test.ts` enforces the
 *      negative invariant ("router.refresh() is not called from
 *      page or client").
 */

import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig, useSWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    // Posture hero reads `perms.controls.edit` to gate the Regenerate button.
    usePermissions: () => ({ controls: { edit: true } }),
}));

jest.mock('next-intl', () => {
    // Test-only translator: resolves real en.json values so text
    // assertions match the rendered English.
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, opts?: Record<string, unknown>) => {
            // Resolve the full `ns.key` path from the catalog ROOT so dotted
            // namespaces (e.g. `common.chart`) traverse correctly.
            const full = ns ? `${ns}.${key}` : key;
            let v = full
                .split('.')
                .reduce((o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en as unknown);
            if (typeof v !== 'string') return key;
            if (opts) for (const [p, val] of Object.entries(opts)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
    };
});

// next/link calls into next/navigation. Stub the router so we can
// also assert that `refresh()` is NEVER invoked by the component.
const refreshSpy = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: refreshSpy,
        prefetch: jest.fn(),
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

// Onboarding banner queries its own state — stub it out so the
// dashboard test stays focused on the SWR contract.
jest.mock('@/components/onboarding/OnboardingBanner', () => {
    const Stub = () => <div data-testid="onboarding-banner-stub" />;
    Stub.displayName = 'OnboardingBannerStub';
    return Stub;
});

import DashboardClient from '@/app/t/[tenantSlug]/(app)/dashboard/DashboardClient';
import type { ExecutiveDashboardPayload } from '@/app-layer/repositories/DashboardRepository';
import type { TrendPayload } from '@/app-layer/usecases/compliance-trends';

// ── fetch mock ─────────────────────────────────────────────────────────

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    refreshSpy.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

// ── Fixture helpers ────────────────────────────────────────────────────

function buildExec(overrides: Partial<ExecutiveDashboardPayload> = {}): ExecutiveDashboardPayload {
    return {
        stats: {
            risks: 5,
            controls: 50,
            evidence: 100,
            openTasks: 4,
            openFindings: 2,
            highRisks: 1,
            pendingEvidence: 0,
            overdueEvidence: 0,
        },
        controlCoverage: {
            total: 50,
            applicable: 40,
            implemented: 30,
            inProgress: 5,
            notStarted: 5,
            planned: 0,
            needsReview: 0,
            coveragePercent: 75,
        },
        riskBySeverity: { low: 1, medium: 2, high: 1, critical: 1 },
        riskByStatus: { open: 3, mitigating: 1, accepted: 0, closed: 1 },
        evidenceExpiry: {
            overdue: 0,
            dueSoon7d: 0,
            dueSoon30d: 0,
            noReviewDate: 0,
            current: 100,
        },
        policySummary: {
            total: 5,
            draft: 1,
            inReview: 1,
            approved: 1,
            published: 2,
            archived: 0,
            overdueReview: 0,
        },
        taskSummary: {
            total: 4,
            open: 4,
            inProgress: 0,
            blocked: 0,
            resolved: 0,
            overdue: 0,
        },
        vendorSummary: { total: 0, overdueReview: 0 },
        computedAt: new Date('2026-05-04T00:00:00Z').toISOString(),
        ...overrides,
    };
}

const TRENDS_NULL: TrendPayload | null = null;

function makeWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        // KpiCard subtitles + StatusBadge use Radix Tooltip and need
        // a TooltipProvider in scope. Real app injection happens via
        // the root layout — replicating it here keeps the harness
        // close to production.
        return (
            <SWRConfig
                value={{
                    provider: () => new Map(),
                    shouldRetryOnError: false,
                }}
            >
                <TooltipProvider>{children}</TooltipProvider>
            </SWRConfig>
        );
    };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('DashboardClient — SWR migration acceptance', () => {
    it('renders the SSR fallback synchronously on first paint (no loading flash)', () => {
        const exec = buildExec({
            stats: { ...buildExec().stats, risks: 7 },
        });

        render(
            <DashboardClient
                initialExec={exec}
                initialTrends={TRENDS_NULL}
            />,
            { wrapper: makeWrapper() },
        );

        // First render contains real numbers — proving fallbackData is wired.
        expect(screen.getByText('7')).toBeInTheDocument();
        // No fetch happened on mount-time render — `keepPreviousData` +
        // `fallbackData` together mean the cards display from cache
        // without a loading state.
        // (SWR DOES trigger a background revalidation, but the rendered
        // UI shows fallbackData throughout — we don't need to assert
        // fetch count here, only that the data is visible.)
    });

    it('updates KPI numbers when the SWR cache key is mutated externally', async () => {
        const initial = buildExec({
            stats: { ...buildExec().stats, risks: 7 },
        });
        // The "fresh" payload that the cache will be set to.
        const refreshed = buildExec({
            stats: { ...buildExec().stats, risks: 99 },
        });

        // The fetch implementation switches mid-test. Before the
        // mutation, ANY background revalidation that SWR fires
        // returns `initial`. After the mutation we flip the
        // implementation to return `refreshed` so a slow CI runner
        // that races a revalidation in between the mutate write and
        // the `waitFor` assertion can't overwrite the cache back to
        // `initial`. (Local jest never hit that race; CI did.)
        let currentResponse = initial;
        fetchMock.mockImplementation(async () => ({
            ok: true,
            json: async () => currentResponse,
        }));

        // The scoped SWRConfig (provider: () => new Map()) creates
        // a per-test cache that the global `mutate` from 'swr' does
        // NOT reach. Use a sibling component to grab `mutate` from
        // `useSWRConfig()` — that one IS scoped to the same cache
        // the dashboard reads from.
        let scopedMutate: ReturnType<typeof useSWRConfig>['mutate'] | null =
            null;
        function MutateBridge() {
            scopedMutate = useSWRConfig().mutate;
            return null;
        }

        render(
            <>
                <MutateBridge />
                <DashboardClient
                    initialExec={initial}
                    initialTrends={TRENDS_NULL}
                />
            </>,
            { wrapper: makeWrapper() },
        );

        expect(screen.getByText('7')).toBeInTheDocument();

        // Flip the fetch mock BEFORE the mutate so any racing
        // revalidation lands on `refreshed`.
        currentResponse = refreshed;

        // Imitate what a `useTenantMutation({ ..., invalidate: [
        //     CACHE_KEYS.dashboard.executive(),
        // ] })` site would do post-mutation: write the fresh payload
        // straight into the cache for the dashboard key. Cards
        // re-render without any router.refresh().
        await act(async () => {
            await scopedMutate!(
                '/api/t/acme/dashboard/executive',
                refreshed,
                { revalidate: false },
            );
        });

        await waitFor(() => expect(screen.getByText('99')).toBeInTheDocument());
        expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('renders the trend empty state when initial trends are null and fetch yields null', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => null,
        });

        render(
            <DashboardClient
                initialExec={buildExec()}
                initialTrends={TRENDS_NULL}
            />,
            { wrapper: makeWrapper() },
        );

        // Empty state copy still ships when no trend snapshots exist.
        expect(
            screen.getByText('Trend charts will appear here', { exact: false }),
        ).toBeInTheDocument();
    });

    it('passes RecentActivityCard children through unchanged (server-boundary preservation)', () => {
        render(
            <DashboardClient
                initialExec={buildExec()}
                initialTrends={TRENDS_NULL}
            >
                <div data-testid="recent-activity-card">recent activity</div>
            </DashboardClient>,
            { wrapper: makeWrapper() },
        );

        expect(screen.getByTestId('recent-activity-card')).toBeInTheDocument();
    });
});
