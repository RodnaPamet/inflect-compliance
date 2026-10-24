"use client";

/**
 * `<FreshnessBadge>` — recency indicator for any timestamped artefact.
 *
 * Maps a `lastRefreshedAt` Date (or any equivalent — the spec calls
 * it that, but the prop is intentionally generic so callers can pass
 * `updatedAt`, `dateCollected`, or a future dedicated column without
 * a rename) onto the standard green / amber / red severity scale:
 *
 *   - **Fresh** (green) when the artefact was last refreshed within
 *     the warn threshold (default 30 days)
 *   - **Stale** (amber) between warn and stale thresholds (default
 *     30–90 days)
 *   - **Outdated** (red) past the stale threshold (default 90+ days)
 *
 * Lives at the primitive layer so the same badge powers the evidence
 * list + gallery (Epic 43.2), the policy detail page's "next review"
 * status (future), and any audit-ready surface where age matters.
 *
 * Why these defaults: 30 / 90 days mirrors the
 * `nextReviewDate` cadences operators already use ("monthly",
 * "quarterly") and the existing retention "Expiring (≤30d)" warning
 * threshold. They can be overridden per-call when a domain wants
 * tighter tolerances (e.g. SOX-relevant evidence may want 7 / 30).
 */

import { Activity } from 'lucide-react';

import { useTranslations } from 'next-intl';
import {
    resolveFreshness,
    type FreshnessLevel,
} from './freshness';

interface FreshnessBadgeProps {
    /** Reference timestamp. ISO string OR Date. `null` / undefined → "No refresh recorded". */
    lastRefreshedAt: string | Date | null | undefined;
    /**
     * Days threshold for the green→amber transition. Default 30.
     */
    warnAfterDays?: number;
    /**
     * Days threshold for the amber→red transition. Default 90.
     * Must be >= `warnAfterDays`.
     */
    staleAfterDays?: number;
    /**
     * "Now" anchor. Defaults to `new Date()`. Tests pass an explicit
     * value so the freshness is deterministic; pages typically pass
     * the result of `useHydratedNow()` to avoid hydration mismatch.
     */
    now?: Date | null;
    /** Compact form drops the trailing label, leaves just dot + age. */
    compact?: boolean;
    className?: string;
    'data-testid'?: string;
}

// Colour pairs use the semantic status tokens
// (`text-content-{success,warning,error}`) rather than raw Tailwind
// emerald/amber/rose scales so each theme's tokens.css governs the
// contrast. Both themes have already had these tokens contrast-tuned
// (GAP-CI-77) to clear WCAG AA 4.5:1 against the alpha-blended
// `bg-{success,warning,error}` tints sitting over `bg-default`.
const LEVEL_STYLES: Record<
    FreshnessLevel,
    { dot: string; text: string; bg: string; border: string; label: string }
> = {
    fresh: {
        dot: 'bg-bg-success-emphasis',
        text: 'text-content-success',
        bg: 'bg-success',
        border: 'border-success',
        label: 'Fresh',
    },
    stale: {
        dot: 'bg-bg-warning-emphasis',
        text: 'text-content-warning',
        bg: 'bg-warning',
        border: 'border-warning',
        label: 'Stale',
    },
    outdated: {
        dot: 'bg-bg-error-emphasis',
        text: 'text-content-error',
        bg: 'bg-error',
        border: 'border-error',
        label: 'Outdated',
    },
    unknown: {
        dot: 'bg-content-subtle',
        text: 'text-content-muted',
        bg: 'bg-bg-muted',
        border: 'border-border-default',
        label: 'No refresh recorded',
    },
};

/**
 * Pretty-print "n days/months ago" — short form that fits in a badge.
 */
function ageLabel(days: number): string {
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
}

export function FreshnessBadge({
    lastRefreshedAt,
    warnAfterDays = 30,
    staleAfterDays = 90,
    now,
    compact = false,
    className = '',
    'data-testid': dataTestId,
}: FreshnessBadgeProps) {
    const t = useTranslations('common.ui');
    const result = resolveFreshness(lastRefreshedAt, {
        warnAfterDays,
        staleAfterDays,
        now,
    });
    const { level, ageDays } = result;
    const style = LEVEL_STYLES[level];

    // Native `title=` carries the threshold context to mouse / focus
    // users without forcing every consumer (or every test) to wire up
    // a Radix TooltipProvider just to render a single badge. The
    // aria-label gives screen readers the level + age first.
    const titleContent =
        level === 'unknown'
            ? 'No refresh timestamp on this evidence.'
            : `Last refreshed ${ageLabel(ageDays!)}. Threshold: green <${warnAfterDays}d, amber <${staleAfterDays}d, red ${staleAfterDays}d+.`;

    return (
        <span
            role="status"
            aria-label={
                ageDays !== null
                    ? t('freshnessLabelWithAge', { label: style.label, age: ageLabel(ageDays) })
                    : t('freshnessLabel', { label: style.label })
            }
            title={titleContent}
            data-freshness={level}
            data-testid={dataTestId}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${style.text} ${style.bg} ${style.border} ${className}`.trim()}
        >
            <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
                aria-hidden
            />
            {compact ? (
                <span>{ageDays === null ? '—' : ageLabel(ageDays)}</span>
            ) : (
                <>
                    <Activity size={12} aria-hidden />
                    <span>{style.label}</span>
                    {ageDays !== null && (
                        <span className="text-content-muted">
                            · {ageLabel(ageDays)}
                        </span>
                    )}
                </>
            )}
        </span>
    );
}
