/**
 * A sparkline drawn in block characters.
 *
 * Deliberately NOT the SVG chart stack. This renders inside a table cell
 * and beside inline text, where a real chart would need a fixed height and
 * a layout box; it also survives copy-paste into a ticket, which is how
 * these rows usually get discussed. `mini-area-chart` remains the right
 * answer anywhere there is room to draw.
 *
 * Extracted from two character-identical copies — `risks/kri/page.tsx` and
 * `[riskId]/RiskHistoryPanel.tsx` — that had already drifted to the point
 * of being invisible to a reader: same eight glyphs, same normalisation,
 * same off-by-one guard, duplicated in full.
 */

/** Eight levels, low → high. */
const SPARK = '▁▂▃▄▅▆▇█';

/**
 * Render `values` as a block-character sparkline.
 *
 * Returns an em-dash for an empty series — the honest "no data" rendering,
 * not a flat baseline, which would read as "measured, and unchanging".
 *
 * A flat series (every value equal) renders at the LOW glyph rather than
 * dividing by a zero span. That is a deliberate choice: a flat line at the
 * bottom says "no variation" without implying the values are small or
 * large, which a mid or high glyph would.
 */
export function sparkline(values: readonly number[]): string {
    if (values.length === 0) return '—';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values
        .map((v) => {
            const idx = Math.floor(((v - min) / span) * (SPARK.length - 1));
            // Clamp: a value equal to `max` computes exactly SPARK.length-1,
            // but floating-point drift on the division can overshoot.
            return SPARK[Math.min(SPARK.length - 1, Math.max(0, idx))];
        })
        .join('');
}
