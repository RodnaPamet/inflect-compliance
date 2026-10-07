/**
 * Polish PR-2 — Metric primitives.
 *
 * Two rungs of the type scale dedicated to numeric content:
 *
 *   <HeroMetric>  — masthead-anchor, ONE per page (e.g. dashboard
 *                   masthead, audit-readiness summary). 56-72px,
 *                   tabular-nums, semibold.
 *
 *   <KPIStat>     — KPI grid metric, 3-4 per row. 28-32px, tabular-
 *                   nums, semibold. Two sizes (md / sm) so the same
 *                   primitive serves dashboard KPI rows and meta-
 *                   strip numeric values.
 *
 * Why a primitive
 *   Compliance software is fundamentally about numbers. Until this
 *   PR the dashboards each invented their own number typography:
 *     - dashboard masthead used a 72px hero
 *     - risks dashboard used `<p className="text-3xl font-bold">`
 *     - other per-domain dashboards were similar but slightly
 *       different
 *   Numbers are typographic primitives, not styling improvisations.
 *
 * Tone — replaces a sibling status pill
 *   The KPI grid often pairs a number with a colour-tone. Today
 *   that's done by painting the number with `text-content-warning`
 *   AND rendering a chip next to it. The `tone` prop encodes the
 *   tone in the number's own colour, so the sibling pill can be
 *   dropped. Tone never duplicates a chip — pick one or the other.
 *
 * Tabular nums lock
 *   `font-variant-numeric: tabular-nums` is applied unconditionally.
 *   A number that updates (poll/SWR re-render) MUST NOT cause horizontal
 *   jitter — that's the contract.
 */

import * as React from 'react';
import { cn } from '@inflect/ui/lib/cn';
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from 'lucide-react';

// ─── Tone tokens ─────────────────────────────────────────────────────

export type MetricTone = 'default' | 'success' | 'attention' | 'critical';

const TONE_VALUE_CLASS: Record<MetricTone, string> = {
    default: 'text-content-emphasis',
    success: 'text-content-success',
    attention: 'text-content-warning',
    critical: 'text-content-error',
};

// ─── Trend ───────────────────────────────────────────────────────────

export interface MetricTrend {
    /** 'up', 'down', or 'flat'. Direction of change vs prior period. */
    direction: 'up' | 'down' | 'flat';
    /**
     * The magnitude as a number. Caller formats it however they want
     * (12, '12%', '+3', etc) — passing a `magnitude` ReactNode keeps
     * formatting at the call site. Optional.
     */
    magnitude?: React.ReactNode;
    /**
     * Whether 'up' is a good outcome ('success' tone) or bad
     * ('critical'). Defaults to 'good' = 'up' is success. For overdue
     * counts pass `goodDirection: 'down'` so an upward trend reads as
     * critical.
     */
    goodDirection?: 'up' | 'down';
    /** Optional aria label for the trend indicator. */
    ariaLabel?: string;
}

function trendTone(trend: MetricTrend): MetricTone {
    if (trend.direction === 'flat') return 'default';
    const good = trend.goodDirection ?? 'up';
    if (trend.direction === good) return 'success';
    return 'critical';
}

function TrendIndicator({ trend, size }: { trend: MetricTrend; size: 'md' | 'sm' }) {
    const Icon =
        trend.direction === 'up'
            ? ArrowUpIcon
            : trend.direction === 'down'
              ? ArrowDownIcon
              : MinusIcon;
    const tone = trendTone(trend);
    const iconSize = size === 'md' ? 12 : 10;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-0.5 font-medium tabular-nums',
                size === 'md' ? 'text-xs' : 'text-[10px]',
                TONE_VALUE_CLASS[tone],
            )}
            aria-label={trend.ariaLabel}
        >
            <Icon size={iconSize} aria-hidden="true" />
            {trend.magnitude != null && <span>{trend.magnitude}</span>}
        </span>
    );
}

// ─── HeroMetric ──────────────────────────────────────────────────────

export interface HeroMetricProps {
    /** The value. Numbers, ReactNodes (formatted strings), or null. */
    value: React.ReactNode;
    /** Short caption shown below the value. */
    label: React.ReactNode;
    /** Optional context line below the label. */
    description?: React.ReactNode;
    /** Optional trend indicator next to the value. */
    trend?: MetricTrend;
    /** Tone applied to the value. Default 'default' (no colour cue). */
    tone?: MetricTone;
    /** Optional secondary action (e.g. link to detail). */
    action?: React.ReactNode;
    className?: string;
    'data-testid'?: string;
}

export function HeroMetric({
    value,
    label,
    description,
    trend,
    tone = 'default',
    action,
    className,
    'data-testid': testId = 'hero-metric',
}: HeroMetricProps) {
    return (
        <div
            className={cn('flex flex-col gap-tight', className)}
            data-testid={testId}
        >
            <div className="flex items-baseline gap-compact flex-wrap">
                <span
                    className={cn(
                        'text-5xl md:text-6xl font-semibold leading-none tabular-nums',
                        TONE_VALUE_CLASS[tone],
                    )}
                    data-metric-value
                >
                    {value}
                </span>
                {trend && <TrendIndicator trend={trend} size="md" />}
            </div>
            <div className="flex items-center gap-tight">
                <span className="text-sm font-medium text-content-default">
                    {label}
                </span>
                {action}
            </div>
            {description && (
                <span className="text-xs text-content-muted">{description}</span>
            )}
        </div>
    );
}

// ─── KPIStat ─────────────────────────────────────────────────────────

export interface KPIStatProps {
    value: React.ReactNode;
    label: React.ReactNode;
    description?: React.ReactNode;
    trend?: MetricTrend;
    tone?: MetricTone;
    /** md (default, ~28-32px) or sm (~20-22px, for meta strips). */
    size?: 'md' | 'sm';
    /** Optional href — wraps the stat in a Link-style hover. */
    href?: string;
    /** Optional DOM id placed on the value span — preserves E2E test anchors. */
    id?: string;
    className?: string;
    'data-testid'?: string;
}

export function KPIStat({
    value,
    label,
    description,
    trend,
    tone = 'default',
    size = 'md',
    href,
    id,
    className,
    'data-testid': testId = 'kpi-stat',
}: KPIStatProps) {
    const inner = (
        <div
            className={cn(
                'flex flex-col',
                size === 'md' ? 'gap-tight' : 'gap-0.5',
                className,
            )}
            data-testid={testId}
        >
            <span className="text-[11px] font-medium uppercase tracking-wide text-content-muted">
                {label}
            </span>
            <div className="flex items-baseline gap-tight flex-wrap">
                <span
                    id={id}
                    className={cn(
                        'font-semibold leading-none tabular-nums',
                        size === 'md' ? 'text-3xl' : 'text-xl',
                        TONE_VALUE_CLASS[tone],
                    )}
                    data-metric-value
                >
                    {value}
                </span>
                {trend && <TrendIndicator trend={trend} size={size} />}
            </div>
            {description && (
                <span className="text-xs text-content-muted">{description}</span>
            )}
        </div>
    );

    if (href) {
        return (
            <a
                href={href}
                className="block rounded-md transition-colors duration-150 ease-out hover:bg-bg-muted/50 -m-1 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
                {inner}
            </a>
        );
    }
    return inner;
}
