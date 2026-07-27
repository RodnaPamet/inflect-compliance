'use client';
/* PR-Q — migrated to useTenantSWR (Epic 69 shape); the fetch-on-mount +
 * setState pattern (and its react-hooks/set-state-in-effect disables) is gone. */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { TestsSubNav } from '../_components/TestsSubNav';
import { ProgressBar, type ProgressBarVariant } from '@/components/ui/progress-bar';
import { ProgressCircle } from '@/components/ui/progress-circle';
import {
    TestDashboardG2Section,
    type DashboardUpcomingItem,
} from '@/components/TestDashboardG2Section';
import { StatusBadge } from '@/components/ui/status-badge';
import { KPIStat, type MetricTone } from '@/components/ui/metric';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { SkeletonDashboard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Heading } from '@/components/ui/typography';
import { textLinkVariants } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface DashboardMetrics {
    periodDays: number;
    totalPlans: number;
    totalRuns: number;
    completedRuns: number;
    passRuns: number;
    failRuns: number;
    inconclusiveRuns: number;
    completionRate: number;
    passRate: number;
    failRate: number;
    evidenceRate: number;
    overduePlans: number;
    repeatedFailures: Array<{ controlId: string; controlName: string; controlCode: string | null; failCount: number }>;
    runsWithEvidence: number;
    // Epic G-2 — additive fields the dashboard endpoint merges in
    // (route.ts Promise.alls the legacy + G-2 usecases). Optional
    // because old API consumers may still hit a non-merged response
    // shape during a rolling deploy.
    automation?: {
        plansManual: number;
        plansScript: number;
        plansIntegration: number;
        plansScheduledActive: number;
        overdueScheduled: number;
    };
    upcoming?: DashboardUpcomingItem[];
    trend?: {
        days: string[];
        pass: number[];
        fail: number[];
        inconclusive: number[];
    };
}

interface FrameworkReadiness {
    frameworkKey: string;
    frameworkName: string;
    totalMappedControls: number;
    withTestPlan: number;
    testPlanCoverage: number;
    withRecentRun: number;
    testRunCoverage: number;
    passRate: number;
    recentRuns: number;
    recentPasses: number;
}

// Legacy color prop → Epic 59 ProgressBar variant. Kept as a local
// helper so the dozens of call sites below stay short and readable.
function toProgressVariant(color: string): ProgressBarVariant {
    if (color === 'green') return 'success';
    if (color === 'red') return 'error';
    if (color === 'amber') return 'warning';
    return 'brand';
}

export default function TestDashboardPage() {
    const t = useTranslations('controlTests');
    const tenantHref = useTenantHref();

    const [period, setPeriod] = useState(30);
    const { data: metrics, error: metricsError, mutate: mutateMetrics } = useTenantSWR<DashboardMetrics>(CACHE_KEYS.tests.dashboard(period));
    const { data: readinessData } = useTenantSWR<FrameworkReadiness[]>(CACHE_KEYS.tests.readiness());
    const readiness = readinessData ?? [];

    // Header is identical across data / loading / error so the sub-nav and
    // period switch never disappear underneath the user.
    const header = {
        breadcrumbs: [
            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
            { label: t('crumb.tests'), href: tenantHref('/tests') },
            { label: t('dashboard.crumb') },
        ],
        title: t('dashboard.title'),
        titleId: 'dashboard-title',
        description: t('dashboard.description'),
        actions: (
            <div className="flex gap-1 bg-bg-default/50 rounded-lg p-1">
                {[30, 90].map(d => (
                    <button
                        key={d}
                        onClick={() => setPeriod(d)}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors duration-150 ease-out ${period === d ? 'bg-[var(--brand-default)] text-content-emphasis' : 'text-content-muted hover:text-content-emphasis'}`}
                        id={`period-${d}-btn`}
                    >
                        {t('dashboard.periodDays', { days: d })}
                    </button>
                ))}
            </div>
        ),
    };

    // A failed metrics fetch must not masquerade as a perpetual skeleton —
    // surface it with a retry, keeping the sub-nav + period switch mounted.
    if (metricsError) {
        return (
            <DashboardLayout header={header}>
                <TestsSubNav active="dashboard" />
                <ErrorState
                    title={t('dashboard.loadErrorTitle')}
                    description={t('dashboard.loadErrorBody')}
                    onRetry={() => { mutateMetrics(); }}
                    retryLabel={t('dashboard.retry')}
                    data-testid="dashboard-load-error"
                />
            </DashboardLayout>
        );
    }
    if (!metrics) {
        return (
            <DashboardLayout header={header}>
                <TestsSubNav active="dashboard" />
                <SkeletonDashboard />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout header={header}>
            {/* R3-P3 — shared sub-nav spine across the three test surfaces. */}
            <TestsSubNav active="dashboard" />

            {/* KPI Cards — R3-P3: rates only. The plan-total + overdue COUNTS
                that used to sit here restated /tests and /tests/due; the
                dashboard's job is rates & trends, the lists own the counts. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                <MetricCard label={t('dashboard.kpi.completionRate')} value={`${metrics.completionRate}%`} sub={t('dashboard.kpi.completionSub', { completed: metrics.completedRuns, total: metrics.totalRuns })} color={metrics.completionRate >= 80 ? 'green' : metrics.completionRate >= 50 ? 'amber' : 'red'} />
                <MetricCard label={t('dashboard.kpi.passRate')} value={`${metrics.passRate}%`} sub={t('dashboard.kpi.passSub', { count: metrics.passRuns })} color={metrics.passRate >= 80 ? 'green' : metrics.passRate >= 50 ? 'amber' : 'red'} />
                <MetricCard label={t('dashboard.kpi.failRate')} value={`${metrics.failRate}%`} sub={t('dashboard.kpi.failSub', { count: metrics.failRuns })} color={metrics.failRate <= 10 ? 'green' : metrics.failRate <= 30 ? 'amber' : 'red'} />
                <MetricCard label={t('dashboard.kpi.evidenceRate')} value={`${metrics.evidenceRate}%`} sub={t('dashboard.kpi.evidenceSub', { count: metrics.runsWithEvidence })} color={metrics.evidenceRate >= 80 ? 'green' : metrics.evidenceRate >= 50 ? 'amber' : 'red'} />
            </div>

            {/* PR-Q — the ONE authoritative overdue count (reconciled across both
                due clocks in getTestDashboardMetrics). R4-P3 #8 — link to the
                /tests list PRE-FILTERED to overdue, not /tests/due (which also
                lists everything due within 7 days). Clicking a card that says
                "3 overdue" now lands on exactly those 3 rows, not a 12-row queue.
                The automation section below shows `overdueScheduled` — the SUBSET
                of these that are on an automation cadence. */}
            <Link
                href={tenantHref('/tests?due=overdue')}
                className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between hover:border-border-emphasis transition')}
                id="dashboard-overdue-link"
            >
                <KPIStat
                    value={metrics.overduePlans}
                    label={t('dashboard.overdueAuthoritative')}
                    tone={metrics.overduePlans > 0 ? 'critical' : 'success'}
                />
                <span className={cn(textLinkVariants(), 'text-xs')}>{t('dashboard.viewQueue')}</span>
            </Link>

            {/* Result Distribution */}
            <div className="grid md:grid-cols-2 gap-section">
                <div className={cardVariants()}>
                    <Heading level={2} className="mb-4">{t('dashboard.resultDist', { period })}</Heading>
                    {metrics.completedRuns === 0 ? (
                        <p className="text-content-subtle text-sm">{t('dashboard.noCompleted')}</p>
                    ) : (
                        <div className="flex gap-section items-center">
                            {/* Headline gauge — overall pass rate at a glance */}
                            <ProgressCircle
                                progress={metrics.passRate / 100}
                                label={`${metrics.passRate}%`}
                                variant={metrics.passRate >= 80 ? 'success' : metrics.passRate >= 50 ? 'warning' : 'error'}
                                size="sm"
                                aria-label={t('dashboard.overallPassRate')}
                            />
                            <div className="flex-1 space-y-compact">
                            <div>
                                <div className="flex justify-between text-sm mb-1">
                                    <span className="text-content-success">{t('dashboard.pass')}</span>
                                    <span className="text-content-muted">{metrics.passRuns} ({metrics.passRate}%)</span>
                                </div>
                                <ProgressBar value={metrics.passRate} variant="success" aria-label={t('dashboard.passRateAria')} />
                            </div>
                            <div>
                                <div className="flex justify-between text-sm mb-1">
                                    <span className="text-content-error">{t('dashboard.fail')}</span>
                                    <span className="text-content-muted">{metrics.failRuns} ({metrics.failRate}%)</span>
                                </div>
                                <ProgressBar value={metrics.failRate} variant="error" aria-label={t('dashboard.failRateAria')} />
                            </div>
                            <div>
                                <div className="flex justify-between text-sm mb-1">
                                    <span className="text-content-warning">{t('dashboard.inconclusive')}</span>
                                    <span className="text-content-muted">{metrics.inconclusiveRuns}</span>
                                </div>
                                <ProgressBar
                                    value={metrics.completedRuns > 0 ? (metrics.inconclusiveRuns / metrics.completedRuns) * 100 : 0}
                                    variant="warning"
                                    aria-label={t('dashboard.inconclusiveAria')}
                                />
                            </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className={cardVariants()}>
                    <Heading level={2} className="mb-4">{t('dashboard.repeatedFailures')}</Heading>
                    {metrics.repeatedFailures.length === 0 ? (
                        <p className="text-content-subtle text-sm">{t('dashboard.noRepeatedFailures')}</p>
                    ) : (
                        <div className="space-y-tight">
                            {metrics.repeatedFailures.map(f => (
                                <Link
                                    key={f.controlId}
                                    href={tenantHref(`/controls/${f.controlId}`)}
                                    className="flex justify-between items-center p-2 rounded hover:bg-bg-muted/50 transition"
                                >
                                    <div>
                                        <span className="text-content-emphasis text-sm font-medium">{f.controlCode || f.controlName}</span>
                                        {f.controlCode && <span className="text-content-muted text-xs ml-2">{f.controlName}</span>}
                                    </div>
                                    <StatusBadge variant="error" size="sm">{t('dashboard.nFailures', { count: f.failCount })}</StatusBadge>
                                </Link>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Epic G-2 — automation: pass/fail donut, overdue scheduled list, trend sparkline */}
            {metrics.automation && metrics.upcoming && metrics.trend && (
                <TestDashboardG2Section
                    period={period}
                    passRuns={metrics.passRuns}
                    failRuns={metrics.failRuns}
                    inconclusiveRuns={metrics.inconclusiveRuns}
                    automation={metrics.automation}
                    upcoming={metrics.upcoming}
                    trend={metrics.trend}
                />
            )}

            {/* Framework Test Readiness */}
            {readiness.length > 0 && (
                <div className={cardVariants()}>
                    <Heading level={2} className="mb-4" id="framework-readiness-title">{t('dashboard.fwCoverage')}</Heading>
                    <p className="text-sm text-content-muted mb-2">
                        {t('dashboard.fwCoverageDesc')}
                    </p>
                    {/* R3-P3 — disambiguate the three "coverage/readiness" surfaces
                        so "test coverage" isn't confused with the risk/asset
                        Coverage map or an audit-cycle readiness score. */}
                    <p className="text-xs text-content-muted mb-4">
                        {t('dashboard.fwCoverageVsCoverage')}{' '}
                        <Link href={tenantHref('/coverage')} className={textLinkVariants({ tone: 'underline' })}>{t('dashboard.coverageMapLink')}</Link>
                    </p>
                    <div className="space-y-section animate-fadeIn">
                        {readiness.map(fw => (
                            <div key={fw.frameworkKey} className="border border-border-default/30 rounded-lg p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <Heading level={3}>{fw.frameworkName}</Heading>
                                    <span className="text-xs text-content-muted">{t('dashboard.mappedControls', { count: fw.totalMappedControls })}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-default">
                                    <div>
                                        <div className="flex justify-between text-xs mb-1">
                                            <span className="text-content-muted">{t('dashboard.testPlanCoverage')}</span>
                                            <span className="text-content-emphasis">{fw.testPlanCoverage}%</span>
                                        </div>
                                        <ProgressBar
                                            value={fw.testPlanCoverage}
                                            variant={toProgressVariant(fw.testPlanCoverage >= 80 ? 'green' : fw.testPlanCoverage >= 50 ? 'amber' : 'red')}
                                            aria-label={t('dashboard.fwPlanCoverageAria', { name: fw.frameworkName })}
                                        />
                                        <p className="text-xs text-content-subtle mt-1">{t('dashboard.withPlans', { count: fw.withTestPlan, total: fw.totalMappedControls })}</p>
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-xs mb-1">
                                            <span className="text-content-muted">{t('dashboard.recentRunCoverage')}</span>
                                            <span className="text-content-emphasis">{fw.testRunCoverage}%</span>
                                        </div>
                                        <ProgressBar
                                            value={fw.testRunCoverage}
                                            variant={toProgressVariant(fw.testRunCoverage >= 80 ? 'green' : fw.testRunCoverage >= 50 ? 'amber' : 'red')}
                                            aria-label={t('dashboard.fwRunCoverageAria', { name: fw.frameworkName })}
                                        />
                                        <p className="text-xs text-content-subtle mt-1">{t('dashboard.tested', { count: fw.withRecentRun, total: fw.totalMappedControls })}</p>
                                    </div>
                                    <div>
                                        <div className="flex justify-between text-xs mb-1">
                                            <span className="text-content-muted">{t('dashboard.kpi.passRate')}</span>
                                            <span className="text-content-emphasis">{fw.passRate}%</span>
                                        </div>
                                        <ProgressBar
                                            value={fw.passRate}
                                            variant={toProgressVariant(fw.passRate >= 80 ? 'green' : fw.passRate >= 50 ? 'amber' : 'red')}
                                            aria-label={t('dashboard.fwPassRateAria', { name: fw.frameworkName })}
                                        />
                                        <p className="text-xs text-content-subtle mt-1">{t('dashboard.passed', { count: fw.recentPasses, total: fw.recentRuns })}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
    const toneMap: Record<string, MetricTone> = {
        green: 'success',
        red: 'critical',
        amber: 'attention',
        brand: 'default',
    };
    return (
        <div className={cardVariants({ density: 'compact' })}>
            <KPIStat
                value={value}
                label={label}
                tone={toneMap[color] ?? 'default'}
                description={sub}
            />
        </div>
    );
}
