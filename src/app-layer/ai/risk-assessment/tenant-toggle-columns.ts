/**
 * The one place that says which database column backs which AI switch.
 *
 * Two modules need this mapping and they sit on opposite sides of an import
 * cycle: `feature-gate` ENFORCES the toggles, `usecases/ai-feature-toggles`
 * reads and writes them and needs the gate's env helpers to report what the
 * deploy permits. Neither can import the other's copy.
 *
 * The alternative — a map in each — is the failure mode where one is renamed
 * and the other keeps compiling. A Prisma column rename would leave the gate
 * reading a field that no longer exists while the admin page happily wrote the
 * new one, and the gate's `catch` would turn that into "AI availability could
 * not be confirmed" for every request: a total AI outage whose cause is a
 * string literal in a file nobody edited.
 *
 * `tests/unit/ai-feature-toggle-columns-exist.test.ts` pins these names against
 * `prisma/schema/auth.prisma`, so the rename fails a test instead.
 *
 * The TYPE import below is erased at compile time, so this module adds no
 * runtime edge back to `feature-gate` and the cycle stays broken.
 *
 * @module ai/risk-assessment/tenant-toggle-columns
 */
import type { AiFeature } from './feature-gate';

/** The master switch plus one key per `AiFeature`. */
export const AI_TOGGLE_KEYS = ['ai', 'risk', 'assistant', 'questionnaire'] as const;

export type AiToggleKey = (typeof AI_TOGGLE_KEYS)[number];

/**
 * `TenantSecuritySettings` column per key.
 *
 * Typed `Record<AiToggleKey, ...>` so adding a value to `AiFeature` without a
 * column here is a compile error — every feature the gate can be asked about
 * must have a tenant switch, or the gate would silently stop checking one.
 */
export const AI_TOGGLE_COLUMN: Readonly<Record<AiToggleKey, string>> = {
    ai: 'aiEnabled',
    risk: 'aiRiskSuggestionsEnabled',
    assistant: 'aiAssistantEnabled',
    questionnaire: 'aiQuestionnaireEnabled',
};

/** The tenant-level master switch — off refuses every feature. */
export const AI_MASTER_COLUMN = AI_TOGGLE_COLUMN.ai;

/** Column for a feature the gate was asked about. */
export function columnForFeature(feature: AiFeature): string {
    return AI_TOGGLE_COLUMN[feature];
}
