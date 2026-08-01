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
import { RadarChart, chartReady } from '@/components/ui/charts';
import {
    POSTURE_LADDER,
    POSTURE_RADAR_FRAME_HEIGHT,
    levelKey,
    overallLevel,
    toRadarAxes,
    type PostureAxisRating,
} from '@/lib/charts/posture-radar';
import { PostureLadder, LEVEL_TONE } from './PostureLadder';

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
     * The six rated axes behind the headline (`ratePostureAxes`). Omit —
     * or pass an empty array — and the hero renders exactly as it did
     * before: full-width narrative, no chart column, no level.
     */
    ratings?: PostureAxisRating[];
}

export function PostureHeroCard({
    summary,
    canRegenerate = false,
    onRegenerate,
    regenerating = false,
    ratings,
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
    const hasRadar = Array.isArray(ratings) && ratings.length > 0;
    // The headline number and the chart are ONE reading: the level is the
    // weakest rated axis, which is the shortest spoke on the radar beside
    // it. Previously the headline carried the model's own 0-100 maturity
    // score, which no feature of the chart corresponded to — two numbers
    // for one claim, and nothing to check either against.
    const { level, limitedBy } = overallLevel(ratings ?? []);

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
                width beneath it.

                `top-section` / `right-section` (24px) rather than
                `top-default` (16px): that is the card's own padding, so the
                button lands exactly on the content edge and reads as level
                with the eyebrow opposite it instead of 8px high. */}
            {canRegenerate && (
                <div className="absolute right-section top-section z-10">
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

                `items-start`: both columns begin at the card's content
                edge, so the eyebrow sits on the same line as the
                Regenerate button in the opposite corner. Centring the
                columns (the previous rule) pushed the eyebrow 93px down
                the card — measured — to balance against a right column
                that is taller by construction. */}
            <div
                className={cn(
                    'grid grid-cols-1 gap-default items-start',
                    hasRadar && 'lg:grid-cols-[minmax(0,1fr)_340px]',
                )}
            >
            {/* Headline + narrative + advice. */}
            <div className="min-w-0 flex flex-col gap-tight">
                {/* `h-7 flex items-center` — the Regenerate button's own
                    height. Both start at the card's content edge, so
                    matching the line box is what makes their CENTRES line
                    up; a bare text node starts level with the button's top
                    edge and reads 10px high against it. */}
                <p
                    className="flex h-7 items-center text-xs text-content-muted uppercase tracking-wide font-medium"
                    data-hero-metric-eyebrow
                >
                    {t('hero.eyebrow')}
                </p>
                {/* ONE voice. The headline word used to be the model's own
                    posture label, which sat beside a deterministic level
                    computed from the six axes — "Developing" next to
                    "Level 1 · Initial" is two answers to one question, and
                    only one of them can be checked. The ladder names the
                    band now; the model keeps the narrative and the advice,
                    which is what it is actually good at.

                    The model's label still leads when there is no estate to
                    rate (no axes ⇒ no level), so a tenant that has not
                    started yet still gets a headline. */}
                <div className="flex items-baseline gap-default flex-wrap">
                    {hasRadar ? (
                        <>
                            <p
                                className={cn('text-[28px] leading-none font-bold', LEVEL_TONE[level])}
                                data-posture-label={levelKey(level)}
                            >
                                {t(`hero.ladder.${levelKey(level)}`)}
                            </p>
                            <p
                                className="text-sm text-content-muted tabular-nums"
                                data-posture-level={level}
                            >
                                <span className="text-2xl font-semibold text-content-emphasis">
                                    <AnimatedNumber
                                        value={level}
                                        format={{ kind: 'decimal', fractionDigits: 0 }}
                                    />
                                </span>
                                <span className="ml-1">{t('hero.levelOfSuffix')}</span>
                            </p>
                        </>
                    ) : (
                        <p
                            className={cn('text-[28px] leading-none font-bold', LABEL_TONE[label])}
                            data-posture-label={label}
                        >
                            {LABEL_COPY[label]}
                        </p>
                    )}
                </div>

                {/* The sentence that joins the headline to the chart. The
                    level is the weakest spoke, so naming that spoke turns a
                    number into an instruction — and tells the reader which
                    point of the polygon to look at. */}
                {limitedBy && (
                    <p className="text-xs text-content-subtle" data-posture-limited-by={limitedBy.key}>
                        {t('hero.limitedBy', {
                            axis: limitedBy.label,
                            measured: limitedBy.measured,
                            total: limitedBy.total,
                        })}
                    </p>
                )}

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
                    <div className="flex w-full min-w-0 flex-col gap-tight" data-testid="dashboard-hero-radar">
                        {/* The frame IS the slot. A fixed-height wrapper
                            around it does nothing for the dial — ChartFrame
                            absolutely positions its measured area and
                            resolves to its own min-height — so the extra
                            height became dead space between the chart and
                            the metrics beneath it. `minHeight` sizes the
                            dial itself. */}
                        <RadarChart
                            state={chartReady(toRadarAxes(ratings!))}
                            seriesIndex={2}
                            maxValue={100}
                            // One ring per rung, so a vertex sitting on
                            // the third ring means level 3 — the grid IS
                            // the ladder rather than decoration.
                            rings={POSTURE_LADDER.length}
                            minHeight={POSTURE_RADAR_FRAME_HEIGHT}
                            testId="posture-radar"
                            ariaLabel={t('hero.radarAria')}
                        />
                        {/* The ladder, spelled out — the half that makes the
                            chart checkable. */}
                        <PostureLadder ratings={ratings!} />
                    </div>
                )}
            </div>
        </section>
    );
}
