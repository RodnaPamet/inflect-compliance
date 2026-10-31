/**
 * #4770 — the FAIR fields a scenario override may patch, and what each one
 * measures.
 *
 * The page and the usecase both read this. The page uses it for the unit hint
 * beside the value and to refuse a value before sending it. The usecase uses
 * it to refuse the same value from any other caller. Without it the page
 * offered one bare input for a probability, a yearly frequency and an amount
 * of money, and the server stored whatever number arrived.
 *
 * Pure, with no imports, so a client component can hold it.
 */

export const SCENARIO_FAIR_FIELDS = [
    'threatEventFrequency', 'contactFrequency', 'probabilityOfAction',
    'vulnerabilityProbability', 'threatCapability', 'controlStrength',
    'primaryLossMagnitude', 'productivityLoss', 'responseCost', 'replacementCost',
    'secondaryLossEventFrequency', 'secondaryLossMagnitude',
] as const;

export type ScenarioFairField = (typeof SCENARIO_FAIR_FIELDS)[number];

/**
 * What a field's number means. The ranges follow `@/lib/fair-math`: a
 * frequency is events per year, a probability is 0..1 (the secondary loss
 * frequency is the share of loss events that also cause a secondary loss),
 * and a loss is an amount per event in the workspace's currency.
 *
 * Threat capability and control strength are read only as a ratio
 * (`tc / (tc + cs)`), so their scale is whatever the risk already uses: stored
 * risks carry both 0..1 and 1..10 values. An override is held to the scale of
 * the other one, and the only value refused is a negative one.
 */
export type ScenarioFieldUnit = 'perYear' | 'probability' | 'scale' | 'money';

export const SCENARIO_FIELD_UNIT: Readonly<Record<ScenarioFairField, ScenarioFieldUnit>> = {
    threatEventFrequency: 'perYear',
    contactFrequency: 'perYear',
    probabilityOfAction: 'probability',
    vulnerabilityProbability: 'probability',
    threatCapability: 'scale',
    controlStrength: 'scale',
    primaryLossMagnitude: 'money',
    productivityLoss: 'money',
    responseCost: 'money',
    replacementCost: 'money',
    secondaryLossEventFrequency: 'probability',
    secondaryLossMagnitude: 'money',
};

export function isScenarioFairField(field: unknown): field is ScenarioFairField {
    return typeof field === 'string' && (SCENARIO_FAIR_FIELDS as readonly string[]).includes(field);
}

/** Why an override value is refused, or `null` when it is accepted. */
export type ScenarioValueRefusal = 'NOT_A_NUMBER' | 'NEGATIVE' | 'PROBABILITY_RANGE';

export function scenarioValueRefusal(field: ScenarioFairField, value: number): ScenarioValueRefusal | null {
    if (!Number.isFinite(value)) return 'NOT_A_NUMBER';
    switch (SCENARIO_FIELD_UNIT[field]) {
        case 'probability':
            return value < 0 || value > 1 ? 'PROBABILITY_RANGE' : null;
        default:
            return value < 0 ? 'NEGATIVE' : null;
    }
}
