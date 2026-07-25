/**
 * Epic 69 — pilot SWR migration of the executive dashboard.
 *
 * Pattern (the canonical Next.js + SWR shape, applied here for the
 * first time in the codebase — future page migrations follow this
 * exact recipe):
 *
 *   server `page.tsx` ──fetches once──▶ initialExec / initialTrends
 *                                       │
 *                                       ▼
 *                       <DashboardClient initialExec=… initialTrends=…>
 *                                       │
 *                                       ▼
 *                       useTenantSWR(CACHE_KEYS.dashboard.executive(),
 *                                    { fallbackData: initialExec })
 *
 * What this gets us that the all-server version did NOT:
 *
 *   - **Background revalidation on focus / reconnect.** The user
 *     leaves the tab, comes back, the KPI numbers are fresh — no
 *     full-page reload, no router.refresh(). The Epic 69 hook's
 *     `keepPreviousData: true` default means the cards never
 *     flash to a skeleton during the background fetch.
 *
 *   - **Programmatic invalidation by mutation sites.** The control
 *     status flip (control detail page), the risk bulk status/delete
 *     (RisksClient), and the evidence upload (UploadEvidenceModal)
 *     each invalidate `CACHE_KEYS.dashboard.executive()`, so those
 *     mutations trigger a background refetch of just this card stack
 *     — the right granularity, no coarse `router.refresh()` needed.
 *     New mutation sites that shift a headline KPI should add the
 *     same key to their `invalidate` list.
 *
 *   - **Zero loading flash on first paint.** The server still
 *     fetches and serialises the initial payload, so SWR's
 *     `fallbackData` makes `data` defined synchronously on mount.
 *     The page renders identical bytes to the pre-migration
 *     version on cold visit.
 *
 * Why this is a "pilot":
 *
 *   - Only the executive payload + the trend payload move into
 *     SWR cache. RecentActivityCard stays a server component
 *     (passed as `children` from `page.tsx`) because there's no
 *     API route for it yet. Migrating it is a self-contained
 *     follow-up.
 *
 *   - The pattern documented here is the template for migrating
 *     /controls, /risks, /evidence list pages next. The four
 *     moving parts (server fetch → fallback → useTenantSWR →
 *     children for sub-trees that stay server-rendered) are
 *     the same on every page.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    ShieldCheck,
    AlertTriangle,
    Paperclip,
    CheckCircle2,
    Bug,
    FileText,
    TrendingUp,
    ArrowUpRight,
    Boxes,
    ClipboardCheck,
    FlaskConical,
    type LucideIcon,
} from 'lucide-react';

import OnboardingBanner from '@/components/onboarding/OnboardingBanner';
import { Skeleton } from '@/components/ui/skeleton';
import KpiCard from '@/components/ui/KpiCard';
import ProgressCard from '@/components/ui/ProgressCard';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useLocalStorage } from '@/components/ui/hooks';
import type {
    DashboardKpiCardDto,
    SwappableKpiKey,
} from '@/app-layer/usecases/dashboard';
// PR3 perf: lazy-load the heavy viz components (visx + motion) so their code
// splits into separate chunks loaded after the KPI/hero shell. `ssr: false`
// keeps the heavy chart JS off the server-render + initial critical path; a
// sized skeleton fallback holds the layout to avoid CLS while the chunk loads.
// KPI numbers / hero / next-best-action stay statically imported (instant).
const DonutChart = dynamic(() => import('@/components/ui/DonutChart'), {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full min-h-[200px] rounded-lg" />,
});
const TrendCard = dynamic(
    () => import('@/components/ui/TrendCard').then((m) => m.TrendCard),
    { ssr: false, loading: () => <Skeleton className="h-full w-full min-h-[120px] rounded-lg" /> },
);
// PR-A — switched from the auto-wrapping default StatusBreakdown
// to the non-wrapping primitive so the Evidence Status card can
// host the breakdown + a trend mini-chart inside ONE Card without
// nested-cards (the legacy default-export wraps itself in
// cardVariants()).
import { StatusBreakdown } from '@/components/ui/status-breakdown';
const RiskMatrix = dynamic(
    () => import('@/components/ui/RiskMatrix').then((m) => m.RiskMatrix),
    { ssr: false, loading: () => <Skeleton className="h-full w-full min-h-[280px] rounded-lg" /> },
);
const ExpiryCalendar = dynamic(() => import('@/components/ui/ExpiryCalendar'), {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full min-h-[240px] rounded-lg" />,
});
import { cn } from '@/lib/cn';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref, usePermissions, useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { HeroMetric } from '@/components/ui/HeroMetric';
import { KPIStat } from '@/components/ui/metric';
import { NextBestActionCard } from '@/components/ui/NextBestActionCard';
import { PostureHeroCard } from './PostureHeroCard';
import type { PostureSummaryDto } from '@/app-layer/usecases/compliance-posture';
import {
    DashboardChartProvider,
    useDashboardChartFocus,
    type DashboardKpiKey,
} from './DashboardChartContext';

import type { ExecutiveDashboardPayload } from '@/app-layer/repositories/DashboardRepository';
import type { TrendPayload } from '@/app-layer/usecases/compliance-trends';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';

// ─── KPI trend bundle ─────────────────────────────────────────────────

type KpiTrendBundle = {
    coverage?: ReadonlyArray<{ date: Date; value: number }>;
    risks?: ReadonlyArray<{ date: Date; value: number }>;
    evidence?: ReadonlyArray<{ date: Date; value: number }>;
    findings?: ReadonlyArray<{ date: Date; value: number }>;
};

function deriveTrendBundle(
    trends: TrendPayload | null | undefined,
): KpiTrendBundle | undefined {
    // Defensive: a trend snapshot for a fresh tenant may have
    // `daysAvailable >= 2` from the snapshot machinery while
    // `dataPoints` is still empty mid-rollout (or missing entirely
    // if the upstream returns an unexpected shape). Guard both.
    if (!trends || trends.daysAvailable < 2 || !trends.dataPoints?.length) {
        return undefined;
    }
    return {
        coverage: trends.dataPoints.map((d) => ({
            date: new Date(d.date),
            value: d.controlCoveragePercent,
        })),
        risks: trends.dataPoints.map((d) => ({
            date: new Date(d.date),
            value: d.risksOpen,
        })),
        evidence: trends.dataPoints.map((d) => ({
            date: new Date(d.date),
            value: d.evidenceOverdue,
        })),
        findings: trends.dataPoints.map((d) => ({
            date: new Date(d.date),
            value: d.findingsOpen,
        })),
    };
}

// ─── Component ────────────────────────────────────────────────────────

interface DashboardClientProps {
    initialExec: ExecutiveDashboardPayload;
    initialTrends: TrendPayload | null;
    matrixConfig: RiskMatrixConfigShape;
    /**
     * Server-fetched cached AI compliance-posture summary (or null when the
     * daily cron has not yet produced one). Feeds the masthead hero; the
     * client revalidates it via SWR + on-demand regenerate. Optional so
     * pre-existing render tests that predate the posture hero still compile —
     * absent behaves like null (the coverage-% fallback hero renders).
     */
    initialPostureSummary?: PostureSummaryDto | null;
    /**
     * RecentActivityCard remains a Server Component (no API route
     * yet) and is rendered into the dashboard tree by the parent
     * server page. Passing it through `children` preserves the
     * server boundary.
     */
    children?: React.ReactNode;
}

export default function DashboardClient({
    initialExec,
    initialTrends,
    matrixConfig,
    initialPostureSummary,
    children,
}: DashboardClientProps) {
    const t = useTranslations('dashboard');
    const href = useTenantHref();
    const apiUrl = useTenantApiUrl();
    const perms = usePermissions();

    // Primary KPI / coverage / risk-distribution payload. The
    // `fallbackData` makes `data` defined synchronously on mount —
    // there is no loading state on first render. Background
    // revalidation kicks in on focus / reconnect.
    const { data: execFromCache } = useTenantSWR<ExecutiveDashboardPayload>(
        CACHE_KEYS.dashboard.executive(),
        { fallbackData: initialExec },
    );

    // Trend payload — same hybrid pattern. The 30-day query window
    // is fixed across the dashboard's lifetime, so it's safe to bake
    // into the cache key.
    const { data: trends } = useTenantSWR<TrendPayload | null>(
        // The 30-day window is baked into the key itself (see swr-keys),
        // so a mutation-site `mutate(CACHE_KEYS.dashboard.trends())`
        // targets exactly this entry.
        CACHE_KEYS.dashboard.trends(),
        // Pre-Epic-69 the server-fetched trend was passed as
        // `null` when the snapshot history was too short to plot;
        // the type allows that and the SWR cache treats null as a
        // legitimate value (not "missing").
        { fallbackData: initialTrends },
    );

    // SWR's contract is `data | undefined`; the fallback narrows it
    // for first paint. The `??` keeps TS happy AND defends against
    // the (theoretical) case where SWR clears the cache out from
    // under us. Local name is `exec` to match the existing structural
    // pins (E2E selectors + dashboard-page test reads `cells={exec.X}`,
    // `items={exec.X}`).
    const exec = execFromCache ?? initialExec;
    const trendBundle = deriveTrendBundle(trends ?? initialTrends ?? undefined);

    // Cached AI compliance-posture summary. Same hybrid SSR+SWR pattern: the
    // server-fetched row is the fallback so the hero renders synchronously on
    // first paint. The LLM is NEVER called here — only the cached row is read.
    const { data: postureSummary, mutate: mutatePosture } =
        useTenantSWR<PostureSummaryDto | null>(CACHE_KEYS.dashboard.postureSummary(), {
            fallbackData: initialPostureSummary,
        });

    const [regenerating, setRegenerating] = React.useState(false);
    const handleRegeneratePosture = React.useCallback(async () => {
        setRegenerating(true);
        try {
            await apiPost(apiUrl('/dashboard/posture-summary/regenerate'), {});
            // Revalidate the cached GET so the hero picks up the fresh row.
            await mutatePosture();
        } catch {
            // Non-fatal — the hero keeps showing the prior summary.
        } finally {
            setRegenerating(false);
        }
    }, [apiUrl, mutatePosture]);

    // UI-15: the dashboard no longer surfaces a notifications button on a new
    // notification — the top-bar notifications bell is the single canonical
    // affordance. Header carries no extra action here.
    const headerActions = undefined;

    // v2-PR-10 — masthead hero metric. Single 72px control-coverage
    // figure as the user's first verdict on the page. Trend delta
    // resolved from the 30-day coverage trend bundle (last point
    // minus the previous point — same calculation the per-KPI trend
    // chip uses, just expressed as a 7-day window).
    const coverageTrend = trendBundle?.coverage;
    const coverageDelta = (() => {
        if (!coverageTrend || coverageTrend.length < 2) return null;
        const last = coverageTrend[coverageTrend.length - 1];
        const prev = coverageTrend[coverageTrend.length - 2];
        if (!last || !prev) return null;
        return last.value - prev.value;
    })();

    return (
        // R17-PR6 — dashboard chart-filter coordination. The provider
        // holds the currently-selected KPI (or null). PR-7 wires the
        // KpiCards as click consumers; PR-8+ wire the chart sections
        // to subscribe + filter their data. Today this provider is a
        // pass-through — the dashboard renders identically to pre-R17
        // until the consumers light up.
        <DashboardChartProvider>
        <DashboardLayout
            header={{
                title: t('title'),
                description: t('subtitle'),
                actions: headerActions,
            }}
        >
            <OnboardingBanner />

            {/* ─── Masthead — AI compliance-posture summary (cached daily) ───
                 postureLabel + maturityScore headline, narrative, and top
                 next-steps, with control coverage kept as a secondary stat.
                 Falls back to the classic 72px coverage <HeroMetric> when no
                 cached summary exists yet (fresh tenant / cron not yet run /
                 LLM disabled) so the masthead is never blank. */}
            {(postureSummary ?? initialPostureSummary) ? (
                <PostureHeroCard
                    summary={(postureSummary ?? initialPostureSummary)!}
                    canRegenerate={perms.controls.edit}
                    onRegenerate={handleRegeneratePosture}
                    regenerating={regenerating}
                />
            ) : (
                <HeroMetric
                    eyebrow={t('controls')}
                    value={exec.controlCoverage.coveragePercent}
                    format="percent"
                    description={`${exec.controlCoverage.implemented} of ${exec.controlCoverage.applicable} controls implemented`}
                    delta={coverageDelta}
                    deltaPolarity="up-good"
                    deltaLabel="vs prev"
                    data-testid="dashboard-hero"
                />
            )}

            {/* ─── KPI Grid (6 cards) — R17-PR7: each tile is now a
                 keyboard-accessible button wired into the dashboard
                 chart-filter context. Clicking a tile toggles the
                 dashboard's selectedKpi; PR-8+ will subscribe the
                 charts to that focus and re-render their data. ─── */}
            <InteractiveKpiGrid exec={exec} trendBundle={trendBundle} t={t} />

            {/* ─── Swappable custom-KPI card ───
                 A picker chooses a KPI from a catalog that isn't part of
                 the fixed executive payload (assets / audits / control
                 tests); the chosen KPI swaps BOTH its tile and the pie it
                 renders. Loaded on demand. "Pie now, trends later" — the
                 trend slot shows a collecting-data notice until snapshot
                 history exists. */}
            <CustomKpiPanel />

            {/* ─── Control Coverage + Risk Distribution ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <ChartFocusWrapper kpiKey="coverage">
                    <ProgressCard
                        id="control-coverage"
                        label={t("controlCoverage")}
                        value={exec.controlCoverage.implemented}
                        max={exec.controlCoverage.applicable || 1}
                        segments={[
                            {
                                label: 'Implemented',
                                value: exec.controlCoverage.implemented,
                                color: 'bg-bg-success-emphasis',
                            },
                            {
                                label: 'In Progress',
                                value: exec.controlCoverage.inProgress,
                                color: 'bg-bg-warning-emphasis',
                            },
                            {
                                label: 'Not Started',
                                value: exec.controlCoverage.notStarted,
                                color: 'bg-border-emphasis',
                            },
                        ]}
                        // PR-A — coverage-over-time mini chart. Picks the
                        // single most useful KPI for this card (the
                        // metric the card already headlines) and shows
                        // its trajectory inside the same surface.
                        trend={
                            trendBundle?.coverage &&
                            trendBundle.coverage.length > 1
                                ? {
                                      label: 'Coverage (trend)',
                                      points: trendBundle.coverage,
                                      colorClassName: 'text-content-success',
                                      format: '%',
                                  }
                                : undefined
                        }
                    />
                </ChartFocusWrapper>
                <RiskDistributionSection exec={exec} />
            </div>

            {/* ─── Evidence Status + Compliance Alerts ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <ChartFocusWrapper kpiKey="evidence">
                    <EvidenceStatusSection
                        exec={exec}
                        trendBundle={trendBundle}
                    />
                </ChartFocusWrapper>
                <ComplianceAlerts exec={exec} t={t} />
            </div>

            {/* ─── Task Status + Policy Status ─── */}
            {/* The Tasks + Policies KPI tiles focus these donuts (they
                no longer navigate away). Same donut chassis as Risk
                Distribution so the chart row reads as one unified set. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <StatusDonutSection
                    id="task-status"
                    donutId="task-status-donut"
                    kpiKey="tasks"
                    title={t("taskStatus")}
                    centerSub="Tasks"
                    segments={[
                        { label: 'Open', value: exec.taskSummary.open, color: '#3b82f6', href: href('/tasks?status=OPEN,TRIAGED') },
                        { label: 'In Progress', value: exec.taskSummary.inProgress, color: '#f59e0b', href: href('/tasks?status=IN_PROGRESS') },
                        { label: 'Blocked', value: exec.taskSummary.blocked, color: '#dc2626', href: href('/tasks?status=BLOCKED') },
                        { label: 'Resolved', value: exec.taskSummary.resolved, color: '#22c55e', href: href('/tasks?status=RESOLVED,CLOSED,CANCELED') },
                    ]}
                />
                <StatusDonutSection
                    id="policy-status"
                    donutId="policy-status-donut"
                    kpiKey="policies"
                    title={t("policyStatus")}
                    centerSub="Policies"
                    segments={[
                        { label: 'Draft', value: exec.policySummary.draft, color: '#94a3b8', href: href('/policies?status=DRAFT') },
                        { label: 'In Review', value: exec.policySummary.inReview, color: '#f59e0b', href: href('/policies?status=IN_REVIEW') },
                        { label: 'Approved', value: exec.policySummary.approved, color: '#3b82f6', href: href('/policies?status=APPROVED') },
                        { label: 'Published', value: exec.policySummary.published, color: '#22c55e', href: href('/policies?status=PUBLISHED') },
                        { label: 'Archived', value: exec.policySummary.archived, color: '#64748b', href: href('/policies?status=ARCHIVED') },
                    ]}
                />
            </div>

            {/* ─── Exception Inventory + Treatment-Plan Status (G-5/G-7) ───
                 These two health cards surface data getExecutiveDashboard
                 already computes (exec.exceptions / exec.treatmentPlans).
                 Neither entity has a dedicated list page — exceptions are
                 managed per-control and treatment plans per-risk — so each
                 card drills through to its parent-entity list. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <ExceptionSummaryCard exec={exec} href={href} />
                <TreatmentPlanCard exec={exec} href={href} />
            </div>

            {/* ─── Risk Heatmap + Evidence Expiry ─── */}
            {/* B1 — heatmap subscribes to risks KPI; expiry calendar
                subscribes to evidence KPI. Pre-B1 these were not in
                the focus graph at all, so clicking the risks card
                only lit RiskDistribution (not the heatmap), and
                clicking the evidence card only lit EvidenceStatus
                (not the expiry calendar). Both compose with
                <ChartFocusWrapper> the same way the trend cards do. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <ChartFocusWrapper kpiKey="risks">
                    <RiskMatrix
                        id="risk-heatmap"
                        config={matrixConfig}
                        cells={exec.riskHeatmap}
                        showSwapToggle={false}
                    />
                </ChartFocusWrapper>
                <ChartFocusWrapper kpiKey="evidence" className="h-full">
                    <ExpiryCalendar
                        id="expiry-calendar"
                        items={exec.upcomingExpirations}
                        fill
                    />
                </ChartFocusWrapper>
            </div>

            {/* ─── Trend Section ─── */}
            {trends &&
            trends.daysAvailable >= 2 &&
            trends.dataPoints?.length ? (
                <TrendSection trends={trends} />
            ) : (
                <TrendEmptyState />
            )}

            {/* ─── Next Best Action + Recent Activity (v2-PR-11) ─── */}
            {/* The Quick-Actions 6-button grid was retired in favour of
                a state-driven decisive recommendation. The 3-link
                "Quick add" row below the CTA preserves the most-used
                create affordances without the 6-button noise. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-default">
                <NextBestActionCard
                    input={{
                        coveragePercent: exec.controlCoverage.coveragePercent,
                        overdueEvidence: exec.evidenceExpiry.overdue,
                        overdueTasks: exec.taskSummary.overdue,
                        highRisks: exec.stats.highRisks,
                    }}
                    tenantHref={href}
                    quickAdds={[
                        { label: t('addRisk'), href: href('/risks') },
                        { label: t('addEvidence'), href: href('/evidence') },
                        { label: t('newPolicy'), href: href('/policies') },
                    ]}
                />

                {/* RecentActivityCard remains a server component;
                    rendered by the parent page and passed in here. */}
                {children ?? (
                    <Card className="space-y-compact">
                        <Skeleton className="h-4 w-full sm:w-32" />
                        <div className="space-y-tight">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <div key={i} className="flex items-start gap-tight">
                                    <Skeleton className="h-3 w-full sm:w-28 shrink-0" />
                                    <Skeleton
                                        className={`h-3 ${i % 2 === 0 ? 'w-full' : 'w-3/4'}`}
                                    />
                                </div>
                            ))}
                        </div>
                    </Card>
                )}
            </div>
        </DashboardLayout>
        </DashboardChartProvider>
    );
}

// ─── Chart focus wrapper (R17-PR9) ───────────────────────────────────
//
// Generic wrapper that gives any dashboard chart the same
// focus-or-dim affordance the RiskDistributionSection got in PR-8.
// Pass `kpiKey` matching the KpiCard that "owns" this chart;
// when that KPI is selected, the wrapper applies the brand ring
// (focused). When ANY OTHER KPI is selected, it dims to 60%.
// Null selection ⇒ baseline render.
//
// The wrapper is a plain `<div>` (no card chassis of its own) so
// it composes cleanly around an already-styled section without
// double-bordering. The `rounded-lg` mirrors the underlying card's
// radius so the ring traces the card boundary, not a wider rect.

function ChartFocusWrapper({
    kpiKey,
    children,
    id,
    className,
}: {
    kpiKey: DashboardKpiKey;
    children: React.ReactNode;
    /** Optional anchor id so the KPI click-to-scroll can target a
        chart that has no inner id of its own (e.g. the trend cards). */
    id?: string;
    /** Extra classes on the wrapper. Used to (a) stretch a wrapper to
        its grid cell (`h-full`, so a short child fills the row height)
        and (b) give the borderless trend tiles a segregating surface
        (`border …`). */
    className?: string;
}) {
    const { selectedKpi } = useDashboardChartFocus();
    const isFocused = selectedKpi === kpiKey;
    const isDimmed = selectedKpi !== null && !isFocused;
    return (
        <div
            id={id}
            data-chart-focus={isFocused ? 'true' : undefined}
            data-chart-dimmed={isDimmed ? 'true' : undefined}
            data-chart-focus-key={kpiKey}
            className={cn(
                "rounded-lg transition-opacity duration-200 ease-out",
                isFocused &&
                    "ring-2 ring-brand-default ring-offset-2 ring-offset-bg-page",
                isDimmed && "opacity-60",
                className,
            )}
        >
            {children}
        </div>
    );
}

// ─── KPI drill-through tile ───────────────────────────────────────────
//
// Wraps a KpiCard (which owns the R17 focus-on-click interaction) with
// a corner drill-through link so a click can NAVIGATE to the KPI's
// filtered entity list. The link is a sibling overlay — NOT nested in
// the KpiCard's focus button (invalid) and NOT a dependency of the
// shared KpiCard primitive (which stays lean). Focus stays on the card
// body; the arrow navigates.

function KpiTile({
    drillHref,
    drillLabel,
    children,
}: {
    drillHref: string;
    drillLabel: string;
    children: React.ReactNode;
}) {
    return (
        // `h-full` so the tile fills its (grid-stretched) cell; combined
        // with `h-full` on the inner KpiCard this equalises every tile's
        // height regardless of whether it carries a sparkline. Without it
        // the trend-less Open-tasks / Policies tiles rendered shorter than
        // their sparkline-bearing siblings.
        <div className="relative h-full">
            {children}
            <Link
                href={drillHref}
                aria-label={drillLabel}
                data-kpi-drill
                className="absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md text-content-subtle opacity-60 transition hover:bg-bg-muted hover:text-content-default hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
        </div>
    );
}

// ─── Interactive KPI Grid (R17-PR7) ──────────────────────────────────
//
// Sits inside <DashboardChartProvider> so it can subscribe to the
// chart-filter context. Each tile is a clickable button that
// toggles the dashboard's selectedKpi. PR-8+ will subscribe the
// charts to the same focus to filter their data.

// Every KPI tile now has a corresponding chart on the dashboard, so a
// click ALWAYS focuses that chart (donut, trend card, or matrix) —
// never navigates. The earlier B1 workaround navigated tasks/policies
// to their list page because they had no chart to light up; they now
// own the Task-status and Policy-status donuts below, so the whole
// grid behaves consistently (click = focus, no surprise navigation).

// Each KPI's owning chart, by DOM id, for the click-to-scroll below.
// These are the topmost chart that the KPI lights up; `findings` has
// no standalone chart so it anchors to its trend card (rendered only
// when the trend section is present — the scroll is a no-op otherwise).
const CHART_SCROLL_TARGETS: Record<DashboardKpiKey, string> = {
    coverage: 'control-coverage',
    risks: 'risk-distribution',
    evidence: 'evidence-status',
    tasks: 'task-status',
    policies: 'policy-status',
    findings: 'findings-trend',
};

// Bring a KPI's owning chart into view when the tile is focused, but
// only if it isn't already fully on screen (e.g. it sits below the
// fold). Already-visible charts don't jump.
function scrollChartIntoView(kpi: DashboardKpiKey) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(CHART_SCROLL_TARGETS[kpi]);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!fullyVisible) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function InteractiveKpiGrid({
    exec,
    trendBundle,
    t,
}: {
    exec: ExecutiveDashboardPayload;
    trendBundle: KpiTrendBundle | undefined;
    t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
    const { selectedKpi, toggleSelectedKpi } = useDashboardChartFocus();
    const href = useTenantHref();
    const isSelected = (kpi: DashboardKpiKey) => selectedKpi === kpi;
    // Every tile is chart-bound now: a click focuses its chart. When
    // focusing (not clearing), also scroll that chart into view if it's
    // below the current viewport. The rAF defer lets the focus ring
    // paint before we measure/scroll.
    const click = (kpi: DashboardKpiKey) => () => {
        const willFocus = selectedKpi !== kpi;
        toggleSelectedKpi(kpi);
        if (willFocus) {
            requestAnimationFrame(() => scrollChartIntoView(kpi));
        }
    };

    return (
        <div
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-default"
            id="kpi-grid"
        >
            <KpiTile drillHref={href('/controls')} drillLabel={t('openList', { label: t('controls') })}>
                <KpiCard
                    id="kpi-coverage"
                    className="h-full"
                    label={t('controls')}
                    value={exec.controlCoverage.coveragePercent}
                    format="percent"
                    icon={ShieldCheck}
                    gradient="from-emerald-500 to-teal-500"
                    subtitle={`${exec.controlCoverage.implemented} of ${exec.controlCoverage.applicable} implemented`}
                    trend={trendBundle?.coverage}
                    trendVariant="success"
                    onClick={click('coverage')}
                    selected={isSelected('coverage')}
                />
            </KpiTile>
            <KpiTile drillHref={href('/risks')} drillLabel={t('openList', { label: t('risks') })}>
                <KpiCard
                    id="kpi-risks"
                    className="h-full"
                    label={t('risks')}
                    value={exec.stats.risks}
                    icon={AlertTriangle}
                    gradient="from-amber-500 to-orange-500"
                    subtitle={t('highCritical', { count: exec.stats.highRisks })}
                    trend={trendBundle?.risks}
                    trendVariant="warning"
                    onClick={click('risks')}
                    selected={isSelected('risks')}
                />
            </KpiTile>
            <KpiTile drillHref={href('/evidence')} drillLabel={t('openList', { label: t('evidence') })}>
                <KpiCard
                    id="kpi-evidence"
                    className="h-full"
                    label={t('evidence')}
                    value={exec.stats.evidence}
                    icon={Paperclip}
                    gradient="from-purple-500 to-pink-500"
                    subtitle={`${exec.evidenceExpiry.overdue} overdue`}
                    trend={trendBundle?.evidence}
                    trendVariant="error"
                    onClick={click('evidence')}
                    selected={isSelected('evidence')}
                />
            </KpiTile>
            <KpiTile drillHref={href('/tasks?status=OPEN,TRIAGED,IN_PROGRESS,IN_REVIEW,BLOCKED')} drillLabel={t('openList', { label: t('openTasks') })}>
                <KpiCard
                    id="kpi-tasks"
                    className="h-full"
                    label={t('openTasks')}
                    value={exec.stats.openTasks}
                    icon={CheckCircle2}
                    gradient="from-indigo-500 to-blue-500"
                    subtitle={`${exec.taskSummary.overdue} overdue`}
                    onClick={click('tasks')}
                    selected={isSelected('tasks')}
                />
            </KpiTile>
            <KpiTile drillHref={href('/policies')} drillLabel={t('openList', { label: t('policies') })}>
                <KpiCard
                    id="kpi-policies"
                    className="h-full"
                    label={t("policies")}
                    value={exec.policySummary.total}
                    icon={FileText}
                    gradient="from-sky-500 to-cyan-500"
                    subtitle={`${exec.policySummary.published} published`}
                    onClick={click('policies')}
                    selected={isSelected('policies')}
                />
            </KpiTile>
            <KpiTile drillHref={href('/findings')} drillLabel={t('openList', { label: t('openFindings') })}>
                <KpiCard
                    id="kpi-findings"
                    className="h-full"
                    label={t('openFindings')}
                    value={exec.stats.openFindings}
                    icon={Bug}
                    gradient="from-red-500 to-rose-500"
                    trend={trendBundle?.findings}
                    trendVariant="error"
                    onClick={click('findings')}
                    selected={isSelected('findings')}
                />
            </KpiTile>
        </div>
    );
}

// ─── Swappable custom-KPI panel ──────────────────────────────────────
//
// A self-contained "pick a KPI" card. The picker chooses from a catalog
// (assets / audits / control tests) that lives OUTSIDE the fixed
// executive payload; selecting one swaps both the tile and the pie it
// renders, fetched on demand from `/dashboard/kpi/{key}`. The selection
// persists in localStorage. Trends are deferred ("pie now, trends
// later") — the third cell shows a collecting-data notice until the
// daily snapshot series carries these entities.

const SWAPPABLE_KPI_META: Record<
    SwappableKpiKey,
    { icon: LucideIcon; gradient: string; drill: string }
> = {
    assets: { icon: Boxes, gradient: 'from-cyan-500 to-blue-500', drill: '/assets' },
    audits: { icon: ClipboardCheck, gradient: 'from-violet-500 to-purple-500', drill: '/audits' },
    tests: { icon: FlaskConical, gradient: 'from-teal-500 to-emerald-500', drill: '/tests' },
};

function CustomKpiPanel() {
    const t = useTranslations('dashboard');
    const href = useTenantHref();
    const router = useRouter();
    const [selected, setSelected] = useLocalStorage<SwappableKpiKey>(
        'dashboard.customKpi',
        'assets',
    );
    const { data, isLoading } = useTenantSWR<DashboardKpiCardDto>(
        CACHE_KEYS.dashboard.kpi(selected),
    );

    // `t()` returns a string; deriving the label directly (rather than
    // reading it back off ComboboxOption.label, which is typed ReactNode)
    // keeps `selectedLabel` a string for the KpiCard label + openList arg.
    const labelFor = (k: SwappableKpiKey): string => t(`customKpi.${k}`);
    const options: ComboboxOption[] = [
        { value: 'assets', label: labelFor('assets') },
        { value: 'audits', label: labelFor('audits') },
        { value: 'tests', label: labelFor('tests') },
    ];
    const selectedLabel = labelFor(selected);
    const meta = SWAPPABLE_KPI_META[selected];
    // Enrich each API segment with the drill-through href so the donut
    // arc + legend row are clickable (DonutChart only wires the click
    // when a segment carries an href). Every slice of one KPI opens that
    // KPI's entity list.
    const segments = (data?.segments ?? []).map((seg) => ({
        ...seg,
        href: href(meta.drill),
    }));
    const total = segments.reduce((sum, seg) => sum + seg.value, 0);

    return (
        <Card id="custom-kpi-panel" className="space-y-default">
            <div className="flex flex-col gap-tight sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <Heading level={3}>{t('customKpi.title')}</Heading>
                    <p className="text-xs text-content-muted mt-0.5">
                        {t('customKpi.subtitle')}
                    </p>
                </div>
                <div className="w-full sm:w-56" id="custom-kpi-picker">
                    <Combobox
                        options={options}
                        selected={options.find((o) => o.value === selected) ?? null}
                        setSelected={(o) => o && setSelected(o.value as SwappableKpiKey)}
                        aria-label={t('customKpi.pick')}
                        forceDropdown
                        matchTriggerWidth
                    />
                </div>
            </div>

            <div className="grid grid-cols-1 items-stretch gap-default md:grid-cols-3">
                {/* Tile — swaps with the selection. */}
                <KpiTile
                    drillHref={href(meta.drill)}
                    drillLabel={t('openList', { label: selectedLabel })}
                >
                    <KpiCard
                        id="custom-kpi-tile"
                        className="h-full"
                        label={selectedLabel}
                        value={isLoading ? null : data?.headline ?? null}
                        loading={isLoading}
                        icon={meta.icon}
                        gradient={meta.gradient}
                        subtitle={data?.subtitle}
                    />
                </KpiTile>

                {/* Pie — the "different pie chart" this KPI renders. */}
                <div
                    className={cn(cardVariants({ density: 'none' }), 'flex items-center')}
                    data-testid="custom-kpi-pie"
                >
                    {isLoading ? (
                        <Skeleton className="mx-auto h-[130px] w-[130px] rounded-full" />
                    ) : total > 0 ? (
                        <div className="grid w-full grid-cols-2 items-center gap-default">
                            <DonutChart
                                id="custom-kpi-donut"
                                segments={segments}
                                size={130}
                                centerLabel={String(total)}
                                centerSub={t('customKpi.total')}
                                showLegend={false}
                                onSegmentClick={(s) => s.href && router.push(s.href)}
                            />
                            <div className="space-y-tight">
                                {segments.map((seg) => (
                                    <DonutLegendRow
                                        key={seg.label}
                                        label={seg.label}
                                        value={seg.value}
                                        dotColor={seg.color}
                                        href={seg.href}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <p className="mx-auto text-sm text-content-muted">
                            {t('customKpi.noData')}
                        </p>
                    )}
                </div>

                {/* Trend — deferred. Pie now, trends later. */}
                <div
                    className={cn(
                        cardVariants({ density: 'none' }),
                        'flex flex-col items-center justify-center gap-tight text-center',
                    )}
                    data-testid="custom-kpi-trend"
                >
                    <TrendingUp className="size-5 text-content-subtle" aria-hidden="true" />
                    <p className="max-w-[24ch] text-xs text-content-muted">
                        {t('customKpi.trendComing')}
                    </p>
                </div>
            </div>
        </Card>
    );
}

// ─── Risk Distribution ───────────────────────────────────────────────
//
// R17-PR8 — the Risk Distribution card now subscribes to the
// dashboard chart-filter context. When the "Risks" KPI tile is
// selected, the card gains a brand-default ring + brighter glow
// (matches the selected tile's affordance). When ANY OTHER KPI is
// selected, the card dims (opacity-60) — visually signalling
// "the focus is elsewhere right now". When no KPI is selected,
// the card renders unchanged (the baseline byte-for-byte).

// A single legend row beside a status/severity donut. When `href` is
// set it becomes a keyboard-accessible link that opens the entity list
// filtered to this slice — the same target the donut arc navigates to.
function DonutLegendRow({
    label,
    value,
    dotClassName,
    dotColor,
    href,
}: {
    label: string;
    value: number;
    dotClassName?: string;
    dotColor?: string;
    href?: string;
}) {
    const body = (
        <>
            <div className="flex items-center gap-1.5">
                <span
                    className={cn('w-2 h-2 rounded-full shrink-0', dotClassName)}
                    style={dotColor ? { backgroundColor: dotColor } : undefined}
                />
                <span className={href ? 'text-content-muted group-hover/legend:text-content-default group-hover/legend:underline' : 'text-content-muted'}>
                    {label}
                </span>
            </div>
            <span className="text-content-default font-medium tabular-nums">
                {value}
            </span>
        </>
    );
    if (!href) {
        return <div className="flex items-center justify-between text-xs">{body}</div>;
    }
    return (
        <Link
            href={href}
            className="group/legend flex items-center justify-between text-xs rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label={`${label}: ${value} — open filtered list`}
        >
            {body}
        </Link>
    );
}

function RiskDistributionSection({
    exec,
}: {
    exec: ExecutiveDashboardPayload;
}) {
    const t = useTranslations('dashboard');
    const href = useTenantHref();
    const router = useRouter();
    const { riskBySeverity, riskByStatus } = exec;
    const { selectedKpi } = useDashboardChartFocus();
    const isFocused = selectedKpi === 'risks';
    const isDimmed = selectedKpi !== null && !isFocused;
    // Severity → the risks list filtered by inherent-score range (the
    // same buckets the donut counts): Critical 15-25, High 10-14,
    // Medium 5-9, Low 1-4. `score=min|max` is the risks range token.
    const severitySegments: DonutStatusSegment[] = [
        { label: 'Critical', value: riskBySeverity.critical, color: '#dc2626', href: href('/risks?score=15|25') },
        { label: 'High', value: riskBySeverity.high, color: '#f97316', href: href('/risks?score=10|14') },
        { label: 'Medium', value: riskBySeverity.medium, color: '#f59e0b', href: href('/risks?score=5|9') },
        { label: 'Low', value: riskBySeverity.low, color: '#22c55e', href: href('/risks?score=1|4') },
    ];
    const legendTone: Record<string, string> = {
        Critical: 'bg-bg-error-emphasis',
        High: 'bg-orange-500',
        Medium: 'bg-bg-warning-emphasis',
        Low: 'bg-bg-success-emphasis',
    };
    return (
        <Card
            id="risk-distribution"
            data-chart-focus={isFocused ? 'true' : undefined}
            data-chart-dimmed={isDimmed ? 'true' : undefined}
            className={cn(
                // B3 — card sizing parity with ProgressCard
                // (Control Coverage). Both now `h-full flex flex-col`
                // so the row's two siblings read as deliberately
                // matched in height.
                "h-full flex flex-col transition-opacity duration-200 ease-out",
                isFocused && "ring-2 ring-brand-default ring-offset-2 ring-offset-bg-page",
                isDimmed && "opacity-60",
            )}
        >
            <Heading level={3} className="mb-3">
                {t('riskDistribution')}
            </Heading>
            <div className="grid grid-cols-2 gap-default items-center">
                <DonutChart
                    id="risk-severity-donut"
                    segments={severitySegments}
                    size={130}
                    centerLabel={String(
                        riskBySeverity.critical +
                            riskBySeverity.high +
                            riskBySeverity.medium +
                            riskBySeverity.low,
                    )}
                    centerSub="Total"
                    showLegend={false}
                    onSegmentClick={(s) => s.href && router.push(s.href)}
                />
                <div className="space-y-tight">
                    {severitySegments.map((item) => (
                        <DonutLegendRow
                            key={item.label}
                            label={item.label}
                            value={item.value}
                            dotClassName={legendTone[item.label]}
                            href={item.href}
                        />
                    ))}
                    <div className="border-t border-border-subtle pt-2 mt-2 flex items-center justify-between text-xs">
                        <span className="text-content-muted">{t('openMitigating')}</span>
                        <span className="text-content-default font-medium tabular-nums">
                            {riskByStatus.open} / {riskByStatus.mitigating}
                        </span>
                    </div>
                </div>
            </div>
        </Card>
    );
}

// ─── Generic status-breakdown donut box ──────────────────────────────
//
// The Tasks + Policies KPI tiles used to navigate to their list page
// because they had no chart to focus. They now own a status-breakdown
// donut built on this section, identical in chassis to the Risk
// Distribution box (focus ring + dim + donut + a
// per-status legend with counts) so the chart row reads as one unified
// set of boxes. `kpiKey` ties the box to its KPI tile's focus state.

interface DonutStatusSegment {
    label: string;
    value: number;
    /** Hex used for BOTH the donut arc and the legend dot. */
    color: string;
    /** Tenant-relative drill-through target for this slice (already
     *  resolved to `/t/{slug}/...` by the caller). Clicking the slice or
     *  its legend row opens the entity list filtered to this slice. */
    href?: string;
}

function StatusDonutSection({
    id,
    donutId,
    kpiKey,
    title,
    centerSub,
    segments,
}: {
    id: string;
    donutId: string;
    kpiKey: DashboardKpiKey;
    title: string;
    centerSub: string;
    segments: DonutStatusSegment[];
}) {
    const router = useRouter();
    const { selectedKpi } = useDashboardChartFocus();
    const isFocused = selectedKpi === kpiKey;
    const isDimmed = selectedKpi !== null && !isFocused;
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    return (
        <Card
            id={id}
            data-chart-focus={isFocused ? 'true' : undefined}
            data-chart-dimmed={isDimmed ? 'true' : undefined}
            data-chart-focus-key={kpiKey}
            className={cn(
                'h-full flex flex-col transition-opacity duration-200 ease-out',
                isFocused && 'ring-2 ring-brand-default ring-offset-2 ring-offset-bg-page',
                isDimmed && 'opacity-60',
            )}
        >
            <Heading level={3} className="mb-3">
                {title}
            </Heading>
            <div className="grid grid-cols-2 gap-default items-center">
                <DonutChart
                    id={donutId}
                    segments={segments}
                    size={130}
                    centerLabel={String(total)}
                    centerSub={centerSub}
                    showLegend={false}
                    onSegmentClick={(s) => s.href && router.push(s.href)}
                />
                <div className="space-y-tight">
                    {segments.map((item) => (
                        <DonutLegendRow
                            key={item.label}
                            label={item.label}
                            value={item.value}
                            dotColor={item.color}
                            href={item.href}
                        />
                    ))}
                </div>
            </div>
        </Card>
    );
}

// ─── Evidence Status ─────────────────────────────────────────────────

function EvidenceStatusSection({
    exec,
    trendBundle,
}: {
    exec: ExecutiveDashboardPayload;
    trendBundle: KpiTrendBundle | undefined;
}) {
    const t = useTranslations('dashboard');
    const { evidenceExpiry } = exec;
    const total =
        evidenceExpiry.overdue +
        evidenceExpiry.dueSoon7d +
        evidenceExpiry.dueSoon30d +
        evidenceExpiry.current;
    const currentPercent =
        total > 0 ? Math.round((evidenceExpiry.current / total) * 100) : 0;
    // PR-A — Evidence Status now matches the Compliance Alerts
    // visual weight: a Card with a Heading, the existing four-row
    // breakdown, a percent-current readout, and (when the trend
    // bundle is available) the same evidence-overdue sparkline
    // that the Trend section's TrendCard uses below — so the user
    // can see the trajectory without scrolling.
    return (
        <Card id="evidence-status">
            <div className="flex items-baseline justify-between mb-3 gap-tight">
                <Heading level={3}>{t('evidenceStatus')}</Heading>
                <span
                    className="text-xs text-content-muted tabular-nums"
                    data-testid="evidence-status-current-percent"
                >
                    {currentPercent}% current
                </span>
            </div>
            {/* PR-A — non-wrapping breakdown. The Heading + total
                live on the Card above; each row is a `{ label,
                value, colorClass }` triplet rendered as a single
                line so the four rows stack into the same vertical
                rhythm Compliance Alerts uses. */}
            <StatusBreakdown
                ariaLabel="Evidence status breakdown"
                size="sm"
                showCount
                showPercent
                items={[
                    { label: 'Overdue', value: evidenceExpiry.overdue, colorClass: 'bg-bg-error-emphasis' },
                    { label: 'Due ≤7d', value: evidenceExpiry.dueSoon7d, colorClass: 'bg-bg-warning-emphasis' },
                    { label: 'Due ≤30d', value: evidenceExpiry.dueSoon30d, colorClass: 'bg-bg-warning-emphasis' },
                    { label: 'Current', value: evidenceExpiry.current, colorClass: 'bg-bg-success-emphasis' },
                ]}
            />
            {trendBundle?.evidence && trendBundle.evidence.length > 1 && (
                <div
                    className="mt-default rounded-md bg-bg-muted/30 px-default py-tight"
                    data-testid="evidence-status-trend"
                >
                    <TrendCard
                        label={t("overdueTrend")}
                        value={
                            trendBundle.evidence[trendBundle.evidence.length - 1]
                                .value
                        }
                        points={trendBundle.evidence}
                        colorClassName="text-content-error"
                    />
                </div>
            )}
        </Card>
    );
}

// ─── Compliance Alerts ───────────────────────────────────────────────

function ComplianceAlerts({ exec, t }: { exec: ExecutiveDashboardPayload; t: (key: string, values?: Record<string, string | number | Date>) => string }) {
    const { stats, evidenceExpiry, taskSummary, vendorSummary, policySummary } = exec;
    const alerts: { color: string; text: string }[] = [];

    if (evidenceExpiry.overdue > 0)
        alerts.push({ color: 'bg-bg-error-emphasis', text: t('overdueEvidence', { count: evidenceExpiry.overdue }) });
    if (stats.pendingEvidence > 0)
        alerts.push({ color: 'bg-bg-warning-emphasis', text: t('evidenceAwaitingReview', { count: stats.pendingEvidence }) });
    if (stats.highRisks > 0)
        alerts.push({ color: 'bg-orange-500', text: t('highCriticalRisks', { count: stats.highRisks }) });
    if (taskSummary.overdue > 0)
        alerts.push({ color: 'bg-bg-error-emphasis', text: t('overdueTasksAlert', { count: taskSummary.overdue }) });
    if (policySummary.overdueReview > 0)
        alerts.push({ color: 'bg-bg-warning-emphasis', text: t('policiesNeedReview', { count: policySummary.overdueReview }) });
    if (vendorSummary.overdueReview > 0)
        alerts.push({ color: 'bg-purple-500', text: t('vendorsNeedReview', { count: vendorSummary.overdueReview }) });
    if (stats.openFindings > 0)
        alerts.push({ color: 'bg-purple-500', text: t('openAuditFindings', { count: stats.openFindings }) });

    return (
        <Card id="compliance-alerts">
            <Heading level={3} className="mb-3">
                {t('complianceAlerts')}
            </Heading>
            <div className="space-y-tight">
                {alerts.length === 0 ? (
                    <p className="text-content-success text-sm">{t('noAlerts')}</p>
                ) : (
                    alerts.map((alert, i) => (
                        <div key={i} className="flex items-center gap-tight text-sm">
                            <span
                                className={`w-2 h-2 rounded-full ${alert.color} shrink-0`}
                            />
                            <span className="text-content-muted">{alert.text}</span>
                        </div>
                    ))
                )}
            </div>
        </Card>
    );
}

// ─── Exception Inventory (Epic G-5) ──────────────────────────────────
//
// Surfaces exec.exceptions — control-exception health at a glance.
// No dedicated exceptions list page exists (exceptions live on the
// control detail page), so the card drills through to /controls.

function DrillHealthCard({
    id,
    title,
    headline,
    headlineLabel,
    rows,
    drillHref,
    drillLabel,
}: {
    id: string;
    title: string;
    headline: number;
    headlineLabel: string;
    rows: { label: string; value: number; color: string }[];
    drillHref: string;
    drillLabel: string;
}) {
    return (
        <Card id={id} className="h-full flex flex-col">
            <div className="flex items-baseline justify-between mb-3 gap-tight">
                <Heading level={3}>{title}</Heading>
                <Link
                    href={drillHref}
                    data-drill-link
                    className="text-xs text-content-link hover:underline whitespace-nowrap"
                >
                    {drillLabel}
                </Link>
            </div>
            <div className="mb-default">
                <KPIStat value={headline} label={headlineLabel} size="sm" />
            </div>
            <div className="space-y-tight">
                {rows.map((item) => (
                    <div
                        key={item.label}
                        className="flex items-center justify-between text-xs"
                    >
                        <div className="flex items-center gap-1.5">
                            <span
                                className={`w-2 h-2 rounded-full ${item.color} shrink-0`}
                            />
                            <span className="text-content-muted">{item.label}</span>
                        </div>
                        <span className="text-content-default font-medium tabular-nums">
                            {item.value}
                        </span>
                    </div>
                ))}
            </div>
        </Card>
    );
}

function ExceptionSummaryCard({
    exec,
    href,
}: {
    exec: ExecutiveDashboardPayload;
    href: (path: string) => string;
}) {
    const t = useTranslations('dashboard');
    const { exceptions } = exec;
    return (
        <DrillHealthCard
            id="exception-summary"
            title={t('exceptions.title')}
            headline={exceptions.activeApproved}
            headlineLabel={t('exceptions.active')}
            drillHref={href('/controls')}
            drillLabel={t('exceptions.viewAll')}
            rows={[
                { label: t('exceptions.pending'), value: exceptions.pendingRequest, color: 'bg-bg-warning-emphasis' },
                { label: t('exceptions.expiring7'), value: exceptions.expiringWithin7, color: 'bg-orange-500' },
                { label: t('exceptions.expiring30'), value: exceptions.expiringWithin30, color: 'bg-bg-warning-emphasis' },
                { label: t('exceptions.expired'), value: exceptions.expired, color: 'bg-bg-error-emphasis' },
            ]}
        />
    );
}

// ─── Treatment-Plan Status (Epic G-7) ────────────────────────────────
//
// Surfaces exec.treatmentPlans — risk treatment-plan health. Plans
// live on the risk detail page, so the card drills through to /risks.

function TreatmentPlanCard({
    exec,
    href,
}: {
    exec: ExecutiveDashboardPayload;
    href: (path: string) => string;
}) {
    const t = useTranslations('dashboard');
    const { treatmentPlans } = exec;
    return (
        <DrillHealthCard
            id="treatment-plan-status"
            title={t('treatmentPlans.title')}
            headline={treatmentPlans.activeOnTrack}
            headlineLabel={t('treatmentPlans.onTrack')}
            drillHref={href('/risks')}
            drillLabel={t('treatmentPlans.viewAll')}
            rows={[
                { label: t('treatmentPlans.overdue'), value: treatmentPlans.overdue, color: 'bg-bg-error-emphasis' },
                { label: t('treatmentPlans.due7'), value: treatmentPlans.dueWithin7, color: 'bg-orange-500' },
                { label: t('treatmentPlans.due30'), value: treatmentPlans.dueWithin30, color: 'bg-bg-warning-emphasis' },
                { label: t('treatmentPlans.completed'), value: treatmentPlans.completed, color: 'bg-bg-success-emphasis' },
            ]}
        />
    );
}

// ─── Trend Section ─────────────────────────────────────────────────

// Shared classes for the four Compliance-trend tiles: a subtle card
// border + inset padding so each sparkline is visually segregated.
const trendTileClass = 'border border-border-subtle bg-bg-subtle/20 p-3';

function TrendSection({ trends }: { trends: TrendPayload }) {
    const t = useTranslations('dashboard');
    const coveragePoints = trends.dataPoints.map((d) => ({
        date: new Date(d.date),
        value: d.controlCoveragePercent,
    }));
    const risksOpenPoints = trends.dataPoints.map((d) => ({
        date: new Date(d.date),
        value: d.risksOpen,
    }));
    const evidenceOverduePoints = trends.dataPoints.map((d) => ({
        date: new Date(d.date),
        value: d.evidenceOverdue,
    }));
    const findingsPoints = trends.dataPoints.map((d) => ({
        date: new Date(d.date),
        value: d.findingsOpen,
    }));
    return (
        <Card id="trend-section">
            <div className="flex items-center justify-between mb-4">
                <Heading level={3}>
                    {t('complianceTrends')}
                </Heading>
                <span className="text-xs text-content-subtle">
                    {trends.daysAvailable} day{trends.daysAvailable !== 1 ? 's' : ''} of data
                </span>
            </div>
            {/* B1 — each TrendCard subscribes to its corresponding KPI
                via `<ChartFocusWrapper>`. Pre-B1 only the coverage +
                evidence cards above the trend section had this binding;
                clicking the findings or risks KPI cards only dimmed
                things without lighting any chart up. */}
            {/* Each tile carries a subtle border + inset so the four
                sparklines read as discrete cells rather than blending
                into one continuous strip. `trendTileClass` keeps the
                four wrappers identical. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-default">
                <ChartFocusWrapper kpiKey="coverage" className={trendTileClass}>
                    <TrendCard
                        label={t("coverage")}
                        value={coveragePoints[coveragePoints.length - 1].value}
                        format="%"
                        points={coveragePoints}
                        colorClassName="text-content-success"
                    />
                </ChartFocusWrapper>
                <ChartFocusWrapper kpiKey="risks" className={trendTileClass}>
                    <TrendCard
                        label={t("openRisks")}
                        value={risksOpenPoints[risksOpenPoints.length - 1].value}
                        points={risksOpenPoints}
                        colorClassName="text-content-warning"
                    />
                </ChartFocusWrapper>
                <ChartFocusWrapper kpiKey="evidence" className={trendTileClass}>
                    <TrendCard
                        label={t("overdueEvidenceLabel")}
                        value={evidenceOverduePoints[evidenceOverduePoints.length - 1].value}
                        points={evidenceOverduePoints}
                        colorClassName="text-content-error"
                    />
                </ChartFocusWrapper>
                <ChartFocusWrapper kpiKey="findings" id="findings-trend" className={trendTileClass}>
                    <TrendCard
                        label={t("openFindings")}
                        value={findingsPoints[findingsPoints.length - 1].value}
                        points={findingsPoints}
                        colorClassName="text-content-info"
                    />
                </ChartFocusWrapper>
            </div>
        </Card>
    );
}

function TrendEmptyState() {
    const t = useTranslations('dashboard');
    return (
        <div
            className={cn(cardVariants({ density: 'none' }), 'flex flex-col items-center justify-center gap-y-4 py-12 px-6')}
            id="trend-section"
        >
            <div className="flex size-14 items-center justify-center rounded-lg border border-border-subtle bg-bg-muted">
                <TrendingUp
                    className="size-6 text-content-muted"
                    aria-hidden="true"
                />
            </div>
            <p className="text-center text-base font-medium text-content-emphasis">
                {t('complianceTrends')}
            </p>
            <p className="max-w-sm text-balance text-center text-sm text-content-muted">
                {t('trendsEmpty')}
            </p>
        </div>
    );
}
