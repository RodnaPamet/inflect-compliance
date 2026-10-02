/**
 * The width backstop on a bounded template's VALUE fields (#3051, step 5).
 *
 * The owner chose typed constraints without requiring N individually-approved
 * writes first, which makes the predicate review the only gate on a value
 * field. So these tests are not coverage for a helper — they are the proof that
 * the one backstop on that axis has teeth.
 *
 * Every width case carries its NEGATIVE control: the narrow pattern that must
 * still be accepted. A refusal that fires on everything is not a check, and a
 * test suite that only ever asserts refusals cannot tell the two apart.
 */
import {
    MAX_ENUM_VALUES,
    MAX_MATCHABLE_LENGTH,
    MAX_PATTERN_LENGTH,
    MAX_VALUE_LENGTH,
    refusalForConstraint,
    refusalForValue,
    type ValueConstraint,
} from '@/lib/integrations/parameter-constraints';

/** The pattern the issue uses as its worked example, tightened to pass. */
const COMPANY_EMAIL = '^[a-z.]{1,64}@company\\.test$';

function code(refusal: { code: string } | null): string | null {
    return refusal ? refusal.code : null;
}

describe('refusalForConstraint — regex width', () => {
    it('accepts the narrow pattern the design is built around', () => {
        expect(refusalForConstraint({ kind: 'regex', pattern: COMPANY_EMAIL })).toBeNull();
    });

    it.each([
        ['bare dot-star', '^.*$'],
        ['bare dot-plus', '^.+$'],
        ['whitespace-class star', '^[\\s\\S]*$'],
        // The cases a denylist of pattern TEXT misses. Each contains no banned
        // literal and admits everything.
        ['alternation hiding dot-star', '^(?:admin|.*)$'],
        ['negated empty class', '^[^]*$'],
    ])('refuses %s', (_label, pattern) => {
        expect(code(refusalForConstraint({ kind: 'regex', pattern }))).not.toBeNull();
    });

    it('refuses a pattern whose anchors do not bind every branch', () => {
        // `^foo|bar$` reads as anchored and is anchored on ONE side per branch,
        // so a padded value matches. This is the case the syntactic ^...$ check
        // passes and only the padding probe catches — so assert the specific
        // code, not merely that something was refused.
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^foo|bar$' }))).toBe(
            'constraint_pattern_anchor_escapable',
        );
        // The negative control: the same intent, wrapped. Must be accepted.
        expect(refusalForConstraint({ kind: 'regex', pattern: '^(?:foo|bar)$' })).toBeNull();
    });

    it('refuses an unanchored pattern, naming the substring trap', () => {
        const refusal = refusalForConstraint({ kind: 'regex', pattern: '@company\\.test' });
        expect(code(refusal)).toBe('constraint_pattern_unanchored');
        expect(refusal?.detail).toContain('SUBSTRING');
    });

    it('refuses a pattern that admits the empty string', () => {
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^[a-z]*$' }))).toBe(
            'constraint_pattern_admits_empty',
        );
        // Negative control: the same class, one occurrence minimum, counted.
        expect(refusalForConstraint({ kind: 'regex', pattern: '^[a-z]{1,16}$' })).toBeNull();
    });

    it('refuses a pattern that does not bound the length it matches', () => {
        // `+` over a narrow class: narrow in SHAPE, unbounded in SIZE.
        const refusal = refusalForConstraint({ kind: 'regex', pattern: '^[a-z]+$' });
        expect(code(refusal)).toBe('constraint_pattern_unbounded_length');
        expect(refusal?.detail).toContain('{1,64}');
        // Negative control: counted, so bounded.
        expect(refusalForConstraint({ kind: 'regex', pattern: '^[a-z]{1,10}$' })).toBeNull();
    });

    it('refuses an unbounded quantifier under a bounded group', () => {
        // Not a nested-quantifier refusal — the bounded-length rule is the one
        // that should name this, because unbounded SIZE is the actual problem.
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^(?:[a-z]+){1,3}$' }))).toBe(
            'constraint_pattern_unbounded_length',
        );
    });

    it('refuses a nested unbounded quantifier but not a bounded one', () => {
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^(a+)+$' }))).toBe(
            'constraint_pattern_nested_quantifier',
        );
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^(?:a+){2,}$' }))).toBe(
            'constraint_pattern_nested_quantifier',
        );
        // THE NEGATIVE CONTROL THAT SHAPED THE RULE. Both quantifiers counted,
        // so the blowup is bounded at 8x3 and this ordinary dotted-segment
        // pattern must be accepted.
        expect(
            refusalForConstraint({
                kind: 'regex',
                pattern: '^(?:[a-z]{1,8}\\.){1,3}[a-z]{2,4}$',
            }),
        ).toBeNull();
    });

    it('refuses an uncompilable pattern rather than treating it as narrow', () => {
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^[a-z$' }))).toBe(
            'constraint_pattern_invalid',
        );
    });

    it('refuses a pattern too long to review', () => {
        const pattern = `^${'a'.repeat(MAX_PATTERN_LENGTH)}$`;
        expect(code(refusalForConstraint({ kind: 'regex', pattern }))).toBe(
            'constraint_pattern_too_long',
        );
    });

    it('refuses an empty pattern', () => {
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '' }))).toBe(
            'constraint_pattern_empty',
        );
    });
});

describe('refusalForConstraint — the other three kinds', () => {
    it('accepts an enum and refuses an empty one', () => {
        expect(refusalForConstraint({ kind: 'enum', values: ['ACTIVE', 'TERMINATED'] })).toBeNull();
        expect(code(refusalForConstraint({ kind: 'enum', values: [] }))).toBe('constraint_enum_empty');
    });

    it('refuses a duplicate enum value, because it means edited-not-reviewed', () => {
        expect(code(refusalForConstraint({ kind: 'enum', values: ['A', 'A'] }))).toBe(
            'constraint_enum_duplicates',
        );
    });

    it('refuses an enum long enough to be a population rather than a choice', () => {
        const values = Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => `v${i}`);
        const refusal = refusalForConstraint({ kind: 'enum', values });
        expect(code(refusal)).toBe('constraint_enum_too_many');
        expect(refusal?.detail).toContain('named population');
        // Negative control: exactly at the bound is accepted.
        expect(
            refusalForConstraint({
                kind: 'enum',
                values: values.slice(0, MAX_ENUM_VALUES),
            }),
        ).toBeNull();
    });

    it('refuses an integer range with no upper bound', () => {
        // The recorded design names this one explicitly. `Infinity` is not an
        // integer, so an unbounded range cannot even be expressed.
        expect(code(refusalForConstraint({ kind: 'integer', min: 0, max: Infinity }))).toBe(
            'constraint_range_not_integers',
        );
        expect(code(refusalForConstraint({ kind: 'integer', min: 5, max: 1 }))).toBe(
            'constraint_range_inverted',
        );
        expect(refusalForConstraint({ kind: 'integer', min: 1, max: 99 })).toBeNull();
    });

    it('accepts a length bound WITHOUT width-probing it', () => {
        // The deliberate asymmetry: a length bound states its own width, so
        // "any 3-10 characters" is reviewable even though it admits arbitrary
        // content. A regex admitting the same set is refused, because its width
        // is invisible. If this ever starts failing, the module has begun
        // applying regex reasoning to a legible bound.
        expect(refusalForConstraint({ kind: 'length', min: 3, max: 10 })).toBeNull();
        expect(code(refusalForConstraint({ kind: 'regex', pattern: '^.{3,10}$' }))).toBe(
            'constraint_pattern_admits_arbitrary',
        );
    });

    it('refuses a length bound that admits the empty string or runs past the ceiling', () => {
        expect(code(refusalForConstraint({ kind: 'length', min: 0, max: 10 }))).toBe(
            'constraint_length_admits_empty',
        );
        expect(
            code(refusalForConstraint({ kind: 'length', min: 1, max: MAX_VALUE_LENGTH + 1 })),
        ).toBe('constraint_length_too_long');
    });
});

describe('refusalForValue', () => {
    const emailField: ValueConstraint = { kind: 'regex', pattern: COMPANY_EMAIL };

    it('passes a value the approved pattern admits and refuses one it does not', () => {
        expect(refusalForValue(emailField, 'first.last@company.test')).toBeNull();
        expect(code(refusalForValue(emailField, 'evil@attacker.test'))).toBe('value_does_not_match');
    });

    it('caps the input BEFORE running the pattern', () => {
        const refusal = refusalForValue(emailField, 'a'.repeat(MAX_VALUE_LENGTH + 1));
        expect(code(refusal)).toBe('value_too_long');
    });

    it('fails closed when a stored pattern no longer compiles', () => {
        // Reachable through a row written by a path this module does not own.
        // The wrong behaviour here is dispatching the value unchecked.
        expect(code(refusalForValue({ kind: 'regex', pattern: '^[a-z$' }, 'abc'))).toBe(
            'value_constraint_uncompilable',
        );
    });

    it('refuses a non-string for every string-shaped kind', () => {
        expect(code(refusalForValue(emailField, 42))).toBe('value_not_a_string');
        expect(code(refusalForValue({ kind: 'enum', values: ['A'] }, 42))).toBe('value_not_a_string');
        expect(code(refusalForValue({ kind: 'length', min: 1, max: 4 }, 42))).toBe(
            'value_not_a_string',
        );
    });

    it('enforces enum membership by identity', () => {
        const field: ValueConstraint = { kind: 'enum', values: ['ACTIVE', 'TERMINATED'] };
        expect(refusalForValue(field, 'ACTIVE')).toBeNull();
        expect(code(refusalForValue(field, 'active'))).toBe('value_not_in_enum');
    });

    it('enforces an integer range and rejects a non-integer number', () => {
        const field: ValueConstraint = { kind: 'integer', min: 1, max: 10 };
        expect(refusalForValue(field, 10)).toBeNull();
        expect(code(refusalForValue(field, 11))).toBe('value_out_of_range');
        expect(code(refusalForValue(field, 1.5))).toBe('value_not_an_integer');
    });

    it('enforces a length bound at both ends', () => {
        const field: ValueConstraint = { kind: 'length', min: 3, max: 5 };
        expect(refusalForValue(field, 'abc')).toBeNull();
        expect(code(refusalForValue(field, 'ab'))).toBe('value_length_out_of_range');
        expect(code(refusalForValue(field, 'abcdef'))).toBe('value_length_out_of_range');
    });
});

describe('the two halves agree', () => {
    it('every value an approved pattern admits is within the dispatch ceiling', () => {
        // The join between the two functions. `refusalForConstraint` refuses any
        // pattern matching something longer than MAX_MATCHABLE_LENGTH, and
        // `refusalForValue` refuses any value longer than MAX_VALUE_LENGTH. If
        // these two numbers ever diverge, there is a band of values the save
        // path blessed and the dispatch path refuses — a template that passes
        // review and then fails every invocation.
        expect(MAX_VALUE_LENGTH).toBe(MAX_MATCHABLE_LENGTH);
    });
});
