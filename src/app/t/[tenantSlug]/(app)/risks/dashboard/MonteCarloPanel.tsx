'use client';

/**
 * RQ-3 / RQ3-1 — the portfolio loss-exceedance stage on the risk
 * dashboard. Shows the latest simulation's VaR tiles + the SIMULATED
 * loss-exceedance curve (the only LEC the dashboard headlines —
 * the rank-based coverage sketch is banned from this slot by the
 * rq3-1-simulated-lec ratchet), and runs a new simulation on demand.
 *
 * Appetite carry-over (RQ2-6, re-grounded for the portfolio axis):
 * on the simulated curve the x-axis is the YEAR'S TOTAL loss, so the
 * portfolio ceiling (`totalAleThreshold`) is the genuine x-threshold
 * — the curve's height at that line IS the probability of breaching
 * appetite this year. The per-risk cap (`singleRiskAleMax`) is NOT a
 * portfolio threshold; it gets an honest per-risk note computed from
 * the cached per-risk P90s instead of a line that would lie.
 */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KPIStat } from '@/components/ui/metric';
import { Heading } from '@/components/ui/typography';
import { LossExceedanceCurve, type LossReferenceLine } from '@/components/ui/charts';
import { useTenantApiUrl, useMoneyFormatter } from '@/lib/tenant-context-provider';
import { formatDateTime } from '@/lib/format-date';
import { useTranslations } from 'next-intl';
import { StatTile } from '../_shared/StatTile';

/** RQ2-6 — appetite payload from GET /risk-appetite (config + status). */
export interface AppetitePayload {
    config: {
        totalAleThreshold: number | null;
        singleRiskAleMax: number | null;
    } | null;
    status: {
        status: 'NONE' | 'WITHIN' | 'APPROACHING' | 'BREACHED';
        portfolioAle: number;
        activeBreaches: number;
    } | null;
}

/** RQ3-3 — the run is page-level state (the quant headline tiles and
 *  this stage both read it), so the shape is exported. */
export interface SimulationRun {
    portfolioMean: number | null; portfolioP50: number | null; portfolioP80: number | null;
    portfolioP90: number | null; portfolioP95: number | null; portfolioP99: number | null;
    portfolioStdDev: number | null;
    iterations: number; executionMs: number | null; completedAt: string | null;
    lecPointsJson: Array<{ threshold: number; probability: number }> | null;
    perRiskResultsJson: Array<{ riskId: string; title: string; aleMean: number; aleP90?: number; contribution: number }> | null;
    /** PR-L — the run's correlation matrix was non-PSD and was dropped. */
    correlationsDropped?: boolean | null;
}

/**
 * P(annual loss ≥ threshold) read off the simulated curve — step
 * semantics matching the engine's emission (first point at or past
 * the threshold). Clamped to the curve's domain: below the first
 * point the curve starts at P50, so the answer is "more than
 * the first point's probability"; past the last point it is ~0.
 */
function exceedanceProbabilityAt(
    points: Array<{ threshold: number; probability: number }>,
    threshold: number,
): number | null {
    if (points.length === 0) return null;
    const sorted = [...points].sort((a, b) => a.threshold - b.threshold);
    if (threshold <= sorted[0].threshold) return sorted[0].probability;
    for (const p of sorted) {
        if (p.threshold >= threshold) return p.probability;
    }
    // Past the simulated maximum — no iteration ever lost this much.
    return 0;
}

export function MonteCarloPanel({
    appetite,
    run,
    onReload,
}: {
    appetite?: AppetitePayload | null;
    /** RQ3-3 — lifted to the page; the headline tiles share it. */
    run: SimulationRun | null;
    onReload: () => Promise<void>;
}) {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const money = useMoneyFormatter();
    const [running, setRunning] = useState(false);

    const runSim = async () => {
        setRunning(true);
        try {
            const res = await fetch(apiUrl('/risks/simulate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iterations: 10000 }) });
            if (res.ok) await onReload();
        } finally { setRunning(false); }
    };

    const lec = (run?.lecPointsJson ?? []).map((p) => ({ threshold: p.threshold, exceedanceCount: Math.round(p.probability * 100), exceedanceFraction: p.probability }));
    const top = (run?.perRiskResultsJson ?? []).slice(0, 5);

    // RQ3-1 — percentile markers (muted) + the portfolio appetite
    // ceiling (critical tone) as genuine x-thresholds on the
    // portfolio-loss axis.
    const ceiling = appetite?.config?.totalAleThreshold ?? null;
    const referenceLines: LossReferenceLine[] = [];
    if (run) {
        const muted = 'var(--content-subtle, #94a3b8)';
        if (run.portfolioP50 != null) referenceLines.push({ value: run.portfolioP50, label: 'P50', color: muted });
        if (run.portfolioP80 != null) referenceLines.push({ value: run.portfolioP80, label: 'P80', color: muted });
        if (run.portfolioP95 != null) referenceLines.push({ value: run.portfolioP95, label: 'P95', color: muted });
        if (ceiling != null) referenceLines.push({ value: ceiling, label: t('monteCarlo.portfolioAppetite') });
    }
    const breachProbability =
        ceiling != null && run?.lecPointsJson?.length
            ? exceedanceProbabilityAt(run.lecPointsJson, ceiling)
            : null;

    // RQ3-1 — the per-risk cap is honest only against per-risk data:
    // count the risks whose simulated P90 loss exceeds it.
    const perRiskCap = appetite?.config?.singleRiskAleMax ?? null;
    const perRiskRows = run?.perRiskResultsJson ?? [];
    const overCapCount =
        perRiskCap != null
            ? perRiskRows.filter((r) => (r.aleP90 ?? r.aleMean) > perRiskCap).length
            : 0;

    return (
        <Card data-testid="risk-monte-carlo">
            <div className="mb-default flex items-center justify-between">
                <Heading level={2}>{t('monteCarlo.title')}</Heading>
                <Button variant="primary" size="sm" onClick={runSim} disabled={running}>{running ? t('monteCarlo.running') : t('monteCarlo.run')}</Button>
            </div>
            {!run ? (
                <p className="text-sm text-content-muted">{t('monteCarlo.empty')}</p>
            ) : (
                <>
                    <p className="mb-default text-xs text-content-muted">
                        {t('monteCarlo.lastRun', { date: run.completedAt ? formatDateTime(run.completedAt) : '', iterations: run.iterations.toLocaleString(), ms: run.executionMs ?? 0 })}
                    </p>
                    {/* PR-L — the configured correlation matrix was non-PSD, so
                        the sim dropped it and sampled independently. Surface it
                        so these numbers aren't read as correlation-aware. */}
                    {run.correlationsDropped && (
                        <div
                            className="mb-default rounded-md border border-border-warning bg-bg-warning/15 p-3 text-sm text-content-warning"
                            role="alert"
                            data-testid="mc-correlations-dropped"
                        >
                            {t('monteCarlo.correlationsDropped')}
                        </div>
                    )}
                    <div className="mb-default grid grid-cols-2 gap-default md:grid-cols-4">
                        <StatTile><KPIStat value={money(run.portfolioMean)} label={t('monteCarlo.meanAle')} /></StatTile>
                        <StatTile><KPIStat value={money(run.portfolioP95)} label={t('monteCarlo.var95')} tone="attention" /></StatTile>
                        <StatTile><KPIStat value={money(run.portfolioP99)} label={t('monteCarlo.var99')} tone="critical" /></StatTile>
                        <StatTile><KPIStat value={money(run.portfolioStdDev)} label={t('monteCarlo.stdDev')} /></StatTile>
                    </div>
                    <div className="grid grid-cols-1 gap-section lg:grid-cols-2">
                        <div>
                            <p className="mb-tight text-xs text-content-subtle">
                                {t('monteCarlo.lecDesc')}
                            </p>
                            {lec.length > 0 && (
                                <LossExceedanceCurve
                                    data={lec}
                                    testId="risk-mc-lec"
                                    ariaLabel={t('monteCarlo.lecAria')}
                                    referenceLines={referenceLines.length > 0 ? referenceLines : undefined}
                                />
                            )}
                            {/* RQ3-1 — on the portfolio axis the ceiling
                                is a genuine x-threshold: the curve's
                                height there is the breach probability. */}
                            {ceiling != null && breachProbability != null && (
                                <p className="mt-tight text-xs text-content-muted tabular-nums" data-testid="lec-portfolio-appetite-note">
                                    {t('monteCarlo.breachNote', { pct: Math.round(breachProbability * 100), money: money(ceiling) })}
                                </p>
                            )}
                            {/* The per-risk cap is NOT a portfolio
                                threshold — it gets a per-risk answer. */}
                            {perRiskCap != null && perRiskRows.length > 0 && (
                                <p className="mt-tight text-xs text-content-muted tabular-nums" data-testid="mc-per-risk-appetite-note">
                                    {t('monteCarlo.perRiskNote', { over: overCapCount, total: perRiskRows.length, money: money(perRiskCap) })}
                                </p>
                            )}
                        </div>
                        <div>
                            <Heading level={3} className="mb-2">{t('monteCarlo.topContributors')}</Heading>
                            <div className="space-y-tight">
                                {top.map((r) => (
                                    <div key={r.riskId} className="flex justify-between gap-default rounded p-2 text-sm">
                                        <span className="truncate text-content-emphasis">{r.title}</span>
                                        <span className="tabular-nums text-content-muted">{money(r.aleMean)} · {Math.round(r.contribution * 100)}%</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </>
            )}
        </Card>
    );
}
