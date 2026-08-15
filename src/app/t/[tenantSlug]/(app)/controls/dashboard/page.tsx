'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import type { ControlDashboardDTO, ConsistencyCheckDTO } from '@/lib/dto';
import { AppIcon } from '@/components/icons/AppIcon';
import { Button } from '@/components/ui/button';
import { IconAction } from '@/components/ui/icon-action';
import { ProgressBar } from '@/components/ui/progress-bar';
import {
    StatusBreakdown,
    type StatusBreakdownVariant,
} from '@/components/ui/status-breakdown';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { KPIStat } from '@/components/ui/metric';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { SkeletonDashboard } from '@/components/ui/skeleton';
import { BestValueControls } from '../_components/BestValueControls';
import { ControlHealthSummary } from '../_components/ControlHealthSummary';

const buildStatusLabels = (t: (k: string) => string): Record<string, string> => ({
    NOT_STARTED: t('statusLabels.NOT_STARTED'), IN_PROGRESS: t('statusLabels.IN_PROGRESS'), IMPLEMENTED: t('statusLabels.IMPLEMENTED'), NEEDS_REVIEW: t('statusLabels.NEEDS_REVIEW'),
});
// Map control status onto semantic StatusBreakdown variants so the
// distribution bar re-themes cleanly under Epic 51 light-mode. Drops
// the hand-picked hex palette (#94a3b8/#38bdf8/#34d399/#fbbf24) the
// inline bar used.
const STATUS_VARIANT: Record<string, StatusBreakdownVariant> = {
    NOT_STARTED: 'neutral',
    IN_PROGRESS: 'info',
    IMPLEMENTED: 'success',
    NEEDS_REVIEW: 'warning',
};

export default function ControlsDashboard() {
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();
    const t = useTranslations('controls');
    const STATUS_LABELS = buildStatusLabels(t);

    const [showConsistency, setShowConsistency] = useState(false);

    // Epic 69 — SWR-backed shell. Was a hand-rolled 3× fetch retry +
    // setState-in-effect; SWR owns caching/revalidation and the inline
    // retry below replaces the retry loop.
    const { data, isLoading, mutate } = useTenantSWR<ControlDashboardDTO>('/controls/dashboard');
    // Consistency check is on-demand — a null SWR key keeps it unfetched
    // until the admin clicks the button (which flips `showConsistency`).
    const { data: consistency } = useTenantSWR<ConsistencyCheckDTO>(
        showConsistency ? '/controls/consistency-check' : null,
    );

    if (isLoading && !data) return <SkeletonDashboard />;
    if (!data) return (
        <DashboardLayout header={{ title: t('dashboard.title'), titleId: 'dashboard-heading' }}>
            <div className="p-12 text-center space-y-default">
                <p className="text-content-error">{t('dashboard.loadFailed')}</p>
                <Button variant="secondary" onClick={() => mutate()} id="dashboard-retry-btn">
                    {t('dashboard.retry')}
                </Button>
            </div>
        </DashboardLayout>
    );

    return (
        <DashboardLayout
            header={{
                back: { smart: true },
                title: t('dashboard.title'),
                titleId: 'dashboard-heading',
                description: t('dashboard.countInRegister', { count: data.totalControls }),
                actions: (
                    <>
                        {permissions.canAdmin && (
                            <IconAction variant="secondary" onClick={() => setShowConsistency(true)} id="consistency-check-btn" icon={<AppIcon name="search" size={16} />} label={t('dashboard.consistencyCheck')} />
                        )}
                    </>
                ),
            }}
        >
            {/* Stat Cards Row — Polish PR-2: KPIStat primitive. */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-default" id="dashboard-stats">
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat
                        id="implementation-progress"
                        value={`${data.implementationProgress}%`}
                        label={t('dashboard.implementationProgress')}
                        tone="success"
                        description={t('dashboard.applicableControls', { implemented: data.implementedCount, applicable: data.applicableCount })}
                    />
                    <ProgressBar
                        value={data.implementationProgress}
                        variant={data.implementationProgress >= 80 ? 'success' : data.implementationProgress >= 50 ? 'warning' : 'error'}
                        size="sm"
                        aria-label={t('dashboard.progressAria')}
                        className="mt-2"
                    />
                </div>
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat
                        id="overdue-tasks"
                        value={data.overdueTasks}
                        label={t('dashboard.overdueTasks')}
                        tone={data.overdueTasks > 0 ? 'critical' : 'default'}
                        description={t('dashboard.tasksPastDue')}
                    />
                </div>
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat
                        id="due-soon"
                        value={data.controlsDueSoon}
                        label={t('dashboard.controlsDueSoon')}
                        tone={data.controlsDueSoon > 0 ? 'attention' : 'default'}
                        description={t('dashboard.withinNext30')}
                    />
                </div>
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat
                        value={data.applicabilityDistribution.applicable}
                        label={t('dashboard.applicability')}
                        description={t('dashboard.excludedNA', { count: data.applicabilityDistribution.notApplicable })}
                    />
                </div>
                {/* Relocated from the readiness report, and RECOMPUTED rather
                    than moved: there it was framework-scoped, driven by that
                    page's framework selector. This page has no framework
                    concept, so the honest figure is tenant-wide. It is also a
                    COUNT, not the report's uncapped list — a tenant with 400
                    such controls rendered 400 rows there. */}
                <div className={cardVariants({ density: 'compact' })}>
                    <KPIStat
                        id="controls-missing-evidence"
                        value={data.controlsMissingEvidence}
                        label={t('dashboard.missingEvidence')}
                        tone={data.controlsMissingEvidence > 0 ? 'attention' : 'default'}
                        description={t('dashboard.noQualifyingEvidence')}
                    />
                </div>
            </div>

            {/* Control health — composite verdict roll-up (client island). */}
            <ControlHealthSummary />

            {/* Status Distribution */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                <Card>
                    <Heading level={3} className="mb-4">{t('dashboard.statusDistribution')}</Heading>
                    {/* Epic 59 — StatusBreakdown primitive. Bar widths are
                        proportional to the row's share of `total`
                        (maxStatus in the local scope was the previous
                        denominator; totalling the counts gives the same
                        share for "max == sum" — i.e. a one-hot winner
                        fills the track, everyone else scales down). */}
                    <div id="status-distribution">
                        <StatusBreakdown
                            ariaLabel={t('dashboard.statusDistAria')}
                            showDot={false}
                            size="sm"
                            items={Object.entries(
                                data.statusDistribution || {},
                            ).map(([status, count]) => ({
                                id: status,
                                label: STATUS_LABELS[status] || status,
                                value: Number(count),
                                variant:
                                    STATUS_VARIANT[status] ?? 'neutral',
                            }))}
                        />
                    </div>
                </Card>
                <Card>
                    <Heading level={3} className="mb-4">{t('dashboard.topOwners')}</Heading>
                    {data.topOwners?.length > 0 ? (
                        <div className="space-y-tight" id="top-owners">
                            {data.topOwners.map((o) => (
                                <div key={o.id} className="flex justify-between items-center text-sm">
                                    <span className="text-content-default">{o.name}</span>
                                    <StatusBadge variant="neutral">{t('dashboard.openCount', { count: o.openTasks })}</StatusBadge>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <InlineEmptyState title={t('dashboard.ownersEmptyTitle')} />
                    )}
                </Card>
            </div>

            {/* Consistency Check */}
            {showConsistency && consistency && (() => {
                // Each count deep-links to a client-side filtered controls
                // view (`/controls?ids=…`) listing exactly the offending
                // controls. A zero count renders as a plain (non-linked)
                // number — nothing to navigate to.
                const missingIds = consistency.issues.missingCode.map((x) => x.id);
                const duplicateIds = consistency.issues.duplicateCodes.flatMap((d) => d.controlIds);
                const overdueIds = Array.from(
                    new Set(consistency.issues.overdueTasks.map((tk) => tk.controlId)),
                );
                const renderCount = (
                    count: number,
                    ids: string[],
                    toneClass: string,
                    label: string,
                    id: string,
                ) => (
                    <div className="text-center">
                        {count > 0 && ids.length > 0 ? (
                            <Link
                                href={tenantHref(`/controls?ids=${ids.join(',')}`)}
                                id={id}
                                className={`text-xl font-bold ${toneClass} hover:underline focus-visible:outline-none focus-visible:underline`}
                            >
                                {count}
                            </Link>
                        ) : (
                            <p className={`text-xl font-bold ${count > 0 ? toneClass : 'text-content-success'}`}>
                                {count}
                            </p>
                        )}
                        <p className="text-xs text-content-subtle">{label}</p>
                    </div>
                );
                return (
                    <Card id="consistency-results">
                        <Heading level={3} className="mb-3"><AppIcon name="search" size={16} className="inline-block mr-1" /> {t('dashboard.consistencyResults')}</Heading>
                        <div className="grid grid-cols-3 gap-default mb-4">
                            {renderCount(
                                consistency.summary.missingCodeCount,
                                missingIds,
                                'text-content-warning',
                                t('dashboard.missingCode'),
                                'consistency-missing-code-link',
                            )}
                            {renderCount(
                                consistency.summary.duplicateCodeCount,
                                duplicateIds,
                                'text-content-error',
                                t('dashboard.duplicateCodes'),
                                'consistency-duplicate-codes-link',
                            )}
                            {renderCount(
                                consistency.summary.overdueTaskCount,
                                overdueIds,
                                'text-content-error',
                                t('dashboard.overdueTasks'),
                                'consistency-overdue-tasks-link',
                            )}
                        </div>
                        {consistency.summary.missingCodeCount === 0 && consistency.summary.duplicateCodeCount === 0 && consistency.summary.overdueTaskCount === 0 && (
                            <p className="text-sm text-content-success text-center"><AppIcon name="success" size={16} className="inline-block mr-1" /> {t('dashboard.allPassed')}</p>
                        )}
                    </Card>
                );
            })()}

            {/* R2-P3 — the Best-value controls leaderboard (RQ3-8, mitigation
                ROI) was a well-built component mounted nowhere. It belongs on
                the controls dashboard beside the KPIs. */}
            <Card>
                <Heading level={3} className="mb-3">{t('dashboard.bestValueTitle')}</Heading>
                <BestValueControls limit={10} />
            </Card>
        </DashboardLayout>
    );
}
