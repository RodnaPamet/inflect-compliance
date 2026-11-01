/**
 * Where a workspace's "critical" starts (#4846): the lowest score of its
 * HIGHEST severity band.
 *
 * The organization portfolio counted a risk as critical at a fixed
 * `inherentScore >= 15`, the top band of the default 5 x 5 grid. A workspace
 * sets its own matrix (Admin -> Risk matrix), so a 3 x 3 grid (maximum score
 * 9) never had a critical risk there, and a workspace whose top band starts at
 * 12 showed fewer than its own heat map. Owner decision (2026-11-01): a risk
 * is critical when its score is in its own workspace's highest band, and the
 * dashboard figure and the drill-down list both use that.
 *
 * Pure, and defensive about the stored JSON: bands are read from a `Json`
 * column, so anything that is not a band is ignored, and a workspace with no
 * readable band falls back to the default grid's top band, as the matrix
 * config read does (`DEFAULT_RISK_MATRIX_CONFIG.bands`).
 */
import { DEFAULT_BANDS } from './defaults';

interface ScoreRange {
    minScore: number;
    maxScore: number;
}

function isScoreRange(value: unknown): value is ScoreRange {
    if (!value || typeof value !== 'object') return false;
    const { minScore, maxScore } = value as Record<string, unknown>;
    return (
        typeof minScore === 'number' &&
        typeof maxScore === 'number' &&
        Number.isFinite(minScore) &&
        Number.isFinite(maxScore) &&
        minScore <= maxScore
    );
}

/** The top band of a list: the one reaching the highest score. */
function topBand(bands: readonly ScoreRange[]): ScoreRange | null {
    let top: ScoreRange | null = null;
    for (const band of bands) {
        if (!top || band.maxScore > top.maxScore || (band.maxScore === top.maxScore && band.minScore > top.minScore)) {
            top = band;
        }
    }
    return top;
}

/** The lowest inherent score that counts as critical for these bands. */
export function criticalScoreFloor(bands: unknown): number {
    const readable = Array.isArray(bands) ? bands.filter(isScoreRange) : [];
    const top = topBand(readable) ?? topBand(DEFAULT_BANDS);
    // DEFAULT_BANDS is a non-empty constant, so `top` is never null here.
    return top ? top.minScore : 15;
}
