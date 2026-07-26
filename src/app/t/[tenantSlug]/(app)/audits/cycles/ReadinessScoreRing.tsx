'use client';
/**
 * Shared readiness score ring + threshold legend.
 *
 * Extracted during the audit-hub unification so the score ring that
 * used to live only on the (now-removed) `/audits/readiness` overview
 * moves into the unified cycle list AND the per-cycle readiness report
 * render the SAME visual with the SAME 80/50 colour bands. The bands
 * were previously undocumented magic numbers duplicated in two files;
 * `<ReadinessLegend>` is the in-context explanation the score never had.
 */

/** Colour band for a readiness score. 80+ ready, 50-79 nearly there, <50 at risk. */
function bandColor(score: number): string {
    return score >= 80 ? '#22c55e' : score >= 50 ? '#eab308' : '#ef4444';
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

/** Legend explaining the 80/50 green/amber/red readiness bands. */
export function ReadinessLegend({ labels }: { labels: ReadinessLegendLabels }) {
    const rows: { text: string; color: string }[] = [
        { text: labels.green, color: '#22c55e' },
        { text: labels.amber, color: '#eab308' },
        { text: labels.red, color: '#ef4444' },
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
