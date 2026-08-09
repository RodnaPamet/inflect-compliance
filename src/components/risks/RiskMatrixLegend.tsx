"use client";

/**
 * `<RiskMatrixLegend>` — band → colour swatches for the matrix.
 *
 * Epic 44.2 primitive. Reads the same `RiskMatrixConfigShape` the
 * cell does; whatever bands the tenant has configured (Low/Medium/
 * High/Critical by default, but a tenant could ship a 3-band or
 * 6-band layout) round-trip cleanly to the legend without a
 * renderer change.
 *
 * Two layouts:
 *   - `horizontal` (default) — chips on one row, used under the
 *     matrix card.
 *   - `vertical` — chips stacked, useful in a sidebar / drawer.
 *
 * Each chip exposes:
 *   - the band's colour swatch
 *   - the band's display name
 *   - (optional, default-on) the score range the band covers
 *
 * Accessibility: the legend is wrapped in `role="list"` / `role="listitem"`
 * so screen readers read it as a discrete grouping rather than a wall
 * of decorative chips.
 */

import { useTranslations } from 'next-intl';
import {
    bandRangeLabel,
} from '@/lib/risk-matrix/scoring';
import type {
    RiskMatrixBand,
    RiskMatrixConfigShape,
} from '@/lib/risk-matrix/types';

export interface RiskMatrixLegendProps {
    /** Effective config (or a bands-only subset for embedded usage). */
    config: Pick<RiskMatrixConfigShape, 'bands'>;
    /** Show "1–4" alongside band names. Default: true. */
    showRanges?: boolean;
    /** Layout direction. */
    orientation?: 'horizontal' | 'vertical';
    className?: string;
    'data-testid'?: string;
}

export function RiskMatrixLegend({
    config,
    showRanges = true,
    orientation = 'horizontal',
    className = '',
    'data-testid': dataTestId = 'risk-matrix-legend',
}: RiskMatrixLegendProps) {
    const t = useTranslations('common.chart');
    const bands = config.bands ?? [];
    if (bands.length === 0) {
        return (
            <div
                role="status"
                className={`text-xs text-content-muted ${className}`.trim()}
                data-testid={dataTestId}
            >
                {t('severityBandsEmpty')}
            </div>
        );
    }
    return (
        <ul
            role="list"
            aria-label={t('severityLegendAria')}
            data-testid={dataTestId}
            className={[
                'flex',
                orientation === 'vertical'
                    ? 'flex-col gap-1.5'
                    : 'flex-wrap items-center justify-center gap-compact',
                className,
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {bands.map((band) => (
                <LegendChip
                    key={`${band.name}-${band.minScore}`}
                    band={band}
                    showRange={showRanges}
                />
            ))}
        </ul>
    );
}

// ─── Chip ───────────────────────────────────────────────────────────

function LegendChip({
    band,
    showRange,
}: {
    band: RiskMatrixBand;
    showRange: boolean;
}) {
    const range = bandRangeLabel(band);
    return (
        <li
            role="listitem"
            data-testid={`risk-matrix-legend-chip-${band.name.toLowerCase()}`}
            className="inline-flex items-center gap-1.5 text-[10px] text-content-muted"
        >
            <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: band.color }}
            />
            <span className="text-content-default">{band.name}</span>
            {showRange && (
                <span className="text-content-subtle tabular-nums">
                    {range}
                </span>
            )}
        </li>
    );
}
