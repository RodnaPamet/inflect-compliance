'use client';
/**
 * Shared readiness score ring + threshold legend.
 *
 * Extracted during the audit-hub unification so the cycle list and the
 * per-cycle readiness report render the SAME visual with the SAME colour
 * bands. `<ReadinessLegend>` is the in-context explanation the score never
 * had.
 *
 * HISTORY, because this comment was wrong and the wrongness mattered. It used
 * to describe `/audits/readiness` as "now-removed". That page is live: it was
 * a redirect shim to `/audits/cycles`, and it came back (see
 * `audits/readiness/page.tsx`) as the one surface that answers "how ready am I
 * across every framework at once" — the cycle list answers per-cycle and
 * cannot roll up. Its return is also what reintroduced four copies of the
 * 80/50 thresholds, because the comment said the page it would have copied
 * from no longer existed.
 *
 * The bands themselves now live in `@/lib/readiness/bands` — one definition,
 * with a per-vocabulary map. This file consumes the CSS-variable vocabulary;
 * it does not know what 80 and 50 are, which is the point.
 */
import { readinessBand, READINESS_BAND_COLOR_VAR } from '@/lib/readiness/bands';

/**
 * Token, not hex.
 *
 * This shipped `#22c55e` / `#eab308` / `#ef4444` — three raw literals in a
 * file the chart-token ratchet could not see, because that ratchet works off
 * an explicit file list. The tokens resolve per theme, so a light/dark flip
 * re-tones the ring instead of leaving it at one hardcoded emerald.
 */
function bandColor(score: number): string {
    return READINESS_BAND_COLOR_VAR[readinessBand(score)];
}

export function ReadinessScoreRing({
    score,
    size = 96,
    noScoreLabel,
    ariaLabel,
}: {
    /** Undefined when the cycle has no computed score yet. */
    score?: number;
    size?: number;
    noScoreLabel: string;
    ariaLabel: string;
}) {
    if (score === undefined) {
        return (
            <div
                className="rounded-full bg-bg-elevated/50 flex items-center justify-center text-content-subtle"
                style={{ width: size, height: size }}
                role="img"
                aria-label={noScoreLabel}
            >
                –
            </div>
        );
    }
    const r = (size - 8) / 2;
    const c = 2 * Math.PI * r;
    const offset = c - (score / 100) * c;
    return (
        <svg width={size} height={size} className="transform -rotate-90" role="img" aria-label={ariaLabel}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="6" />
            <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={bandColor(score)}
                strokeWidth="6"
                strokeDasharray={c}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className="transition-all duration-1000"
            />
            <text
                x={size / 2}
                y={size / 2}
                textAnchor="middle"
                dominantBaseline="central"
                className="transform rotate-90 origin-center"
                fill="var(--content-emphasis)"
                fontSize={size / 3.5}
                fontWeight="bold"
            >
                {score}
            </text>
        </svg>
    );
}

export interface ReadinessLegendLabels {
    title: string;
    green: string;
    amber: string;
    red: string;
}

/** Legend explaining the green/amber/red readiness bands. */
export function ReadinessLegend({ labels }: { labels: ReadinessLegendLabels }) {
    // Same three tokens the ring paints — the legend explains the ring, so it
    // must not be able to disagree with it.
    const rows: { text: string; color: string }[] = [
        { text: labels.green, color: READINESS_BAND_COLOR_VAR.ready },
        { text: labels.amber, color: READINESS_BAND_COLOR_VAR.nearly },
        { text: labels.red, color: READINESS_BAND_COLOR_VAR.atRisk },
    ];
    return (
        <div className="space-y-tight">
            <p className="font-medium text-content-default">{labels.title}</p>
            <ul className="space-y-tight">
                {rows.map((row) => (
                    <li key={row.color} className="flex items-center gap-tight">
                        <span
                            className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: row.color }}
                            aria-hidden="true"
                        />
                        <span>{row.text}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
