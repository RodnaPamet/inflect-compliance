/**
 * Zod schemas for the tenant-scoped risk-matrix config — Epic 44.
 *
 * Two passes:
 *   1. Per-field validation (type + range + format).
 *   2. Cross-field invariants (label-array length must match the
 *      declared dimensions; bands must cover [1, max*max] without
 *      gaps or overlaps).
 *
 * Both passes run before any write reaches the database. The DB also
 * enforces a CHECK on the dimension columns as a defence-in-depth
 * fallback against a write that bypasses the API (direct SQL,
 * sibling repositories, etc.).
 */

import { z } from 'zod';

import type { RiskMatrixBand } from './types';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const dimensionSchema = z
    .number()
    .int()
    .min(2, 'must be at least 2')
    .max(10, 'must be at most 10');

const axisTitleSchema = z.string().min(1).max(64);

const labelEntrySchema = z.string().min(1).max(64);

const bandSchema = z.object({
    name: z.string().min(1).max(32),
    minScore: z.number().int().min(1),
    maxScore: z.number().int().min(1),
    color: z.string().regex(HEX_COLOR, 'must be a hex colour like #22c55e'),
});

/**
 * Optional payload — every field is optional so an admin can patch
 * one slice (e.g. just the bands) without re-supplying the whole
 * shape. The full effective config is computed by merging this over
 * the canonical default in the usecase layer.
 */
export const updateRiskMatrixConfigSchema = z
    .object({
        likelihoodLevels: dimensionSchema.optional(),
        impactLevels: dimensionSchema.optional(),
        axisLikelihoodLabel: axisTitleSchema.optional(),
        axisImpactLabel: axisTitleSchema.optional(),
        levelLabels: z
            .object({
                likelihood: z.array(labelEntrySchema).min(2).max(10),
                impact: z.array(labelEntrySchema).min(2).max(10),
            })
            .optional()
            .nullable(),
        bands: z.array(bandSchema).min(1).max(8).optional(),
    })
    .strict();

export type UpdateRiskMatrixConfigPayload = z.infer<
    typeof updateRiskMatrixConfigSchema
>;

/**
 * One problem with a draft matrix, as a code and its values, so the admin page
 * can say it in the reader's language (#4823: it printed the English sentences
 * below, field names included). `validateBandsCoverage` and
 * `validateLevelLabelsLength` render the same issues as the server's English.
 */
export type RiskMatrixIssue =
    | { code: 'noBands' }
    | { code: 'firstBandStart'; got: number }
    | { code: 'bandReversed'; band: string; min: number; max: number }
    | { code: 'bandGapOverlap'; from: string; to: string; fromMax: number; toMin: number }
    | { code: 'lastBandEnd'; expected: number; got: number }
    | { code: 'likelihoodLabelCount'; got: number; expected: number }
    | { code: 'impactLabelCount'; got: number; expected: number };

/**
 * The ways `bands` fail to cover [1, maxScore] with no gaps and no overlaps
 * (empty when valid). Standalone so the usecase and the admin UI's pre-flight
 * preview both call it.
 */
export function bandCoverageIssues(
    bands: ReadonlyArray<RiskMatrixBand>,
    maxScore: number,
): RiskMatrixIssue[] {
    if (bands.length === 0) return [{ code: 'noBands' }];
    const issues: RiskMatrixIssue[] = [];
    const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
    if (sorted[0].minScore !== 1) issues.push({ code: 'firstBandStart', got: sorted[0].minScore });
    for (let i = 0; i < sorted.length; i += 1) {
        const cur = sorted[i];
        if (cur.minScore > cur.maxScore) {
            issues.push({ code: 'bandReversed', band: cur.name, min: cur.minScore, max: cur.maxScore });
        }
        if (i > 0) {
            const prev = sorted[i - 1];
            if (cur.minScore !== prev.maxScore + 1) {
                issues.push({ code: 'bandGapOverlap', from: prev.name, to: cur.name, fromMax: prev.maxScore, toMin: cur.minScore });
            }
        }
    }
    const last = sorted[sorted.length - 1];
    if (last.maxScore !== maxScore) issues.push({ code: 'lastBandEnd', expected: maxScore, got: last.maxScore });
    return issues;
}

/** The ways `levelLabels`, when supplied, disagree with the dimensions. */
export function levelLabelIssues(opts: {
    levelLabels?: { likelihood: readonly string[]; impact: readonly string[] } | null;
    likelihoodLevels: number;
    impactLevels: number;
}): RiskMatrixIssue[] {
    const issues: RiskMatrixIssue[] = [];
    if (!opts.levelLabels) return issues;
    if (opts.levelLabels.likelihood.length !== opts.likelihoodLevels) {
        issues.push({ code: 'likelihoodLabelCount', got: opts.levelLabels.likelihood.length, expected: opts.likelihoodLevels });
    }
    if (opts.levelLabels.impact.length !== opts.impactLevels) {
        issues.push({ code: 'impactLabelCount', got: opts.levelLabels.impact.length, expected: opts.impactLevels });
    }
    return issues;
}

/** An issue as the server's English sentence (the API's 400 message). */
export function describeRiskMatrixIssue(issue: RiskMatrixIssue): string {
    switch (issue.code) {
        case 'noBands':
            return 'At least one band is required.';
        case 'firstBandStart':
            return `First band must start at score 1 (got ${issue.got}).`;
        case 'bandReversed':
            return `Band "${issue.band}" has minScore (${issue.min}) > maxScore (${issue.max}).`;
        case 'bandGapOverlap':
            return `Bands "${issue.from}" → "${issue.to}" have a gap or overlap at score ${issue.fromMax}/${issue.toMin}.`;
        case 'lastBandEnd':
            return `Last band must end at score ${issue.expected} (got ${issue.got}). Bands must cover the full likelihood × impact range.`;
        case 'likelihoodLabelCount':
            return `levelLabels.likelihood has ${issue.got} entries; expected ${issue.expected}.`;
        case 'impactLabelCount':
            return `levelLabels.impact has ${issue.got} entries; expected ${issue.expected}.`;
    }
}

/**
 * Validate that `bands` cover [1, maxScore] with no gaps and no
 * overlaps. Returns a list of human-readable issues (empty when
 * valid), in English, for the server's refusal.
 */
export function validateBandsCoverage(
    bands: ReadonlyArray<RiskMatrixBand>,
    maxScore: number,
): string[] {
    return bandCoverageIssues(bands, maxScore).map(describeRiskMatrixIssue);
}

/**
 * Validate that, IF `levelLabels` is supplied, the per-axis array
 * lengths match the declared dimensions. Returns a list of human-
 * readable issues (empty when valid), in English.
 */
export function validateLevelLabelsLength(opts: {
    levelLabels?: { likelihood: readonly string[]; impact: readonly string[] } | null;
    likelihoodLevels: number;
    impactLevels: number;
}): string[] {
    return levelLabelIssues(opts).map(describeRiskMatrixIssue);
}
