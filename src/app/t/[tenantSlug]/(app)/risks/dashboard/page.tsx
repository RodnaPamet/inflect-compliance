'use client';
import { Fragment, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantHref, useTenantContext, useMoneyFormatter } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusBreakdown } from '@/components/ui/status-breakdown';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { KPIStat } from '@/components/ui/metric';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { SkeletonDashboard } from '@/components/ui/skeleton';
import { resolveBandForScore, resolveBandTone, type RiskSeverityTone } from '@/lib/risk-matrix/scoring';
import { RiskFirstRunEmpty } from '@/components/risks/RiskFirstRunEmpty';
import type { RiskMatrixBand } from '@/lib/risk-matrix/types';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { formatTailAwareAle } from '@/lib/tail-language';
import { MonteCarloPanel, type SimulationRun } from './MonteCarloPanel';
import { VelocityCard } from './VelocityCard';
import type { DashboardPayload } from '@/app-layer/usecases/risk-dashboard';

// B10 — Quantitative risk analytics shape. Mirrors the
// RiskQuantitativeAnalytics interface in
// `src/app-layer/usecases/risk-analytics.ts`. RQ3-1: the rank-based
// coverage sketch is NOT consumed here — the dashboard's only loss
// exceedance curve is the simulated one inside MonteCarloPanel.
type QuantitativeAnalytics = {
    totals: {
        totalCount: number;
        quantifiedCount: number;
        totalAle: number;
        avgAle: number | null;
        maxAle: number | null;
    };
    topByAle: Array<{
        id: string;
        title: string;
        category: string | null;
        sleAmount: number;
        aroAmount: number;
        ale: number;
    }>;
    byCategory: Array<{ category: string; count: number; totalAle: number }>;
};

type Risk = {
    id: string;
    title: string;
    category: string | null;
    status: string;
    treatmentOwner: string | null;
    score: number;
    inherentScore: number;
    likelihood: number;
    impact: number;
    nextReviewAt: string | null;
};

// RQ3-9 — the heatmap reads the tenant's CANONICAL risk-matrix
// bands (passed down from the orchestrator payload) rather than the
// hard-coded ladder it used pre-RQ3-9. The band resolver is the
// same one the risk panel / PDF exporter / score explainer use, so
// a tone shift here can't disagree with them.
/**
 * Semantic-token bundle per severity tone. The matrix config's `color` is a
 * CSS hex; threading it through inline styles would bypass dark-mode and the
 * WCAG-AA contrast guarantees these tokens carry. Mirrors the maps in
 * `_shared/RiskEvaluationFields.tsx` and `coverage/CoverageClient.tsx`.
 */
const HEATMAP_TONE_CLASS: Record<RiskSeverityTone, string> = {
    default: 'bg-bg-muted/40 text-content-muted',
    success: 'bg-bg-success text-content-success',
    attention: 'bg-bg-warning text-content-warning',
    critical: 'bg-bg-error text-content-error',
};

/**
 * B1-5 — tone a heatmap cell from its score.
 *
 * This used to `switch (band.name)` against the literal strings 'Low',
 * 'Medium', 'High', 'Critical' — while its own comment claimed it "consults
 * the tenant's CANONICAL band … so a tenant who customises thresholds gets
 * the right tone without code changes". `RiskMatrixConfig` lets a tenant
 * RENAME bands, so any tenant who did fell straight through to `default:`
 * and got a uniformly grey heatmap. The comment described the intent; the
 * code keyed on English names.
 *
 * `resolveBandTone` keys off the band's ORDINAL POSITION in the sorted set —
 * first is success, last is critical, the rest attention — so it is
 * rename-proof and works for any band count.
 *
 * Trade-off, deliberately taken: with the default four bands, the middle two
 * now share the attention tone where 'High' previously had a distinct
 * `bg-bg-warning/60`. Losing one shade of distinction is a far smaller
 * failure than a renamed band rendering the whole grid grey, and this
 * matches how the coverage table and evaluation fields already tone scores.
 */
const heatmapClassForScore = (
    score: number,
    bands: ReadonlyArray<RiskMatrixBand> | undefined,
): string => {
    if (!bands || bands.length === 0) return HEATMAP_TONE_CLASS.default;
    return HEATMAP_TONE_CLASS[resolveBandTone(score, bands).tone];
};

export default function RiskDashboardPage() {
    const href = useTenantHref();
    const tenant = useTenantContext();
    const t = useTranslations('riskManager');
    // RQ3-OB-A — every monetary figure speaks the tenant's currency.
    const money = useMoneyFormatter();

    // RQ3-9 — one orchestrated fetch instead of six. The page no
    // longer owns a useEffect per widget; the failure-soft contract
    // is preserved end-to-end (the orchestrator returns null per
    // slot on a thrown branch, the page treats null as "not ready
    // yet" exactly as it did before).
    const { data, isLoading, mutate } = useTenantSWR<DashboardPayload>(
        '/risks/dashboard',
    );

    const risks = (data?.risks ?? []) as Risk[];
    const analytics = (data?.analytics ?? null) as QuantitativeAnalytics | null;
    const coherence = data?.coherence ?? null;
    const staleness = data?.staleness ?? null;
    const appetite = data?.appetite ?? null;
    const simRun = (data?.simulation ?? null) as SimulationRun | null;
    const matrix = data?.matrix ?? null;

    // RQ3-4 — per-risk P90s from the lifted run (RQ3-1 cache); the
    // top-10 and coherence rows speak the tail register through it.
    const tailByRisk = useMemo(() => {
        const map: Record<string, number> = {};
        for (const e of simRun?.perRiskResultsJson ?? []) {
            if (e.aleP90 != null) map[e.riskId] = e.aleP90;
        }
        return map;
    }, [simRun]);

    // MonteCarloPanel can still trigger a fresh load (the "Re-run"
    // affordance) — surface a callback that re-pulls the whole
    // orchestrated payload so the panel + tiles + appetite all
    // refresh in lockstep.
    const loadSimRun = useCallback(async () => {
        await mutate();
    }, [mutate]);

    const loading = isLoading || !data;

    // KPIs
    const total = risks.length;
    const avgScore = total ? (risks.reduce((s, r) => s + r.inherentScore, 0) / total).toFixed(1) : '0.0';
    const openCount = risks.filter(r => r.status === 'OPEN' || r.status === 'MITIGATING').length;
    const now = new Date();
    const overdueRisks = risks.filter(r => r.nextReviewAt && new Date(r.nextReviewAt) < now);

    // Status breakdown
    const statusCounts = risks.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
    }, {});

    // Heatmap
    const heatmapCounts: Record<string, number> = {};
    risks.forEach(r => {
        const key = `${r.likelihood}-${r.impact}`;
        heatmapCounts[key] = (heatmapCounts[key] || 0) + 1;
    });

    // B1-5 — axis extents come from the tenant's matrix config, not a
    // hardcoded 5. Falls back to 5 only while the payload is still loading,
    // which matches the rest of this page's null-matrix handling.
    const likelihoodLevels = matrix?.likelihoodLevels ?? 5;
    const impactLevels = matrix?.impactLevels ?? 5;
    // Impact reads left→right ascending; likelihood reads bottom→top, so the
    // rows are rendered highest-first.
    const impactAxis = Array.from({ length: impactLevels }, (_, n) => n + 1);
    const likelihoodAxis = Array.from({ length: likelihoodLevels }, (_, n) => likelihoodLevels - n);

    if (loading) {
        return <SkeletonDashboard />;
    }

    return (
        <DashboardLayout
            header={{
                back: { smart: true },
                title: t('dashboardTitle'),
                description: `${tenant.tenantName} — ${t('riskCount', { count: total })}`,
                actions: (
                    <Link href={href('/risks')} className={buttonVariants({ variant: 'secondary' })} id="back-to-register">
                        {t('riskRegister')}
                    </Link>
                ),
            }}
        >

            {/* KPI Cards — Polish PR-2: KPIStat primitive. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                <Card>
                    <KPIStat value={total} label={t('totalRisks')} />
                </Card>
                <Card>
                    <KPIStat value={avgScore} label={t('avgScore')} tone="attention" />
                </Card>
                <Card>
                    <KPIStat value={openCount} label={t('openRisks')} tone="success" />
                </Card>
                <Card>
                    <KPIStat
                        value={overdueRisks.length}
                        label={t('overdueReviews')}
                        tone={overdueRisks.length > 0 ? 'critical' : 'success'}
                    />
                </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-section">
                {/* Status Breakdown — Epic 59: StatusBreakdown primitive. */}
                <Card>
                    <Heading level={3} className="mb-4">{t('statusBreakdown')}</Heading>
                    <StatusBreakdown
                        ariaLabel={t('dash.statusAria')}
                        total={total}
                        showPercent
                        emptyState={<RiskFirstRunEmpty size="sm" />}
                        items={Object.entries(statusCounts)
                            .sort(([, a], [, b]) => b - a)
                            .map(([status, count]) => ({
                                id: status,
                                label: status,
                                value: count,
                                variant: 'brand' as const,
                            }))}
                    />
                </Card>

                {/* Heatmap */}
                <Card>
                    <Heading level={3} className="mb-4">{t('heatmapTitle')}</Heading>
                    {/* B1-5 — the axes come from the tenant's matrix config.
                        This grid was hardcoded 5x5 ([5,4,3,2,1] rows,
                        [1,2,3,4,5] columns, grid-cols-repeat(5)), so a tenant
                        on a 6x6 matrix saw a SILENTLY TRUNCATED heatmap: the
                        6-level row and column simply were not drawn, and the
                        risks living there vanished from the picture with no
                        indication anything was missing. A 3x3 tenant got
                        phantom cells for levels that do not exist. */}
                    <div
                        className="grid gap-1 text-xs"
                        style={{ gridTemplateColumns: `auto repeat(${impactLevels}, 1fr)` }}
                    >
                        <div></div>
                        {impactAxis.map(i => (
                            <div key={i} className="text-center text-content-subtle font-medium pb-1">{i}</div>
                        ))}
                        {likelihoodAxis.map(l => (
                            <Fragment key={`row-${l}`}>
                                <div className="flex items-center text-content-subtle font-medium pr-2">{l}</div>
                                {impactAxis.map(i => {
                                    const count = heatmapCounts[`${l}-${i}`] || 0;
                                    const s = l * i;
                                    const band = matrix
                                        ? resolveBandForScore(s, matrix.bands)
                                        : { name: '', minScore: 0, maxScore: 0, color: '' };
                                    return (
                                        // B2-7 — <Tooltip>, not a raw `title=`.
                                        // Epic 56 bans new title attributes: the
                                        // native tooltip is unstyled, cannot be
                                        // opened from the keyboard, and is
                                        // invisible to touch. This surface was
                                        // breaking the rule its sibling
                                        // (RisksClient's score chip) documents.
                                        <Tooltip
                                            key={`${l}-${i}`}
                                            content={t('dash.heatmapCell', { l, i, score: s, count, band: band.name })}
                                        >
                                            <div
                                                className={`h-10 rounded flex items-center justify-center font-medium transition-colors duration-150 ease-out cursor-default ${heatmapClassForScore(s, matrix?.bands)}`}
                                                data-band={band.name}
                                            >
                                                {count > 0 ? count : ''}
                                            </div>
                                        </Tooltip>
                                    );
                                })}
                            </Fragment>
                        ))}
                        <div className="text-content-subtle text-[10px] mt-1">L↑</div>
                        <div
                            className="text-center text-content-subtle text-[10px] mt-1"
                            style={{ gridColumn: `span ${impactLevels}` }}
                        >
                            {t('dash.impactArrow')}
                        </div>
                    </div>
                </Card>
            </div>

            {/* B10 — Quantitative analytics. Renders only when the
                tenant has at least one quantified risk (SLE + ARO
                populated). The block is laid out as: KPI strip
                (totals), top-10 ALE table, loss-exceedance curve.
                polish #10 — the un-quantified case used to vanish
                silently; a one-line empty-state tells the user
                WHY there's no curve. */}
            {analytics && analytics.totals.quantifiedCount === 0 && analytics.totals.totalCount > 0 && (
                <Card data-testid="risk-quant-empty-hint">
                    <Heading level={2} className="mb-2">{t('dash.quantAnalytics')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('dash.quantEmpty')}
                    </p>
                </Card>
            )}
            {analytics && analytics.totals.quantifiedCount > 0 && (
                <Card data-testid="risk-quant-analytics">
                    <Heading level={2} className="mb-2">{t('dash.quantAnalytics')}</Heading>
                    <p className="text-sm text-content-muted mb-default">
                        {t('dash.quantifiedCount', {
                            count: analytics.totals.quantifiedCount,
                            total: analytics.totals.totalCount,
                        })}
                    </p>
                    {/* RQ3-3 — portfolio honesty. With a simulation
                        run, the headline is the loss DISTRIBUTION
                        (P50/P80/P95, correlations applied) — never
                        the sum of averages. The Σ figure survives
                        only as the subordinate line below, with the
                        tooltip explaining the gap. */}
                    {simRun ? (
                        <>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-default mb-default">
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-p50">
                                    <KPIStat value={money(simRun.portfolioP50)} label={t('dash.p50')} />
                                </div>
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-p80">
                                    <KPIStat value={money(simRun.portfolioP80)} label={t('dash.p80')} tone="attention" />
                                </div>
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-p95">
                                    <KPIStat value={money(simRun.portfolioP95)} label={t('dash.p95')} tone="critical" />
                                </div>
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-max">
                                    <KPIStat value={money(analytics.totals.maxAle)} label={t('dash.maxAle')} />
                                </div>
                            </div>
                            <p className="mb-default flex items-center gap-tight text-xs text-content-subtle tabular-nums" data-testid="risk-quant-sum-line">
                                {t('dash.sumLine', { amount: money(analytics.totals.totalAle) })}
                                <InfoTooltip content={t('dash.sumTooltip')} />
                            </p>
                        </>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-default mb-default">
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-total">
                                    <KPIStat
                                        value={money(analytics.totals.totalAle)}
                                        label={t('dash.totalAle')}
                                    />
                                </div>
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-avg">
                                    <KPIStat
                                        value={money(analytics.totals.avgAle)}
                                        label={t('dash.avgAle')}
                                        tone="attention"
                                    />
                                </div>
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-max">
                                    <KPIStat
                                        value={money(analytics.totals.maxAle)}
                                        label={t('dash.maxAle')}
                                        tone="critical"
                                    />
                                </div>
                                <div className="rounded-md bg-bg-muted/30 px-default py-default" data-testid="risk-quant-tile-cats">
                                    <KPIStat
                                        value={analytics.byCategory.length}
                                        label={t('dash.catsCarrying')}
                                    />
                                </div>
                            </div>
                            <p className="mb-default text-xs text-content-subtle" data-testid="risk-quant-sum-nudge">
                                {t('dash.sumNudge')}
                            </p>
                        </>
                    )}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-section">
                        <div>
                            <Heading level={3} className="mb-2">{t('dash.top10')}</Heading>
                            <div className="space-y-tight">
                                {analytics.topByAle.map((row) => (
                                    <Link
                                        key={row.id}
                                        href={href(`/risks/${row.id}`)}
                                        className="flex justify-between gap-default p-2 rounded text-sm hover:bg-bg-muted/50 transition-colors duration-100 ease-out"
                                        data-testid={`risk-quant-top-row-${row.id}`}
                                    >
                                        <span className="truncate text-content-emphasis">
                                            {row.title}
                                        </span>
                                        <span className="tabular-nums text-content-muted">
                                            {formatTailAwareAle(row.ale, tailByRisk[row.id] ?? null, { money, compact: true })}
                                        </span>
                                    </Link>
                                ))}
                            </div>
                        </div>
                        {/* RQ3-1 — the rank-based "LEC" that used to sit
                            here was a coverage statement wearing a
                            probability chart's clothes. The simulated
                            curve below (MonteCarloPanel) is the loss
                            exceedance curve; this column now answers
                            the coverage question honestly as a list. */}
                        <div>
                            <Heading level={3} className="mb-2">{t('dash.exposureByCat')}</Heading>
                            <div className="space-y-tight" data-testid="risk-quant-by-category">
                                {analytics.byCategory.slice(0, 10).map((c) => (
                                    <div
                                        key={c.category}
                                        className="flex justify-between gap-default p-2 rounded text-sm"
                                    >
                                        <span className="truncate text-content-emphasis">
                                            {c.category}
                                        </span>
                                        <span className="tabular-nums text-content-muted">
                                            {money(c.totalAle)} · {c.count}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </Card>
            )}

            {/* RQ-3 / RQ3-1 — the portfolio loss exceedance stage:
                simulated curve, VaR tiles, appetite thresholds. */}
            <MonteCarloPanel appetite={appetite} run={simRun} onReload={loadSimRun} />

            {/* RQ2-5 — qual ↔ quant coherence. Renders only when the
                detector has enough quantified risks to rank; an
                agreeing portfolio gets a one-line all-clear. */}
            {coherence && coherence.quantifiedCount >= coherence.minRequired && (
                <Card data-testid="risk-coherence-widget">
                    <Heading level={2} className="mb-2">{t('dash.coherenceTitle')}</Heading>
                    {coherence.flags.length === 0 ? (
                        <p className="text-sm text-content-muted">
                            {t('dash.coherenceAgree', { count: coherence.quantifiedCount })}
                        </p>
                    ) : (
                        <>
                            <p className="text-sm text-content-muted mb-default">
                                {t('dash.coherenceDisagree', { count: coherence.flags.length })}
                            </p>
                            <div className="space-y-tight">
                                {coherence.flags.map((f) => {
                                    // polish #4 — a scan-fast chip
                                    // tells the eye which language is
                                    // the louder one before the
                                    // sentence reads. $↑ #↓ = money
                                    // says big, matrix says small;
                                    // and the inverse for #↑ $↓.
                                    const moneyBigger = f.direction === 'QUANT_HIGH_QUAL_LOW';
                                    return (
                                        <Link
                                            key={f.riskId}
                                            href={href(`/risks/${f.riskId}?tab=assessment`)}
                                            className="flex items-center justify-between gap-default p-2 rounded text-sm hover:bg-bg-muted/50 transition-colors duration-100 ease-out"
                                            data-testid={`risk-coherence-row-${f.riskId}`}
                                            data-direction={f.direction}
                                        >
                                            <span className="flex items-center gap-tight truncate">
                                                <span
                                                    aria-hidden="true"
                                                    className="inline-flex items-center gap-px rounded border border-border-subtle px-1 text-[10px] tabular-nums text-content-emphasis"
                                                    data-testid={`risk-coherence-chip-${f.riskId}`}
                                                >
                                                {moneyBigger ? t('dash.chipMoneyBigger') : t('dash.chipScoreBigger')}
                                                </span>
                                                <span className="truncate text-content-emphasis">{f.title}</span>
                                            </span>
                                            <span className="shrink-0 tabular-nums text-content-muted">
                                                {moneyBigger
                                                    ? t('dash.coherenceBigger', { score: f.score, ale: formatTailAwareAle(f.ale, tailByRisk[f.riskId] ?? null, { money, compact: true }) ?? '' })
                                                    : t('dash.coherenceSmaller', { score: f.score, ale: formatTailAwareAle(f.ale, tailByRisk[f.riskId] ?? null, { money, compact: true }) ?? '' })}
                                            </span>
                                        </Link>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </Card>
            )}

            {/* RQ2-8 — stale assessments. Renders only when rot
                exists; an all-fresh register stays quiet. */}
            {staleness && staleness.staleCount > 0 && (
                <Card data-testid="risk-staleness-widget">
                    <Heading level={2} className="mb-2">{t('dash.staleTitle')}</Heading>
                    <p className="text-sm text-content-muted mb-default">
                        {t('dash.staleBody', {
                            stale: staleness.staleCount,
                            total: staleness.totalCount,
                            days: staleness.maxAssessmentAgeDays,
                        })}
                    </p>
                    <div className="space-y-tight">
                        {staleness.staleRisks.slice(0, 10).map((r) => {
                            // polish #5 — rot-severity left-border tint
                            // draws the eye to multi-reason rows; the
                            // widget already sorts rot-first, this just
                            // makes the gradient visible.
                            const tone =
                                r.reasons.length >= 3
                                    ? 'border-l-content-error'
                                    : r.reasons.length === 2
                                      ? 'border-l-content-warning'
                                      : 'border-l-border-subtle';
                            // RQ3-OB-C — staleness rows deep-link to the
                            // assessment tab so the user lands on the exact
                            // pane that closes the rot signal (re-assess
                            // for AGED/REVIEW_OVERDUE/SIGNAL_MOVED;
                            // re-derive residual for CONTROLS_MOVED_SINCE).
                            return (
                                <Link
                                    key={r.riskId}
                                    href={href(`/risks/${r.riskId}?tab=assessment`)}
                                    className={`flex items-center justify-between gap-default p-2 pl-3 rounded border-l-2 ${tone} text-sm hover:bg-bg-muted/50 transition-colors duration-100 ease-out`}
                                    data-testid={`risk-stale-row-${r.riskId}`}
                                    data-reason-count={r.reasons.length}
                                >
                                    <span className="truncate text-content-emphasis">{r.title}</span>
                                    <span className="shrink-0 text-xs text-content-muted">{r.description}</span>
                                </Link>
                            );
                        })}
                        {staleness.staleRisks.length > 10 && (
                            <p className="text-xs text-content-subtle">
                                {t('dash.moreCount', { count: staleness.staleRisks.length - 10 })}
                            </p>
                        )}
                    </div>
                </Card>
            )}

            {/* RQ-9 — risk velocity */}
            <VelocityCard />

            {/* Overdue */}
            {overdueRisks.length > 0 && (
                <Card className="border-border-error">
                    <Heading level={2} className="mb-3 text-content-error">{t('overdueReviewsTitle')}</Heading>
                    <div className="space-y-tight">
                        {overdueRisks.map(r => {
                            const daysOverdue = Math.floor((now.getTime() - new Date(r.nextReviewAt!).getTime()) / 86400000);
                            return (
                                <Link key={r.id} href={href(`/risks/${r.id}?tab=assessment`)} className="flex justify-between items-center p-2 rounded hover:bg-bg-error transition">
                                    <span className="text-sm text-content-emphasis">{r.title}</span>
                                    <span className="text-xs text-content-error">{t('daysOverdue', { days: daysOverdue })} · {r.treatmentOwner || t('noOwner')}</span>
                                </Link>
                            );
                        })}
                    </div>
                </Card>
            )}
        </DashboardLayout>
    );
}
