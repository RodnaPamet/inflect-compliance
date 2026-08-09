'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { buttonVariants } from '@/components/ui/button-variants';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { InfoTooltip } from '@/components/ui/tooltip';
import { cardVariants } from '@/components/ui/card';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { LineChart } from '@/components/ui/charts/line-chart';
import { chartReady, type TimeSeriesPoint } from '@/components/ui/charts/types';
import { cn } from '@/lib/cn';
import { readinessVariant } from '@/lib/readiness/bands';
import { ReadinessScoreRing, ReadinessLegend } from '../../ReadinessScoreRing';
import type { ReadinessResult } from '@/app-layer/usecases/audit-readiness';

interface ReadinessSnapshot { id: string; score: number; gapCount: number; computedAt: string }

const GAP_ICON: Record<string, AppIconName> = {
    UNMAPPED_REQUIREMENT: 'overview', MISSING_EVIDENCE: 'evidence', OVERDUE_TASK: 'clock',
    OPEN_ISSUE: 'warning', MISSING_POLICY: 'fileWarning',
};
const SEV_BADGE: Record<string, StatusBadgeVariant> = {
    HIGH: 'error', MEDIUM: 'warning', LOW: 'neutral',
};

export default function CycleReadinessPage() {
    const tx = useTranslations('audits');
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const cycleId = params.cycleId as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const [result, setResult] = useState<ReadinessResult | null>(null);
    const [cycle, setCycle] = useState<{ name: string } | null>(null);
    const [history, setHistory] = useState<ReadinessSnapshot[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        Promise.all([
            fetch(apiUrl(`/audits/cycles/${cycleId}/readiness`)).then(r => r.ok ? r.json() : null),
            fetch(apiUrl(`/audits/cycles/${cycleId}`)).then(r => r.ok ? r.json() : null),
            // feat/readiness-trend — the ReadinessSnapshot time-series.
            fetch(apiUrl(`/audits/cycles/${cycleId}/readiness?action=history`)).then(r => r.ok ? r.json() : null),
        ]).then(([r, c, h]) => { setResult(r); setCycle(c); setHistory(h?.snapshots ?? []); }).finally(() => setLoading(false));
    }, [apiUrl, cycleId]);

    const breadcrumbs = [
        { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
        { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
        { label: tx('crumb.cycles'), href: `/t/${tenantSlug}/audits/cycles` },
        { label: cycle?.name || tx('readiness.cycleFallback'), href: `/t/${tenantSlug}/audits/cycles/${cycleId}` },
        { label: tx('readiness.readinessReportCrumb') },
    ];

    if (loading) {
        return (
            <EntityDetailLayout
                title=""
                back={{ smart: true }}
                breadcrumbs={breadcrumbs}
                loading
            >
                {null}
            </EntityDetailLayout>
        );
    }
    if (!result) {
        return (
            <EntityDetailLayout
                title=""
                back={{ smart: true }}
                breadcrumbs={breadcrumbs}
                error={tx('readiness.couldNotCompute')}
            >
                {null}
            </EntityDetailLayout>
        );
    }

    const bd = result.breakdown;

    // feat/readiness-trend first-paint fix — the default readiness fetch
    // computes (and, on real movement, persists) the current score, but the
    // `?action=history` fetch runs in the SAME Promise.all and can read the
    // series before that write lands. Merge the freshly-computed score in as
    // the trailing point so the trend always reflects the current number on
    // first paint (belt-and-suspenders alongside the snapshot dedup). If the
    // history already ends on this score, don't duplicate it.
    const trendPoints: TimeSeriesPoint[] = history.map((s) => ({ date: new Date(s.computedAt), value: s.score }));
    if (trendPoints.length === 0 || trendPoints[trendPoints.length - 1].value !== result.score) {
        trendPoints.push({ date: new Date(), value: result.score });
    }

    return (
        <EntityDetailLayout
            title={tx('readiness.titleSuffix', { name: cycle?.name || tx('readiness.cycleFallback') })}
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}
        >
            {/* Score + Breakdown */}
            <div className={cardVariants()}>
                <div className="flex items-start gap-page">
                    <div className="flex-shrink-0 text-center">
                        <ReadinessScoreRing
                            score={result.score}
                            size={120}
                            noScoreLabel={tx('cycles.noScore')}
                            ariaLabel={tx('cycles.scoreAria', { score: result.score })}
                        />
                        <p className="text-xs text-content-muted mt-2 inline-flex items-center gap-tight">
                            {/* readiness-reconcile — this score is CONTROL COVERAGE
                                (mapping/implementation/evidence), distinct from the
                                NIS2 self-assessment MATURITY score. Label it so the
                                two "NIS2 readiness" numbers can't be confused. */}
                            {result.frameworkKey === 'NIS2'
                                ? tx('readiness.nis2ControlCoverage')
                                : tx('readiness.frameworkReadiness', { framework: result.frameworkKey })}
                            <InfoTooltip
                                aria-label={tx('readinessLegend.aria')}
                                content={result.frameworkKey === 'NIS2' ? tx('readiness.nis2CoverageVsMaturity') : (
                                    <ReadinessLegend labels={{
                                        title: tx('readinessLegend.title'),
                                        green: tx('readinessLegend.green'),
                                        amber: tx('readinessLegend.amber'),
                                        red: tx('readinessLegend.red'),
                                    }} />
                                )}
                            />
                        </p>
                    </div>
                    <div className="flex-1 space-y-compact" id="readiness-breakdown">
                        {bd.coverage && (
                            <BreakdownBar label={tx('readiness.reqCoverage')} score={bd.coverage.score}
                                detail={tx('readiness.reqMappedDetail', { mapped: bd.coverage.mapped, total: bd.coverage.total })} weight={bd.coverage.weight} />
                        )}
                        {bd.implementation && (
                            <BreakdownBar label={tx('readiness.controlsImplemented')} score={bd.implementation.score}
                                detail={tx('readiness.controlsImplDetail', { implemented: bd.implementation.implemented, total: bd.implementation.total })} weight={bd.implementation.weight} />
                        )}
                        {bd.evidence && (
                            <BreakdownBar label={tx('readiness.evidenceCompleteness')} score={bd.evidence.score}
                                detail={tx('readiness.evidenceDetail', { withEvidence: bd.evidence.withEvidence, total: bd.evidence.total })} weight={bd.evidence.weight} />
                        )}
                        {bd.policies && (
                            <BreakdownBar label={tx('readiness.keyPolicies')} score={bd.policies.score}
                                detail={tx('readiness.policiesDetail', { withPolicy: bd.policies.withPolicy, total: bd.policies.total })} weight={bd.policies.weight} />
                        )}
                        {bd.tasks && (
                            <BreakdownBar label={tx('readiness.taskCompletion')} score={bd.tasks.score}
                                detail={tx('readiness.tasksDetail', { overdue: bd.tasks.overdue })} weight={bd.tasks.weight} />
                        )}
                        {bd.issues && (
                            <BreakdownBar label={tx('readiness.openIssues')} score={bd.issues.score}
                                detail={tx('readiness.issuesDetail', { open: bd.issues.open })} weight={bd.issues.weight} />
                        )}
                    </div>
                </div>
            </div>

            {/* feat/readiness-trend — readiness over time from ReadinessSnapshot,
                with the current score merged in (see trendPoints above). */}
            {trendPoints.length >= 2 && (
                <div className={cardVariants()} id="readiness-trend">
                    <Heading level={3} className="mb-3 inline-flex items-center gap-tight"><AppIcon name="clock" size={16} /> {tx('readiness.trendTitle')}</Heading>
                    <LineChart
                        testId="readiness-trend-chart"
                        ariaLabel={tx('readiness.trendAria')}
                        seriesIndex={1}
                        showArea
                        state={chartReady<TimeSeriesPoint[]>(trendPoints)}
                    />
                    <p className="text-xs text-content-subtle mt-2">{tx('readiness.trendHint', { count: trendPoints.length })}</p>
                </div>
            )}

            {/* Recommendations */}
            {result.recommendations?.length > 0 && (
                <div className={cardVariants()} id="recommendations">
                    <Heading level={3} className="mb-3 inline-flex items-center gap-tight"><AppIcon name="info" size={16} /> {tx('readiness.recommendedActions')}</Heading>
                    <div className="space-y-tight">
                        {result.recommendations.map((r: string, i: number) => (
                            <div key={i} className="flex items-start gap-tight text-sm">
                                <span className="text-content-warning flex-shrink-0">→</span>
                                <span className="text-content-default">{r}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Gaps */}
            {result.gaps?.length > 0 && (
                <div className="space-y-compact" id="gaps-section">
                    <Heading level={3}>{tx('readiness.topGaps', { count: result.gaps.length })}</Heading>
                    <div className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-default/50')}>
                        {result.gaps.map((g, i: number) => (
                            <div key={i} className="p-3 flex items-center justify-between text-sm">
                                <div className="flex items-center gap-compact min-w-0">
                                    <AppIcon name={GAP_ICON[g.type] || 'overview'} size={16} />
                                    <div className="min-w-0">
                                        <span className="font-medium truncate block">{g.title}</span>
                                        <span className="text-xs text-content-subtle">{g.details}</span>
                                    </div>
                                </div>
                                <StatusBadge variant={SEV_BADGE[g.severity] || 'neutral'} className="ml-2">{tx(`findingModal.severityOptions.${g.severity}` as Parameters<typeof tx>[0])}</StatusBadge>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Exports */}
            <div className={cardVariants()} id="exports-section">
                <Heading level={3} className="mb-3 inline-flex items-center gap-tight"><AppIcon name="export" size={16} /> {tx('readiness.exports')}</Heading>
                <div className="flex flex-wrap gap-tight">
                    <a href={apiUrl(`/audits/cycles/${cycleId}/readiness?action=export-json`)}
                        target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{tx('readiness.exportJson')}</a>
                    <a href={apiUrl(`/audits/cycles/${cycleId}/readiness?action=export-unmapped-csv`)}
                        target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{tx('readiness.exportUnmappedCsv')}</a>
                    <a href={apiUrl(`/audits/cycles/${cycleId}/readiness?action=export-control-gaps-csv`)}
                        target="_blank" rel="noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>{tx('readiness.exportControlGapsCsv')}</a>
                </div>
            </div>
        </EntityDetailLayout>
    );
}

function BreakdownBar({ label, score, detail, weight }: { label: string; score: number; detail: string; weight: number }) {
    // Epic 59 ProgressBar primitive. Variant picks the token-backed
    // colour by score band — light-mode compatible (replaces the
    // earlier hardcoded emerald/amber/red Tailwind classes).
    //
    // This file is one of the two the ReadinessScoreRing was extracted FROM,
    // and the thresholds grew back here anyway. They now come from the single
    // definition, so a bar and the ring beside it cannot disagree.
    const tx = useTranslations('audits');
    const variant = readinessVariant(score);
    return (
        <div>
            <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-content-default">{label} ({Math.round(weight * 100)}%)</span>
                <span className="text-content-muted">{score}%</span>
            </div>
            <ProgressBar
                value={score}
                size="sm"
                variant={variant}
                aria-label={tx('readiness.scoreAria', { label })}
            />
            <p className="text-xs text-content-subtle mt-0.5">{detail}</p>
        </div>
    );
}
