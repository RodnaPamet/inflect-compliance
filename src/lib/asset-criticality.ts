/**
 * Asset-criticality scoring — derives a single criticality level from the
 * Confidentiality / Integrity / Availability triad. Shared by the
 * create/edit modals (slider box), the detail Overview (single score),
 * the assets table Criticality column, AND the server-side create/update
 * usecase (which persists the derived level onto `Asset.criticality` so
 * the KPI, filter, and detail chip all read one consistent value).
 *
 * This module is intentionally pure TypeScript (no React, no 'use client')
 * so both the client form components and the server usecase can import it.
 * The client `_form/asset-criticality.ts` re-exports it so existing import
 * paths stay stable.
 *
 * Aggregation model (item 25, 2026-06-14):
 *   - **Critical override.** If ANY single dimension is at the ceiling
 *     (5), the asset is Critical regardless of the other two — a 5/1/1
 *     asset is still Critical. This is the one case where the old
 *     "high-water-mark" behaviour is intentionally preserved.
 *   - **Top-two mean otherwise.** Below the ceiling, the level is banded
 *     from the mean of the two HIGHEST dimensions. A single elevated
 *     dimension no longer drags the whole asset up: 4/1/1 reads Medium,
 *     not High — it takes two elevated dimensions to raise the band.
 *
 * The previous rule was `Math.max(C, I, A)`, which let a lone high
 * dimension dominate (4/1/1 → High). See
 * `tests/guards/item-25-weighted-criticality.test.ts` for the ratchet
 * that locks the new behaviour in.
 */
export type AssetCriticalityTone = 'success' | 'warning' | 'danger' | 'critical';

/** The Prisma `Criticality` enum members (kept in sync with enums.prisma). */
export type CriticalityEnum = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** The dimension value (on the 1–5 scale) that counts as "Critical". */
export const CRITICALITY_CEILING = 5;

export function getAssetCriticality(
    confidentiality: number,
    integrity: number,
    availability: number,
): { score: number; label: string; tone: AssetCriticalityTone } {
    const dims = [confidentiality, integrity, availability];
    const peak = Math.max(...dims);

    // Critical override — a single ceiling dimension keeps the asset
    // Critical even when the other two are minimal.
    if (peak >= CRITICALITY_CEILING) {
        return { score: CRITICALITY_CEILING, label: 'Critical', tone: 'critical' };
    }

    // Otherwise band from the mean of the two highest dimensions, rounded
    // to a single integer so the displayed number always matches the
    // label (no fractional 2.5-vs-Medium mismatch).
    const [hi, mid] = [...dims].sort((x, y) => y - x);
    const score = Math.round((hi + mid) / 2);

    if (score >= 4) return { score, label: 'High', tone: 'danger' };
    if (score >= 3) return { score, label: 'Medium', tone: 'warning' };
    return { score, label: 'Low', tone: 'success' };
}

/** Map a criticality label to the Prisma `Criticality` enum member. */
const LABEL_TO_ENUM: Record<string, CriticalityEnum> = {
    Low: 'LOW',
    Medium: 'MEDIUM',
    High: 'HIGH',
    Critical: 'CRITICAL',
};

/**
 * Derive the persisted `Criticality` enum value from the C/I/A triad.
 * Uses the SAME banding as `getAssetCriticality`, so the stored enum
 * agrees with every rendered badge. Called at create/update time by
 * `src/app-layer/usecases/asset.ts`.
 */
export function criticalityToEnum(
    confidentiality: number,
    integrity: number,
    availability: number,
): CriticalityEnum {
    return LABEL_TO_ENUM[getAssetCriticality(confidentiality, integrity, availability).label];
}

/**
 * Present the STORED `Asset.criticality` enum — the inverse of
 * `criticalityToEnum`, sharing its table so the two cannot drift.
 *
 * Read surfaces should use this rather than re-deriving from the C/I/A
 * triad. The stored enum is what the list filter (`where.criticality`) and
 * the dashboard KPI (`count({ criticality: { in: ['HIGH','CRITICAL'] } })`)
 * query in SQL; a cell that recomputes its own answer from the triad can
 * disagree with the filter that selected the row — a user filtering to
 * "HIGH" would see a row whose badge reads something else. Derivation
 * belongs on the WRITE path (`criticalityToEnum` at create/update), which
 * is the only place that sees the whole triad at once.
 *
 * `rank` orders the bands for a table sort: monotonic in severity, so
 * sorting on it keeps the bands contiguous and in true severity order.
 */
export const CRITICALITY_PRESENTATION: Record<
    CriticalityEnum,
    { label: string; tone: AssetCriticalityTone; rank: number }
> = {
    LOW: { label: 'Low', tone: 'success', rank: 1 },
    MEDIUM: { label: 'Medium', tone: 'warning', rank: 2 },
    HIGH: { label: 'High', tone: 'danger', rank: 3 },
    CRITICAL: { label: 'Critical', tone: 'critical', rank: 4 },
};

/** Narrow an unvalidated stored value to a presentable band, or null. */
export function presentCriticality(value: string | null | undefined) {
    if (!value) return null;
    return CRITICALITY_PRESENTATION[value as CriticalityEnum] ?? null;
}

// Four distinct visual steps: green → amber → red → strong-red. HIGH
// (danger) is deliberately distinct from MEDIUM (warning), and CRITICAL
// is the strongest (error-emphasis fill).
export const ASSET_CRITICALITY_TONE_CLASSES: Record<AssetCriticalityTone, string> = {
    success: 'border-border-success bg-bg-success text-content-success',
    warning: 'border-border-warning bg-bg-warning text-content-warning',
    danger: 'border-border-error bg-bg-error text-content-error',
    critical: 'border-border-error bg-bg-error-emphasis text-content-emphasis',
};
