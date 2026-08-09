import type { ComboboxOption } from '@/components/ui/combobox';
import {
    TREATMENT_DECISION_VALUES,
    TREATMENT_DECISION_META,
    type TreatmentDecisionValue,
} from '@/lib/risk-treatment-vocabulary';

// Re-export the shared vocabulary so existing UI imports keep resolving
// from `_shared/risk-options` while the mapping stays single-sourced in
// `@/lib/risk-treatment-vocabulary`.
export {
    TREATMENT_DECISION_VALUES,
    TREATMENT_DECISION_META,
    DECISION_TO_STRATEGY,
    canonicalTreatmentLabelEN,
} from '@/lib/risk-treatment-vocabulary';
export type {
    TreatmentDecisionValue,
    TreatmentStrategyValue,
} from '@/lib/risk-treatment-vocabulary';

/**
 * Shared risk-treatment decision options in the canonical vocabulary.
 * VALUES remain `TreatmentDecision` (enum-valid for `Risk.treatment`);
 * LABELS are the canonical Mitigate/Accept/Transfer/Avoid words so the
 * create modal, the detail edit modal, and the guided Step 4 read
 * identically. `t = useTranslations('risks')`.
 */
export function buildRiskTreatmentOptions(t: (key: string) => string): ComboboxOption[] {
    return TREATMENT_DECISION_VALUES.map((value) => ({
        value,
        label: t(TREATMENT_DECISION_META[value].labelKey),
    }));
}

/**
 * The RiskStatus enum members, in workflow order. Single-sourced here
 * so the detail status combobox, the list badge, and the filter all
 * offer the same set.
 */
export const RISK_STATUS_VALUES = [
    'OPEN',
    'MITIGATING',
    'MITIGATED',
    'ACCEPTED',
    'CLOSED',
] as const;

export type RiskStatusValue = (typeof RISK_STATUS_VALUES)[number];

// RiskStatus enum → the `risks.bulkStatus.*` i18n key. The filter already
// localizes status this way; the detail combobox + list badge now reuse it
// so OPEN/MITIGATING/… never render raw again.
const RISK_STATUS_LABEL_KEYS: Record<RiskStatusValue, string> = {
    OPEN: 'bulkStatus.open',
    MITIGATING: 'bulkStatus.mitigating',
    MITIGATED: 'bulkStatus.mitigated',
    ACCEPTED: 'bulkStatus.accepted',
    CLOSED: 'bulkStatus.closed',
};

/**
 * Localized label for a persisted `Risk.status` value. `t =
 * useTranslations('risks')`. Falls back to the raw value for any
 * unknown status so the surface never blanks.
 */
export function riskStatusLabel(t: (key: string) => string, status: string): string {
    const key = RISK_STATUS_LABEL_KEYS[status as RiskStatusValue];
    return key ? t(key) : status;
}

/** Localized `{ value, label }` options for the status combobox. */
export function buildRiskStatusOptions(
    t: (key: string) => string,
): ComboboxOption[] {
    return RISK_STATUS_VALUES.map((value) => ({ value, label: riskStatusLabel(t, value) }));
}

/**
 * Canonical label for a persisted `Risk.treatment` value, for read-only
 * display (Overview, list table). Returns `null` for an unknown/empty
 * value so callers can fall back to their own "untreated" copy.
 */
export function canonicalTreatmentLabel(
    t: (key: string) => string,
    decision: string | null | undefined,
): string | null {
    if (!decision) return null;
    const meta = TREATMENT_DECISION_META[decision as TreatmentDecisionValue];
    return meta ? t(meta.labelKey) : decision;
}

/**
 * The risk-category vocabulary.
 *
 * B2-7 — declared twice before this: once in `NewRiskModal` and once in
 * `[riskId]/page.tsx`, with the same eight values in a different line
 * layout. Two copies of a picker's option list drift silently — a category
 * added to the create modal but not the edit page means a risk you can
 * create but cannot re-select the category of.
 *
 * Deliberately NOT localised. These are stored verbatim in `Risk.category`
 * and filtered on as literal strings, so translating the label would either
 * break the filter or write a translated value into the column. If they
 * ever need localising, the stored value and the display label have to
 * separate first.
 */
export const RISK_CATEGORIES = [
    'Technical',
    'Operational',
    'Compliance',
    'Strategic',
    'Financial',
    'Reputational',
    'Physical',
    'Human Resources',
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** `RISK_CATEGORIES` as `<Combobox>` options — value and label are identical. */
export const RISK_CATEGORY_OPTIONS: ComboboxOption[] = RISK_CATEGORIES.map((c) => ({
    value: c,
    label: c,
}));
