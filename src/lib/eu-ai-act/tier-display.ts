/**
 * How a stored EU AI Act tier is toned wherever it is shown — one table, so
 * the AI-system register and the agent register cannot disagree about it.
 *
 * Keyed on `StoredAiRiskTier`, exhaustively: a tier added to the column without
 * a tone here is a compile error, not a badge that silently falls back to
 * MINIMAL's neutral. UNCLASSIFIED (#3691) is a warning precisely because it is
 * not minimal: nobody has classified the system yet.
 *
 * Tones only, no UI import — each value is a valid `StatusBadgeVariant`.
 */
import type { StoredAiRiskTier } from './classification';

export type AiActTierTone = 'error' | 'warning' | 'neutral';

export const AI_ACT_TIER_TONE: Readonly<Record<StoredAiRiskTier, AiActTierTone>> = {
    UNCLASSIFIED: 'warning',
    PROHIBITED: 'error',
    HIGH: 'error',
    LIMITED: 'warning',
    MINIMAL: 'neutral',
};

/** The tone for a stored value; an unknown one is a warning, never neutral. */
export function aiActTierTone(tier: string): AiActTierTone {
    return (AI_ACT_TIER_TONE as Record<string, AiActTierTone>)[tier] ?? 'warning';
}

/**
 * Is this stored value a tier the catalogue labels
 * (`risks.aiSystems.filterEnums.riskTier.*`)? Callers show the label when it
 * is and the stored value when it is not, so an unknown tier is never shown
 * as a missing-key path (#4638).
 */
export function isKnownAiActTier(tier: string): tier is StoredAiRiskTier {
    return Object.prototype.hasOwnProperty.call(AI_ACT_TIER_TONE, tier);
}
