'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { buttonVariants } from '@/components/ui/button-variants';
import { Button } from '@/components/ui/button';
import { StatusBreakdown, type StatusBreakdownItem } from '@/components/ui/status-breakdown';
import { type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { KPIStat, type MetricTone } from '@/components/ui/metric';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { SkeletonDashboard } from '@/components/ui/skeleton';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { cardVariants } from '@/components/ui/card';
import { Tooltip } from '@/components/ui/tooltip';
import { AppIcon } from '@/components/icons/AppIcon';
import { cn } from '@inflect/ui/lib/cn';


function MetricCard({ label, value, tone, href }: { label: string; value: number | string; tone?: MetricTone; href?: string }) {
    const inner = (
        <div className={cn(cardVariants({ density: 'compact' }), href && 'hover:bg-bg-muted/50 cursor-pointer transition-colors')}>
            <KPIStat value={value} label={label} tone={tone} />
        </div>
    );
    return href ? <Link href={href}>{inner}</Link> : inner;
}

function BreakdownBar({
    data,
    colors,
    labelFor,
}: {
    data: Record<string, number>;
    colors: Record<string, string>;
    /**
     * Resolve an enum key to its display label. Was `label: key`, which put
     * the raw enum on screen — "CRITICAL", "OFFBOARDED" — while
     * `vendors.criticalityLabel.*` and `vendors.statusOption.*` sat in the
     * message catalogue already carrying the localised forms.
     */
    labelFor: (key: string) => string;
}) {
    // Epic 59 — hand-rolled per-row distribution bar replaced with the
    // shared `<StatusBreakdown>`. Preserves the legacy category-
    // specific colour palette via `colorClass` since these are
    // historically-branded vendor-risk / vendor-status colours, not
    // semantic variants.
    const items: StatusBreakdownItem[] = Object.entries(data).map(
        ([key, value]) => ({
            id: key,
            label: labelFor(key),
            value,
            colorClass: colors[key] ?? 'bg-bg-info',
        }),
    );
    return <StatusBreakdown items={items} size="sm" showDot={false} />;
}

const CRIT_COLORS: Record<string, string> = {
    LOW: 'bg-bg-success', MEDIUM: 'bg-bg-warning', HIGH: 'bg-bg-warning-emphasis', CRITICAL: 'bg-bg-error',
};
const STATUS_COLORS: Record<string, string> = {
    ACTIVE: 'bg-bg-success', ONBOARDING: 'bg-bg-info', OFFBOARDING: 'bg-bg-warning', OFFBOARDED: 'bg-border-emphasis',
};

// getVendorMetrics (vendor.ts) — explicit object literal; the by* maps are
// genuinely dynamic enum-keyed counters.
interface VendorMetrics {
    totalVendors: number;
    byCriticality: Record<string, number>;
    byStatus: Record<string, number>;
    byRiskRating: Record<string, number>;
    overdueReview: number;
    upcomingReview: number;
    overdueRenewal: number;
    upcomingRenewal: number;
    highRiskNoAssessment: number;
    expiringDocuments: number;
    // Continuous-monitoring signals.
    expiredAttestations: number;
    recentBreachActivity: number;
    overdueReassessment: number;
}

export default function VendorDashboardPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const tx = useTranslations('vendors');

    const [metrics, setMetrics] = useState<VendorMetrics | null>(null);
    const [loading, setLoading] = useState(true);
    // #4799 — a failed read had no retry and no reason: a 403 and a 500 both
    // read "Failed to load metrics", outside the dashboard's own frame.
    const [loadError, setLoadError] = useState<'forbidden' | 'failed' | null>(null);

    const fetchMetrics = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const res = await fetch(apiUrl('/vendors/metrics'));
            if (res.ok) setMetrics(await res.json());
            else setLoadError(res.status === 403 ? 'forbidden' : 'failed');
        } catch {
            setLoadError('failed');
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    useEffect(() => { void fetchMetrics(); }, [fetchMetrics]);

    if (loading && !metrics) return <SkeletonDashboard />;
    if (!metrics) return (
        <DashboardLayout header={{ back: { smart: true }, title: tx('dashboard.title') }}>
            <div className="p-12 text-center space-y-default" id="vendor-dashboard-error">
                <p className="text-content-error">
                    {loadError === 'forbidden' ? tx('dashboard.loadForbidden') : tx('dashboard.loadFailed')}
                </p>
                {loadError !== 'forbidden' && (
                    <Button variant="secondary" onClick={() => void fetchMetrics()} id="vendor-dashboard-retry">
                        {tx('dashboard.retry')}
                    </Button>
                )}
            </div>
        </DashboardLayout>
    );

    return (
        <DashboardLayout
            header={{
                back: { smart: true },
                title: tx('dashboard.title'),
                description: tx('dashboard.totalVendors', { count: metrics.totalVendors }),
                actions: (
                    <Tooltip content={tx('dashboard.registerTooltip')}>
                        <Link href={tenantHref('/vendors')} aria-label={tx('dashboard.registerTooltip')} className={buttonVariants({ variant: 'secondary', size: 'icon' })}>
                            <AppIcon name="overview" size={16} />
                        </Link>
                    </Tooltip>
                ),
            }}
        >

            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-default">
                <MetricCard label={tx('dashboard.kpiTotal')} value={metrics.totalVendors} />
                <MetricCard label={tx('dashboard.kpiOverdueReviews')} value={metrics.overdueReview} tone={metrics.overdueReview > 0 ? 'critical' : 'success'}
                    href={tenantHref('/vendors?reviewDue=overdue')} />
                <MetricCard label={tx('dashboard.kpiUpcomingReviews')} value={metrics.upcomingReview} tone="attention"
                    href={tenantHref('/vendors?reviewDue=next30d')} />
                <MetricCard label={tx('dashboard.kpiOverdueRenewals')} value={metrics.overdueRenewal} tone={metrics.overdueRenewal > 0 ? 'critical' : 'success'} />
                <MetricCard label={tx('dashboard.kpiUpcomingRenewals')} value={metrics.upcomingRenewal} tone="attention" />
                <MetricCard label={tx('dashboard.kpiHighRisk')} value={metrics.highRiskNoAssessment} tone={metrics.highRiskNoAssessment > 0 ? 'critical' : 'success'} />
            </div>

            {/* Continuous assurance — posture signals from the monitoring sweep */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <Heading level={3}>{tx('dashboard.continuousAssurance')}</Heading>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-default">
                    <MetricCard label={tx('dashboard.kpiExpiredAttestations')} value={metrics.expiredAttestations}
                        tone={metrics.expiredAttestations > 0 ? 'critical' : 'success'} />
                    <MetricCard label={tx('dashboard.kpiRecentBreach')} value={metrics.recentBreachActivity}
                        tone={metrics.recentBreachActivity > 0 ? 'critical' : 'success'} />
                    {/* No href. This drilled to ?reviewDue=overdue — the
                        destination of the overdue-REVIEW card above, which is
                        a different metric with a different definition
                        (nextReviewAt, the manual review-cadence date, versus
                        lastAssessmentReviewedAt and the yearly reassessment
                        cadence). Two cards showing different numbers and
                        landing on the same filtered list is worse than one
                        that does not link: the operator concludes the list is
                        wrong. There is no reassessment filter to point at
                        yet, so the card states its number and stops. */}
                    <MetricCard label={tx('dashboard.kpiOverdueReassessment')} value={metrics.overdueReassessment}
                        tone={metrics.overdueReassessment > 0 ? 'critical' : 'success'} />
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-section">
                {/* Business criticality — manually assigned axis */}
                <div className={cn(cardVariants(), 'flex flex-col space-y-compact')}>
                    <div>
                        <Heading level={3}>{tx('dashboard.byCriticality')}</Heading>
                        <p className="text-xs text-content-muted">{tx('dashboard.byCriticalityCaption')}</p>
                    </div>
                    <div className="flex flex-1 flex-col justify-center">
                        <BreakdownBar data={metrics.byCriticality} colors={CRIT_COLORS} labelFor={(k) => tx(`criticalityLabel.${k}`)} />
                    </div>
                </div>

                {/* By Status */}
                <div className={cn(cardVariants(), 'flex flex-col space-y-compact')}>
                    <Heading level={3}>{tx('dashboard.byStatus')}</Heading>
                    <div className="flex flex-1 flex-col justify-center">
                        <BreakdownBar data={metrics.byStatus} colors={STATUS_COLORS} labelFor={(k) => tx(`statusOption.${k}`)} />
                    </div>
                </div>

                {/* Assessment risk — derived from the latest completed assessment */}
                <div className={cn(cardVariants(), 'flex flex-col space-y-compact')}>
                    <div>
                        <Heading level={3}>{tx('dashboard.byRiskRating')}</Heading>
                        <p className="text-xs text-content-muted">{tx('dashboard.byRiskRatingCaption')}</p>
                    </div>
                    <div className="flex flex-1 flex-col justify-center">
                        {Object.keys(metrics.byRiskRating).length > 0
                            ? <BreakdownBar data={metrics.byRiskRating} colors={CRIT_COLORS} labelFor={(k) => tx(`criticalityLabel.${k}`)} />
                            : <InlineEmptyState title={tx('dashboard.riskRatingEmpty')} />}
                    </div>
                </div>
            </div>

            {/* Expiring Documents */}
            {metrics.expiringDocuments > 0 && (
                <div className={cn(cardVariants(), 'border border-border-warning')} id="vendor-expiring-docs">
                    <div className="flex items-center gap-tight">
                        <AppIcon name="warning" size={16} className="text-content-warning" />
                        <span className="font-semibold">{tx('dashboard.expiringDocs', { count: metrics.expiringDocuments })}</span>
                    </div>
                    <p className="text-sm text-content-muted mt-1">{tx('dashboard.expiringDocsHint')}</p>
                </div>
            )}
        </DashboardLayout>
    );
}
