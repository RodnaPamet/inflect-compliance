'use client';

/**
 * `<PostureHeroCard>` — dashboard masthead (replaces the raw 72px coverage
 * HeroMetric).
 *
 * Renders the daily-cached AI compliance-posture summary: the postureLabel +
 * maturityScore as the headline, the narrative below, and the top prioritized
 * next-steps. Control coverage is preserved as a secondary stat. An admin/
 * write-capable user gets a subtle "Regenerate" affordance.
 *
 * When no cached summary exists yet (fresh tenant, cron not run, or LLM
 * disabled) the parent renders the classic coverage-% hero metric instead, so
 * the masthead is NEVER blank or a perpetual spinner. This component always
 * receives a non-null summary and defends against partial cache data.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { cardVariants } from '@/components/ui/card';
import { AnimatedNumber } from '@/components/ui/animated-number';
import { Button } from '@/components/ui/button';
import type { PostureSummaryDto } from '@/app-layer/usecases/compliance-posture';
import type { PostureLabel, AdvicePriority } from '@/app-layer/ai/compliance-posture/types';
import { RadarChart, chartReady, type RadarAxisDatum } from '@/components/ui/charts';

const LABEL_COPY: Record<PostureLabel, string> = {
    STRONG: 'Strong',
    ESTABLISHED: 'Established',
    DEVELOPING: 'Developing',
    AT_RISK: 'At risk',
};

const LABEL_TONE: Record<PostureLabel, string> = {
    STRONG: 'text-content-success',
    ESTABLISHED: 'text-content-info',
    // DEVELOPING wears the SAME yellow→blue sweep as the primary "Continue
    // Setup" button (the `--btn-gradient-primary` fill token), clipped to the
    // glyphs — it reads as the "still building" state, echoing the setup CTA.
    DEVELOPING: 'bg-[image:var(--btn-gradient-primary)] bg-clip-text text-transparent',
    AT_RISK: 'text-content-error',
};

const PRIORITY_TONE: Record<AdvicePriority, string> = {
    high: 'bg-bg-error-emphasis',
    medium: 'bg-bg-warning-emphasis',
    low: 'bg-border-emphasis',
};

export interface PostureHeroCardProps {
    summary: PostureSummaryDto;
    canRegenerate?: boolean;
    onRegenerate?: () => void;
    regenerating?: boolean;
    /**
     * The six-axis profile behind the headline (`buildPostureRadarAxes`).
     * Omit — or pass an empty array — and the hero renders exactly as it
     * did before, full-width narrative and no chart column.
     */
    radarAxes?: RadarAxisDatum[];
}

export function PostureHeroCard({
    summary,
    canRegenerate = false,
    onRegenerate,
    regenerating = false,
    radarAxes,
}: PostureHeroCardProps) {
    const t = useTranslations('dashboard');
    // Defend against partial/stale cache data — fall back to a neutral band,
    // an empty advice list, and a numeric-guarded score so a malformed row can
    // never crash the masthead.
    const label: PostureLabel =
        summary.postureLabel && LABEL_COPY[summary.postureLabel]
            ? summary.postureLabel
            : 'DEVELOPING';
    const advice = Array.isArray(summary.advice) ? summary.advice : [];
    const maturityScore =
        typeof summary.maturityScore === 'number' ? summary.maturityScore : null;
    const hasRadar = Array.isArray(radarAxes) && radarAxes.length > 0;

    return (
        <section
            className={cn(
                cardVariants(),
                'relative isolate overflow-hidden',
                "before:content-[''] before:absolute before:inset-0 before:-z-10 before:pointer-events-none",
                'before:bg-[radial-gradient(ellipse_640px_400px_at_18%_60%,var(--brand-subtle)_0%,transparent_72%)]',
                'before:opacity-[0.15]',
            )}
            data-hero-metric
            data-testid="dashboard-hero"
        >
            {/* Regenerate — corner affordance (admin / write-capable only).
                Absolutely positioned so the narrative + advice span the full
                width beneath it; the headline row clears it vertically. */}
            {canRegenerate && (
                <div className="absolute right-default top-default z-10">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onRegenerate}
                        disabled={regenerating}
                        data-testid="dashboard-hero-regenerate"
                    >
                        {regenerating ? t('hero.regenerating') : t('hero.regenerate')}
                    </Button>
                </div>
            )}

            {/* Two columns from `lg` up: the narrative reads on the left,
                the six-axis profile it summarises sits on the right. Below
                `lg` the grid collapses and the radar stacks under the
                advice list rather than squeezing beside it — at ~300px
                wide the axis labels collide.

                `items-start` (not `stretch`): the radar keeps its own
                fixed height and must not inherit the narrative column's,
                which grows with the advice list. */}
            <div
                className={cn(
                    'grid grid-cols-1 gap-default items-start',
                    hasRadar && 'lg:grid-cols-[minmax(0,1fr)_320px]',
                )}
            >
            {/* Headline + narrative + advice. */}
            <div className="min-w-0 flex flex-col gap-tight">
                <p
                    className="text-xs text-content-muted uppercase tracking-wide font-medium"
                    data-hero-metric-eyebrow
                >
                    {t('hero.eyebrow')}
                </p>
                <div className="flex items-baseline gap-default flex-wrap">
                    <p
                        className={cn('text-[28px] leading-none font-bold', LABEL_TONE[label])}
                        data-posture-label={label}
                    >
                        {LABEL_COPY[label]}
                    </p>
                    {maturityScore !== null && (
                        <p
                            className="text-sm text-content-muted tabular-nums"
                            data-posture-maturity
                        >
                            <span className="text-2xl font-semibold text-content-emphasis">
                                <AnimatedNumber
                                    value={maturityScore}
                                    format={{ kind: 'decimal', fractionDigits: 0 }}
                                />
                            </span>
                            <span className="ml-1">{t('hero.maturitySuffix')}</span>
                        </p>
                    )}
                </div>

                <p
                    className="text-sm text-content-muted mt-tight"
                    data-posture-summary-text
                >
                    {summary.summaryText}
                </p>

                {advice.length > 0 && (
                    <ul className="mt-tight space-y-tight" data-posture-advice>
                        {advice.map((item, i) => (
                            <li key={i} className="flex items-start gap-tight text-sm">
                                <span
                                    className={cn(
                                        'mt-1.5 h-2 w-2 rounded-full shrink-0',
                                        PRIORITY_TONE[item.priority],
                                    )}
                                    aria-hidden="true"
                                />
                                <span className="min-w-0">
                                    <span className="font-medium text-content-emphasis">
                                        {item.title}
                                    </span>
                                    {item.detail && (
                                        <span className="text-content-muted"> — {item.detail}</span>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

                {hasRadar && (
                    // Guaranteed-height slot. NEVER `min-h-0` here — a
                    // collapsible flex/grid child gives the chart's
                    // auto-sizer a 0-height box and it renders blank
                    // (the lesson the org maturity widget carries).
                    <div
                        className="h-[260px] w-full min-w-0"
                        data-testid="dashboard-hero-radar"
                    >
                        <RadarChart
                            state={chartReady(radarAxes!)}
                            seriesIndex={2}
                            maxValue={100}
                            testId="posture-radar"
                            ariaLabel={t('hero.radarAria')}
                        />
                    </div>
                )}
            </div>
        </section>
    );
}
