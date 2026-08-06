'use client';

import { Heading } from '@/components/ui/typography';
import type { CellCollision } from '@/lib/risk-collisions';

/**
 * RQ3-5 — range-compression callouts: the same cell collisions the heatmap
 * flags, spelled out in words, with a click that drills into that cell.
 *
 * Extracted from `RisksClient` so the drill-down contract can be asserted by
 * clicking it (`tests/rendered/risk-collision-callouts.test.tsx`) rather than
 * by slicing a byte window out of the enclosing file — which is what
 * `rq3-5-histograms` used to do.
 *
 * THE CONTRACT THAT MATTERS: the click filters by CELL (`L{l}xI{i}`), never
 * by score. A score is a product shared by many cells — `L1×I6` and `L2×I3`
 * are both 6 — so filtering by score would show the user rows from cells they
 * never clicked on, in a register whose entire purpose is "these two risks
 * sit in the same box and are priced 40× apart".
 */
export function RiskCollisionCallouts({
    collisions,
    money,
    title,
    description,
    onDrillToCell,
}: {
    collisions: readonly CellCollision[];
    money: (v: number | null | undefined) => string;
    title: string;
    description: string;
    /** Receives the canonical `L{likelihood}xI{impact}` cell token. */
    onDrillToCell: (cellToken: string) => void;
}) {
    if (collisions.length === 0) return null;

    return (
        <div data-testid="risk-collision-callouts">
            <Heading level={3} className="mb-1">{title}</Heading>
            <p className="mb-tight text-xs text-content-subtle">{description}</p>
            <div className="space-y-tight">
                {collisions.map((c) => (
                    <button
                        key={`${c.likelihood}-${c.impact}`}
                        type="button"
                        className="flex w-full items-center justify-between gap-default rounded p-2 text-left text-sm hover:bg-bg-muted/50 transition-colors duration-100 ease-out"
                        data-testid={`risk-collision-${c.likelihood}-${c.impact}`}
                        onClick={() => onDrillToCell(`L${c.likelihood}xI${c.impact}`)}
                    >
                        <span className="truncate text-content-emphasis">
                            L{c.likelihood}×I{c.impact}: {c.minRisk.title} vs {c.maxRisk.title}
                        </span>
                        <span className="shrink-0 tabular-nums text-content-muted">
                            {money(c.minRisk.ale)} vs {money(c.maxRisk.ale)} (~{Math.round(c.ratio)}×)
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
