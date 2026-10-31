/**
 * RQ2-7 — FAIR calibration aids (pure).
 *
 * Martin-Vegue's calibration discipline applied to the RQ-1 FAIR
 * inputs: raw floats get three kinds of feedback, none of which
 * ever blocks a save —
 *
 *   reflections — plain-language mirror of what the number MEANS
 *     ("TEF 0.1 ≈ one threat event every 10 years"), rendered live
 *     beside the input so a typo'd order of magnitude reads wrong
 *     immediately;
 *   warnings — reasonableness checks (probability outside 0–1,
 *     inverted PERT ranges, magnitude ranges spanning >3 orders of
 *     magnitude). Warn-only by contract: calibration is judgement,
 *     and the assessor may know something the validator doesn't;
 *   priors — a small static library of per-category reference
 *     ranges shown as ghost text ("typical ransomware TEF for a
 *     mid-size org: 0.05–0.5/yr"). Anchors, not answers.
 *
 * Pure module — no DB, no ctx — mirroring `@/lib/risk-residual`.
 */

import { formatCompactCurrency } from '@/lib/risk-coherence';

// ─── Reflections ─────────────────────────────────────────────────────

export type FairFieldKey =
    | 'contactFrequency'
    | 'probabilityOfAction'
    | 'threatEventFrequency'
    | 'threatCapability'
    | 'controlStrength'
    | 'vulnerabilityProbability'
    | 'productivityLoss'
    | 'responseCost'
    | 'replacementCost'
    | 'primaryLossMagnitude'
    | 'secondaryLossEventFrequency'
    | 'secondaryLossMagnitude';

/**
 * A frequency as the parts a sentence is built from (#4692), so the panel
 * can word it in the user's language. `reflectFrequency` words it in English.
 */
export type FrequencyPhrase =
    | { kind: 'never' }
    | { kind: 'perYear'; n: number }
    | { kind: 'everyYears'; years: number };

export function frequencyPhrase(perYear: number): FrequencyPhrase {
    if (perYear <= 0) return { kind: 'never' };
    if (perYear >= 1) return { kind: 'perYear', n: Math.round(perYear * 10) / 10 };
    const years = 1 / perYear;
    return { kind: 'everyYears', years: years >= 10 ? Math.round(years) : Math.round(years * 10) / 10 };
}

/** A probability as the parts a sentence is built from (#4692). */
export type ProbabilityPhrase =
    | { kind: 'zero' }
    | { kind: 'negative' }
    | { kind: 'certain' }
    | { kind: 'oneIn'; oneIn: number; percent: number };

export function probabilityPhrase(p: number): ProbabilityPhrase {
    // polish #8 — an exact 0 is rarely intentional on a FAIR
    // probability input; it collapses ALE to zero and silently
    // removes the risk from the simulation. The "did you mean" nudge
    // shifts the user from "I'm done" to "wait, is that right?"
    // without forcing a value.
    if (p === 0) return { kind: 'zero' };
    if (p < 0) return { kind: 'negative' };
    if (p >= 1) return { kind: 'certain' };
    const oneIn = 1 / p;
    return {
        kind: 'oneIn',
        oneIn: oneIn >= 10 ? Math.round(oneIn) : Math.round(oneIn * 10) / 10,
        percent: Math.round(p * 100),
    };
}

/** "0.1/yr" → "about once every 10 years"; "12/yr" → "about 12×/year". */
export function reflectFrequency(perYear: number): string {
    return ENGLISH_REFLECTION_WORDS.frequency(frequencyPhrase(perYear));
}

/** "0.25" → "1-in-4 chance". */
export function reflectProbability(p: number): string {
    return ENGLISH_REFLECTION_WORDS.probability(probabilityPhrase(p));
}

/**
 * Plain-language mirror for one FAIR input. Null when the value is
 * absent — the UI renders nothing rather than a placeholder.
 */
export function reflectFairInput(key: FairFieldKey, value: number | null): string | null {
    if (value === null || Number.isNaN(value)) return null;
    switch (key) {
        case 'contactFrequency':
            return `threat contacts the asset ${reflectFrequency(value)}`;
        case 'threatEventFrequency':
            return `a threat event ${value >= 1 ? 'occurs' : 'is expected'} ${reflectFrequency(value)}`;
        case 'probabilityOfAction':
            return `when in contact, the threat acts with ${reflectProbability(value)}`;
        case 'vulnerabilityProbability':
            return `an attempted event succeeds with ${reflectProbability(value)}`;
        case 'secondaryLossEventFrequency':
            return `secondary losses (fines, churn, lawsuits) follow ${reflectProbability(value)} of primary events`;
        case 'threatCapability':
            return `threat skill ${value}/10 — ${value >= 8 ? 'nation-state / top-percentile attacker' : value >= 5 ? 'capable, resourced attacker' : 'commodity / opportunistic attacker'}`;
        case 'controlStrength':
            return `controls resist ${value}/10 — ${value >= 8 ? 'hardened, defence-in-depth' : value >= 5 ? 'solid baseline controls' : 'thin or unproven controls'}`;
        case 'productivityLoss':
        case 'responseCost':
        case 'replacementCost':
            return `${formatCompactCurrency(value)} per loss event`;
        case 'primaryLossMagnitude':
            return `each primary loss event costs about ${formatCompactCurrency(value)}`;
        case 'secondaryLossMagnitude':
            return `each secondary fallout costs about ${formatCompactCurrency(value)}`;
    }
}

// ─── Reasonableness warnings ─────────────────────────────────────────

/**
 * What a warning says, as a code the panel words in the user's language
 * (#4692). `message` stays the English sentence, for logs and tests.
 */
export type CalibrationCode =
    | 'probabilityRange'
    | 'scale1to10'
    | 'negativeLoss'
    | 'negativeTef'
    | 'negativeContact'
    | 'tefMisScaled'
    | 'rangeInverted'
    | 'rangeTooWide'
    | 'boundsProbability'
    | 'boundsNegative';

export interface CalibrationWarning {
    field: FairFieldKey | 'pertRange';
    message: string;
    code: CalibrationCode;
    /** The calibrated factor a range warning is about. */
    factor?: FairFactorKey;
    /** The numbers the sentence quotes. */
    params?: Record<string, number>;
}

export interface FairPointValues {
    contactFrequency: number | null;
    probabilityOfAction: number | null;
    threatEventFrequency: number | null;
    threatCapability: number | null;
    controlStrength: number | null;
    vulnerabilityProbability: number | null;
    productivityLoss: number | null;
    responseCost: number | null;
    replacementCost: number | null;
    primaryLossMagnitude: number | null;
    secondaryLossEventFrequency: number | null;
    secondaryLossMagnitude: number | null;
}

const PROBABILITY_FIELDS: ReadonlyArray<FairFieldKey> = [
    'probabilityOfAction',
    'vulnerabilityProbability',
    'secondaryLossEventFrequency',
];
const SCALE_1_10_FIELDS: ReadonlyArray<FairFieldKey> = [
    'threatCapability',
    'controlStrength',
];
const MONEY_FIELDS: ReadonlyArray<FairFieldKey> = [
    'productivityLoss',
    'responseCost',
    'replacementCost',
    'primaryLossMagnitude',
    'secondaryLossMagnitude',
];

/**
 * Warn-only sanity checks on the point estimates. NEVER blocks —
 * the return feeds an advisory notice, not validation errors.
 */
export function validateFairInputs(v: FairPointValues): CalibrationWarning[] {
    const warnings: CalibrationWarning[] = [];
    for (const f of PROBABILITY_FIELDS) {
        const val = v[f];
        if (val !== null && (val < 0 || val > 1)) {
            warnings.push({ field: f, code: 'probabilityRange', params: { value: val }, message: `${f} is a probability — expected 0–1, got ${val}` });
        }
    }
    for (const f of SCALE_1_10_FIELDS) {
        const val = v[f];
        if (val !== null && (val < 1 || val > 10)) {
            warnings.push({ field: f, code: 'scale1to10', params: { value: val }, message: `${f} is on the FAIR 1–10 scale, got ${val}` });
        }
    }
    for (const f of MONEY_FIELDS) {
        const val = v[f];
        if (val !== null && val < 0) {
            warnings.push({ field: f, code: 'negativeLoss', message: `${f} is a loss amount — negative values invert the model` });
        }
    }
    if (v.threatEventFrequency !== null && v.threatEventFrequency < 0) {
        warnings.push({ field: 'threatEventFrequency', code: 'negativeTef', message: 'TEF cannot be negative' });
    }
    if (v.contactFrequency !== null && v.contactFrequency < 0) {
        warnings.push({ field: 'contactFrequency', code: 'negativeContact', message: 'Contact frequency cannot be negative' });
    }
    if (
        v.threatEventFrequency !== null &&
        v.contactFrequency !== null &&
        v.probabilityOfAction !== null &&
        v.threatEventFrequency > v.contactFrequency * v.probabilityOfAction * 10
    ) {
        warnings.push({
            field: 'threatEventFrequency',
            code: 'tefMisScaled',
            message:
                'TEF override is far above contact × P(action) — one of the three is probably mis-scaled',
        });
    }
    return warnings;
}

/** A PERT triple as stored in fairInputsJson. */
export interface PertTriple {
    min: number;
    mode: number;
    max: number;
}

/**
 * Warn-only checks on a PERT range: inverted ordering and magnitude
 * ranges spanning more than three orders (a €1K–€10M "estimate" is
 * not an estimate — it's an unanchored guess that will dominate the
 * simulation tails).
 */
export function validatePertTriple(label: string, t: PertTriple): CalibrationWarning[] {
    const warnings: CalibrationWarning[] = [];
    if (!(t.min <= t.mode && t.mode <= t.max)) {
        warnings.push({
            field: 'pertRange',
            code: 'rangeInverted',
            params: { min: t.min, mode: t.mode, max: t.max },
            message: `${label}: range is inverted (expected min ≤ mode ≤ max, got ${t.min}/${t.mode}/${t.max})`,
        });
    }
    if (t.min > 0 && t.max / t.min > 1000) {
        warnings.push({
            field: 'pertRange',
            code: 'rangeTooWide',
            params: { min: t.min, max: t.max },
            message: `${label}: range spans more than 3 orders of magnitude (${t.min} → ${t.max}) — consider calibrating with a reference event`,
        });
    }
    return warnings;
}

// ─── RQ3-2 — range-first calibration ─────────────────────────────────

/** The five FAIR factors the panel calibrates as min/likely/max ranges. */
export type FairFactorKey = 'tef' | 'vulnerability' | 'plm' | 'slef' | 'slm';

export const FAIR_FACTOR_KEYS: ReadonlyArray<FairFactorKey> = [
    'tef',
    'vulnerability',
    'plm',
    'slef',
    'slm',
];

export const FAIR_FACTOR_LABELS: Readonly<Record<FairFactorKey, string>> = {
    tef: 'Threat event frequency',
    vulnerability: 'Vulnerability',
    plm: 'Primary loss magnitude',
    slef: 'Secondary loss event frequency',
    slm: 'Secondary loss magnitude',
};

/** A triple mid-entry — each bound may still be blank. */
export interface TripleDraft {
    min: number | null;
    mode: number | null;
    max: number | null;
}

const isComplete = (t: TripleDraft): t is { min: number; mode: number; max: number } =>
    t.min != null && t.mode != null && t.max != null &&
    !Number.isNaN(t.min) && !Number.isNaN(t.mode) && !Number.isNaN(t.max);

/**
 * RQ3-2 — plain-language mirror for a calibrated range. Reflects the
 * LIKELY (mode) value in the factor's own register, and — once the
 * range is complete — appends a spread reflection when max/min runs a
 * full order of magnitude or more ("that's a ~40× spread; anchor it
 * with a reference event"). Wide ranges are legitimate calibration —
 * the sentence makes the width READ, it never blocks.
 */
export function reflectTriple(
    key: FairFactorKey,
    t: TripleDraft,
    words: ReflectionWords = ENGLISH_REFLECTION_WORDS,
): string | null {
    if (t.mode == null || Number.isNaN(t.mode)) return null;
    let base: string;
    switch (key) {
        case 'tef':
            base = words.tef(t.mode >= 1, words.frequency(frequencyPhrase(t.mode)));
            break;
        case 'vulnerability':
            base = words.vulnerability(words.probability(probabilityPhrase(t.mode)));
            break;
        case 'plm':
            base = words.plm(formatCompactCurrency(t.mode));
            break;
        case 'slef':
            base = words.slef(words.probability(probabilityPhrase(t.mode)));
            break;
        case 'slm':
            base = words.slm(formatCompactCurrency(t.mode));
            break;
    }
    if (isComplete(t) && t.min > 0 && t.max / t.min >= 10) {
        return words.spread(base, Math.round(t.max / t.min));
    }
    return base;
}

/**
 * The sentences a reflection is made of (#4692). The panel passes a set
 * built from its translations; anything else gets English.
 */
export interface ReflectionWords {
    tef(occurs: boolean, frequency: string): string;
    vulnerability(probability: string): string;
    plm(amount: string): string;
    slef(probability: string): string;
    slm(amount: string): string;
    spread(base: string, ratio: number): string;
    frequency(f: FrequencyPhrase): string;
    probability(p: ProbabilityPhrase): string;
}

export const ENGLISH_REFLECTION_WORDS: ReflectionWords = {
    tef: (occurs, frequency) => `most likely: a threat event ${occurs ? 'occurs' : 'is expected'} ${frequency}`,
    vulnerability: (probability) => `most likely: an attempted event succeeds with ${probability}`,
    plm: (amount) => `most likely: each primary loss event costs ${amount}`,
    slef: (probability) => `most likely: secondary losses follow ${probability} of primary events`,
    slm: (amount) => `most likely: each secondary fallout costs ${amount}`,
    spread: (base, ratio) => `${base} — that's a ~${ratio}× spread; anchor it with a reference event`,
    frequency: (f) =>
        f.kind === 'never'
            ? 'never (zero events expected)'
            : f.kind === 'perYear'
              ? `about ${f.n}× per year`
              : `about one event every ${f.years} years`,
    probability: (p) =>
        p.kind === 'zero'
            ? '0% — impossible by your model; did you mean 0.5?'
            : p.kind === 'negative'
              ? 'negative — probabilities live on 0..1'
              : p.kind === 'certain'
                ? 'certain (100% chance)'
                : `a 1-in-${p.oneIn} chance (${p.percent}%)`,
};

/**
 * RQ3-2 — warn-only checks across the five calibrated ranges:
 * `validatePertTriple` (inverted ordering, >3-orders span) on every
 * complete triple, plus the factor-specific bounds the point-era
 * `validateFairInputs` carried (probabilities on 0–1, no negative
 * frequencies or loss amounts) applied to every entered bound.
 * Warn-only by contract — the return feeds an advisory notice.
 */
export function validateFairTriples(
    triples: Record<FairFactorKey, TripleDraft>,
): CalibrationWarning[] {
    const warnings: CalibrationWarning[] = [];
    const PROBABILITY_FACTORS: ReadonlyArray<FairFactorKey> = ['vulnerability', 'slef'];
    for (const key of FAIR_FACTOR_KEYS) {
        const t = triples[key];
        const label = FAIR_FACTOR_LABELS[key];
        if (isComplete(t)) warnings.push(...validatePertTriple(label, t).map((w) => ({ ...w, factor: key })));
        const bounds = [t.min, t.mode, t.max].filter(
            (v): v is number => v != null && !Number.isNaN(v),
        );
        if (PROBABILITY_FACTORS.includes(key)) {
            if (bounds.some((v) => v < 0 || v > 1)) {
                warnings.push({
                    field: 'pertRange',
                    code: 'boundsProbability',
                    factor: key,
                    message: `${label} is a probability — every bound lives on 0–1`,
                });
            }
        } else if (bounds.some((v) => v < 0)) {
            warnings.push({
                field: 'pertRange',
                code: 'boundsNegative',
                factor: key,
                message: `${label} cannot be negative — negative values invert the model`,
            });
        }
    }
    return warnings;
}

// ─── Category priors ─────────────────────────────────────────────────

export interface CategoryPrior {
    /** Ghost-text hint shown beside the TEF group. */
    tefHint: string;
    /** Ghost-text hint shown beside the loss-magnitude group. */
    lossHint: string;
}

/**
 * Small static reference library — anchors for the categories the
 * NewRiskModal offers. Deliberately coarse public-report-scale
 * figures: the value is the ORDER OF MAGNITUDE anchor, not the
 * decimal. Unknown categories return null and the UI shows nothing.
 */
export const CATEGORY_PRIORS: Readonly<Record<string, CategoryPrior>> = {
    Technical: {
        tefHint: 'Reference: ransomware/intrusion attempts for a mid-size org typically land at TEF 0.05–0.5/yr',
        lossHint: 'Reference: single-incident response + recovery commonly runs €50K–€500K',
    },
    Operational: {
        tefHint: 'Reference: significant process/outage events typically 0.5–4/yr',
        lossHint: 'Reference: per-incident operational losses commonly €10K–€250K',
    },
    Compliance: {
        tefHint: 'Reference: regulator findings/audit events typically 0.1–1/yr',
        lossHint: 'Reference: fines + remediation commonly €25K–€2M depending on regime',
    },
    Financial: {
        tefHint: 'Reference: material financial-control failures typically 0.1–0.5/yr',
        lossHint: 'Reference: single-event financial losses commonly €50K–€1M',
    },
    Reputational: {
        tefHint: 'Reference: public-trust incidents typically 0.05–0.3/yr',
        lossHint: 'Reference: churn + PR response commonly €100K–€5M (hardest to calibrate — use customer-lifetime maths)',
    },
};

export function getCategoryPrior(category: string | null | undefined): CategoryPrior | null {
    if (!category) return null;
    return CATEGORY_PRIORS[category] ?? null;
}
