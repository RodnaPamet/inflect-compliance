/**
 * RQ2-7 — FAIR calibration aids (pure-math suite).
 *
 * Reflections per field, frequency/probability phrasing across
 * scales, warn-only validators per class, PERT triple checks, and
 * the category prior library.
 */
import {
    reflectFairInput,
    reflectFrequency,
    reflectProbability,
    validateFairInputs,
    validatePertTriple,
    reflectTriple,
    validateFairTriples,
    getCategoryPrior,
    CATEGORY_PRIORS,
    ENGLISH_REFLECTION_WORDS,
    type FairFieldKey,
    type ReflectionWords,
    type FairPointValues,
} from '@/lib/fair-calibration';

const EMPTY: FairPointValues = {
    contactFrequency: null,
    probabilityOfAction: null,
    threatEventFrequency: null,
    threatCapability: null,
    controlStrength: null,
    vulnerabilityProbability: null,
    productivityLoss: null,
    responseCost: null,
    replacementCost: null,
    primaryLossMagnitude: null,
    secondaryLossEventFrequency: null,
    secondaryLossMagnitude: null,
};

describe('reflectFrequency / reflectProbability', () => {
    it.each([
        [0.1, 'about one event every 10 years'],
        [0.5, 'about one event every 2 years'],
        [1, 'about 1× per year'],
        [12, 'about 12× per year'],
        [0, 'never (zero events expected)'],
    ])('frequency %d → %s', (input, expected) => {
        expect(reflectFrequency(input)).toBe(expected);
    });

    it.each([
        [0.25, 'a 1-in-4 chance (25%)'],
        [0.01, 'a 1-in-100 chance (1%)'],
        [1, 'certain (100% chance)'],
        // polish #8 — exact zero gets a typo-trap nudge.
        [0, '0% — impossible by your model; did you mean 0.5?'],
    ])('probability %d → %s', (input, expected) => {
        expect(reflectProbability(input)).toBe(expected);
    });
});

describe('reflectFairInput — every numeric FAIR input has a reflection', () => {
    const ALL_FIELDS: FairFieldKey[] = [
        'contactFrequency', 'probabilityOfAction', 'threatEventFrequency',
        'threatCapability', 'controlStrength', 'vulnerabilityProbability',
        'productivityLoss', 'responseCost', 'replacementCost',
        'primaryLossMagnitude', 'secondaryLossEventFrequency', 'secondaryLossMagnitude',
    ];

    it.each(ALL_FIELDS)('%s reflects a non-null value', (field) => {
        const reflection = reflectFairInput(field, 0.5);
        expect(reflection).toEqual(expect.any(String));
        expect(reflection!.length).toBeGreaterThan(10);
    });

    it('absent values reflect to null (UI renders nothing)', () => {
        expect(reflectFairInput('threatEventFrequency', null)).toBeNull();
        expect(reflectFairInput('primaryLossMagnitude', Number.NaN)).toBeNull();
    });

    it('TEF 0.1 reads as the once-per-decade sentence from the issue', () => {
        expect(reflectFairInput('threatEventFrequency', 0.1)).toMatch(/every 10 years/);
    });

    it('loss magnitudes reflect in compact currency', () => {
        expect(reflectFairInput('primaryLossMagnitude', 250_000)).toMatch(/€250K/);
    });
});

describe('validateFairInputs — warn, never block', () => {
    it('clean inputs warn nothing', () => {
        expect(
            validateFairInputs({
                ...EMPTY,
                threatEventFrequency: 0.2,
                vulnerabilityProbability: 0.4,
                primaryLossMagnitude: 100_000,
            }),
        ).toEqual([]);
    });

    it('flags probabilities outside 0–1 (the vulnerability > 1 case)', () => {
        const w = validateFairInputs({ ...EMPTY, vulnerabilityProbability: 1.4 });
        expect(w).toHaveLength(1);
        expect(w[0].field).toBe('vulnerabilityProbability');
    });

    it('flags 1–10 scale fields out of range', () => {
        const w = validateFairInputs({ ...EMPTY, threatCapability: 60 });
        expect(w.some((x) => x.field === 'threatCapability')).toBe(true);
    });

    it('flags negative money and negative frequencies', () => {
        const w = validateFairInputs({
            ...EMPTY,
            responseCost: -5,
            contactFrequency: -1,
        });
        expect(w.map((x) => x.field).sort()).toEqual(['contactFrequency', 'responseCost']);
    });

    it('flags a TEF override wildly above contact × P(action)', () => {
        const w = validateFairInputs({
            ...EMPTY,
            contactFrequency: 2,
            probabilityOfAction: 0.1,
            threatEventFrequency: 50,
        });
        expect(w.some((x) => x.field === 'threatEventFrequency')).toBe(true);
    });

    it('null-only input is silent (zero cost for unquantified risks)', () => {
        expect(validateFairInputs(EMPTY)).toEqual([]);
    });
});

describe('validatePertTriple', () => {
    it('accepts a sane range', () => {
        expect(validatePertTriple('PLM', { min: 10_000, mode: 50_000, max: 200_000 })).toEqual([]);
    });

    it('flags an inverted range', () => {
        const w = validatePertTriple('PLM', { min: 100, mode: 50, max: 200 });
        expect(w.some((x) => x.message.includes('inverted'))).toBe(true);
    });

    it('flags a range spanning more than 3 orders of magnitude', () => {
        const w = validatePertTriple('PLM', { min: 1_000, mode: 50_000, max: 10_000_000 });
        expect(w.some((x) => x.message.includes('orders of magnitude'))).toBe(true);
    });
});

describe('category priors', () => {
    it('known categories carry TEF + loss anchors', () => {
        for (const prior of Object.values(CATEGORY_PRIORS)) {
            expect(prior.tefHint).toMatch(/Reference:/);
            expect(prior.lossHint).toMatch(/Reference:/);
        }
        expect(getCategoryPrior('Technical')?.tefHint).toMatch(/TEF 0\.05–0\.5/);
    });

    it('unknown / absent categories return null (UI renders nothing)', () => {
        expect(getCategoryPrior('Quantum')).toBeNull();
        expect(getCategoryPrior(null)).toBeNull();
    });
});

// ─── RQ3-2 — range-first aids ────────────────────────────────────────

const T = (min: number | null, mode: number | null, max: number | null) => ({ min, mode, max });
const EMPTY_TRIPLES = {
    tef: T(null, null, null),
    vulnerability: T(null, null, null),
    plm: T(null, null, null),
    slef: T(null, null, null),
    slm: T(null, null, null),
};

describe('reflectTriple (RQ3-2)', () => {
    it('reflects the likely value in the factor register', () => {
        expect(reflectTriple('tef', T(null, 0.1, null))).toMatch(/every 10 years/);
        expect(reflectTriple('vulnerability', T(null, 0.25, null))).toMatch(/1-in-4/);
        expect(reflectTriple('plm', T(null, 80_000, null))).toMatch(/€80K/);
    });

    it('returns null without a likely value — the UI renders nothing', () => {
        expect(reflectTriple('tef', T(0.1, null, 0.5))).toBeNull();
    });

    it('a complete order-of-magnitude range appends the spread call-out', () => {
        expect(reflectTriple('plm', T(10_000, 80_000, 400_000))).toMatch(
            /~40× spread; anchor it with a reference event/,
        );
    });

    it('tight ranges carry no spread sentence (signal, not noise)', () => {
        expect(reflectTriple('plm', T(80_000, 100_000, 120_000))).not.toMatch(/spread/);
    });

    it('zero-min ranges never divide by zero', () => {
        expect(reflectTriple('tef', T(0, 0.5, 2))).not.toMatch(/spread/);
    });
});

describe('validateFairTriples (RQ3-2) — warn-only range checks', () => {
    it('clean calibrated ranges produce no warnings', () => {
        const w = validateFairTriples({
            ...EMPTY_TRIPLES,
            tef: T(0.1, 0.2, 0.6),
            vulnerability: T(0.2, 0.4, 0.7),
            plm: T(50_000, 100_000, 250_000),
        });
        expect(w).toHaveLength(0);
    });

    it('wires validatePertTriple per complete factor (inverted range)', () => {
        const w = validateFairTriples({ ...EMPTY_TRIPLES, tef: T(5, 2, 1) });
        expect(w.some((x) => x.message.includes('inverted'))).toBe(true);
    });

    it('probability factors warn on bounds outside 0–1 — even mid-entry', () => {
        const w = validateFairTriples({ ...EMPTY_TRIPLES, vulnerability: T(null, 1.4, null) });
        expect(w.some((x) => x.message.includes('probability'))).toBe(true);
    });

    it('money/frequency factors warn on negative bounds', () => {
        const w = validateFairTriples({ ...EMPTY_TRIPLES, plm: T(-5, null, null) });
        expect(w.some((x) => x.message.includes('negative'))).toBe(true);
    });

    it('blank triples warn about nothing (zero-cost default)', () => {
        expect(validateFairTriples(EMPTY_TRIPLES)).toHaveLength(0);
    });
});

describe('the panel can word every sentence in the user\'s language (#4692)', () => {
    it('reflectTriple uses the words it is given, and English by default', () => {
        const words: ReflectionWords = {
            ...ENGLISH_REFLECTION_WORDS,
            tef: (occurs, frequency) => `TEF[${occurs}](${frequency})`,
            frequency: (f) => (f.kind === 'perYear' ? `PER_YEAR:${f.n}` : f.kind),
            spread: (base, ratio) => `${base}+SPREAD:${ratio}`,
        };
        expect(reflectTriple('tef', { min: 1, mode: 2, max: 40 }, words)).toBe('TEF[true](PER_YEAR:2)+SPREAD:40');
        expect(reflectTriple('tef', { min: null, mode: 2, max: null })).toBe(
            'most likely: a threat event occurs about 2× per year',
        );
    });

    it('a range warning names its factor, code and numbers, beside the English sentence', () => {
        const [w] = validateFairTriples({
            ...EMPTY_TRIPLES,
            tef: { min: 5, mode: 2, max: 1 },
        });
        expect(w).toMatchObject({
            code: 'rangeInverted',
            factor: 'tef',
            params: { min: 5, mode: 2, max: 1 },
        });
        expect(w.message).toMatch(/^Threat event frequency: range is inverted/);
        const bounds = validateFairTriples({ ...EMPTY_TRIPLES, vulnerability: { min: 0.2, mode: 1.5, max: 2 } });
        expect(bounds).toContainEqual(expect.objectContaining({ code: 'boundsProbability', factor: 'vulnerability' }));
    });
});
