'use client';

import type { RiskMatrixBand } from '@/lib/risk-matrix/types';

/**
 * The score chip: a number on a tint of the tenant's own band colour.
 *
 * Three near-copies existed — the score column and the residual column in
 * `RisksClient`, and `BandChip` in `RiskAssessmentPanel`. They differed
 * only in padding, text size, whether the band name is spelled out, and
 * the test id, so the duplication was invisible to a reader and easy to
 * drift.
 *
 * ## Why the colour is inline and not a semantic token
 *
 * `band.color` is a per-tenant hex from `RiskMatrixConfig`. There is no
 * token for "whatever colour this tenant chose", so unlike the dashboard
 * heatmap — which tones by ORDINAL position through `resolveBandTone` and
 * therefore can use tokens — this chip has to render the configured colour
 * to be the band-recognition cue at all.
 *
 * ## Why the three visual roles are split (axe AA `color-contrast`)
 *
 * An earlier version used `band.color` for BOTH the tinted background and
 * the text, which collapsed the contrast ratio to ~2:1 — well under WCAG
 * AA's 4.5:1 for small text. The roles are now separated:
 *
 *   - background — `band.color` at 20% alpha, the band cue;
 *   - dot — solid `band.color`, a second higher-saturation cue that still
 *     reads when the tint is subtle;
 *   - text — `text-content-emphasis`, the app's designed-for-contrast
 *     neutral (~16:1 against either palette).
 *
 * Keep that split. Colouring the text by band is the exact regression this
 * shape exists to prevent.
 */
export function RiskBandChip({
    value,
    band,
    testId,
    showBandName = false,
    size = 'sm',
}: {
    /** The score to display — inherent or residual. */
    value: number;
    band: RiskMatrixBand;
    testId?: string;
    /** Spell out the band name beside the number (detail surfaces). */
    showBandName?: boolean;
    /** `sm` for dense table cells, `md` for the assessment panel. */
    size?: 'sm' | 'md';
}) {
    const sizing = size === 'md' ? 'px-2 py-0.5 text-sm' : 'px-1.5 py-0.5';
    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-md font-bold tabular-nums text-content-emphasis ${sizing}`}
            style={{ backgroundColor: `${band.color}33` /* 20% alpha */ }}
            data-band={band.name}
            {...(testId ? { 'data-testid': testId } : {})}
        >
            <span
                aria-hidden="true"
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: band.color }}
            />
            {showBandName ? `${value} · ${band.name}` : value}
        </span>
    );
}
