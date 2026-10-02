/**
 * What a bounded template may say about an OPEN VALUE field (#3051, step 5).
 *
 * `ExternalToolParameterSet` holds EXACT values today: a human types the bytes
 * that will be dispatched, and safety is "a person wrote this". A template opens
 * some fields, and the safety property moves — it becomes "the constraint is
 * tight enough", which is a judgement a reviewer makes ONCE, about a shape, for
 * every future invocation.
 *
 * The owner's decision (#3051, 2026-10-01) chose typed constraints for value
 * fields WITHOUT requiring N individually-approved writes first. So the
 * predicate review is the only gate on a value field, and nothing downstream
 * catches a reviewer who approves something too wide. This module is that
 * backstop. It is load-bearing rather than a nicety.
 *
 * The TARGET field is NOT bounded here. Decision 1 bounds it by DATA — a named
 * population — for the reason this module cannot fix: approving `^[0-9]+$` on an
 * employee number approves every employee, and no amount of pattern analysis
 * turns that into a narrow bound. Width checks make a predicate honest about
 * what it admits; they cannot make a predicate the right KIND of bound.
 *
 * ── WHY THESE ARE PROBES AND NOT A LIST OF BANNED PATTERNS ──────────────────
 *
 * The obvious implementation is a denylist: refuse `.*`, `.+`, `[\s\S]*`. It
 * does not work, and the failure is quiet. `^(?:admin|.*)$` contains none of
 * those as a whole pattern and admits everything. `^foo|bar$` looks anchored at
 * both ends and is anchored at NEITHER for its two branches, so it matches
 * anything starting with `foo` and anything ending with `bar`. A reviewer reads
 * both as narrow.
 *
 * So every width rule below COMPILES the pattern and asks it a question. The one
 * syntactic rule (anchors must be present) is kept as well, because it produces
 * a far clearer message than the probe that would also catch it — but it is
 * never the only thing standing between a wide pattern and approval.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ───────────────────────────────────
 *
 * A pattern can be narrow-looking, pass every probe here, and still be too wide
 * for its context — `^[a-z.]{1,64}@company\.test$` is tight unless the far end
 * treats the local part as a routing instruction. No mechanical check finds
 * that. It is what the four-eyes requirement on a template edit is for, and
 * saying so here keeps this module from reading as a guarantee it is not.
 *
 * Catastrophic backtracking is bounded rather than solved: patterns are capped
 * in length, nested quantifiers are refused, every probe input is short, and an
 * approved pattern must match only bounded-length inputs — which is also what
 * keeps a dispatch-time match cheap. JavaScript has no regex timeout, so a
 * determined author can still write something slow; the cap on what it may
 * match is the reason that cannot be made unbounded.
 */

/** The four shapes decision 2 names. One per open field. */
export type ValueConstraint =
    | { kind: 'regex'; pattern: string }
    | { kind: 'enum'; values: readonly string[] }
    | { kind: 'integer'; min: number; max: number }
    | { kind: 'length'; min: number; max: number };

export type ValueConstraintKind = ValueConstraint['kind'];

/**
 * The longest pattern a reviewer is asked to read, and the longest one this
 * module will compile. Both bounds, one number: a pattern nobody can read is not
 * reviewable, and a pattern this long is where backtracking blowups live.
 */
export const MAX_PATTERN_LENGTH = 512;

/**
 * The longest input an approved pattern may match.
 *
 * Every approved regex must REFUSE something this long. That is a real
 * tightening — `^[a-z.]+@company\.test$` fails it, and the author has to write
 * `^[a-z.]{1,64}@company\.test$` instead — and it buys two things: a reviewer
 * can see the field's size, and a dispatch-time match can never be handed a
 * megabyte.
 */
export const MAX_MATCHABLE_LENGTH = 256;

/** The hard ceiling on a dispatched string, applied before any match runs. */
export const MAX_VALUE_LENGTH = MAX_MATCHABLE_LENGTH;

/** Bounds on an `enum`, where the width IS the list and is legible as one. */
export const MAX_ENUM_VALUES = 64;

/**
 * Probe inputs for the arbitrary-content rule. Semantically unrelated to each
 * other on purpose: a predicate that admits several of these is not describing
 * one kind of value.
 *
 * The empty string is NOT here — it gets its own rule, because admitting it is
 * "no value at all" rather than being wide, and the two deserve different
 * messages.
 */
const ARBITRARY_CONTENT_PROBES = [
    // SHORT probes first, and they are not optional. The corpus originally held
    // only 16-to-30-character strings, so `^.{3,10}$` — a pattern admitting any
    // short content — matched none of them and was accepted as narrow. A probe
    // corpus has to span the LENGTHS a pattern might bound, not only the shapes.
    'k7Qv2m',
    '../',
    '<x>',
    "';--",
    'a b',
    'k7Qv2mXp9ZbL4nRt', // high entropy, no structure
    '../../etc/passwd',
    'evil@attacker.test',
    '<script>alert(1)</script>',
    "'; DROP TABLE users; --",
    'https://attacker.test/callback',
    '\n\r\t',
    '{"json":"object"}',
] as const;

/**
 * Structured samples used ONLY for the anchoring probe.
 *
 * Shaped like real field values rather than junk, because the probe needs inputs
 * a sane pattern ACCEPTS — a pattern matching nothing here is simply not
 * exercised by this rule, which is why it is not the only anchoring check.
 */
const ANCHOR_PROBES = [
    'foo',
    'bar',
    'a',
    '1',
    '42',
    'user@company.test',
    'first.last@company.test',
    'EMP-0001',
    'true',
    'ACTIVE',
] as const;

/**
 * Padding that must break a match if the pattern really is anchored.
 *
 * A NEWLINE, and both choices here were wrong on the first attempt.
 *
 * It is applied to ONE SIDE AT A TIME. Padding both ends is what the probe did
 * first, and it had zero discriminating power for the case it exists to catch:
 * in `^foo|bar$` the `foo` branch is anchored at the start and the `bar` branch
 * at the end, so padding both sides breaks BOTH branches and the pattern looks
 * anchored. `foo` + pad is what actually matches.
 *
 * And it is a newline rather than ordinary letters because the pad must be
 * something a legitimate field class does not already admit. With `Zq` as the
 * pad, `^[A-Za-z.]{1,64}@company\.test$` matches `Zquser@company.test` — not an
 * anchor escape at all, just another valid value — and a perfectly good pattern
 * gets refused. JavaScript's `$` is strict end-of-string (unlike some engines it
 * does not match before a trailing newline), so a newline cannot be absorbed by
 * the anchor either.
 */
const PAD = '\n';

/** Why a constraint may not be approved. `null` means it may. */
export type ConstraintRefusal = { code: string; detail: string };

function compile(pattern: string): RegExp | null {
    try {
        // No flags. `i` would widen a pattern a reviewer read as case-sensitive,
        // `g` makes `test` stateful via lastIndex, and `m` turns `$` into
        // end-of-LINE — which is exactly the anchoring this module checks for.
        return new RegExp(pattern);
    } catch {
        return null;
    }
}

/**
 * The classic catastrophic shape: an UNBOUNDED quantifier applied to a group
 * that itself contains a quantifier, e.g. `(a+)+` or `(?:[a-z]*)*`.
 *
 * The outer quantifier has to be unbounded for this to fire, and that is the
 * difference between a rule and a nuisance. `^(?:[a-z]{1,8}\.){1,3}[a-z]{2,4}$`
 * is a nested quantifier whose blowup is bounded at 8x3 — a perfectly ordinary
 * dotted-segment pattern, and refusing it would push authors towards something
 * worse. `(a+)+` has no such bound.
 *
 * An unbounded INNER quantifier under a bounded outer one (`^(?:[a-z]+){1,3}$`)
 * is not caught here and does not need to be: it matches arbitrarily long input,
 * so the bounded-match-length rule below refuses it with a message that names
 * the actual problem.
 *
 * Syntactic and incomplete — `[^)]*` cannot span a nested group, so a quantifier
 * two levels down is invisible to it. Kept anyway: it costs nothing and removes
 * the patterns most likely to be slow before any probe is run against them.
 */
function hasNestedQuantifier(pattern: string): boolean {
    return /\([^)]*[*+}][^)]*\)\s*(?:[*+]|\{\d*,\})/.test(pattern);
}

/**
 * Is this constraint tight enough to approve?
 *
 * Pure and total. Called at SAVE time — when a human is about to accept a
 * template — never per dispatch.
 */
export function refusalForConstraint(constraint: ValueConstraint): ConstraintRefusal | null {
    switch (constraint.kind) {
        case 'enum': {
            const values = constraint.values;
            if (values.length === 0) {
                // Not "too wide" — unsatisfiable. A field no value can fill
                // makes the tool uncallable, which is a configuration error that
                // would otherwise surface as a refusal at dispatch.
                return {
                    code: 'constraint_enum_empty',
                    detail:
                        'An enum constraint with no values admits nothing, so the field can never be filled.',
                };
            }
            if (values.length > MAX_ENUM_VALUES) {
                return {
                    code: 'constraint_enum_too_many',
                    detail:
                        `An enum of ${values.length} values is past the ${MAX_ENUM_VALUES} a reviewer is ` +
                        `asked to read. A list this long is a population, not a choice — bound the field ` +
                        `by a named population instead.`,
                };
            }
            if (values.some((v) => typeof v !== 'string')) {
                return {
                    code: 'constraint_enum_not_strings',
                    detail:
                        'Enum values must be strings; the dispatched argument is compared by identity.',
                };
            }
            if (new Set(values).size !== values.length) {
                return {
                    code: 'constraint_enum_duplicates',
                    detail:
                        'Enum values must be distinct — a duplicate means the list was edited, not reviewed.',
                };
            }
            if (values.some((v) => v.length > MAX_VALUE_LENGTH)) {
                return {
                    code: 'constraint_enum_value_too_long',
                    detail: `No enum value may exceed ${MAX_VALUE_LENGTH} characters.`,
                };
            }
            return null;
        }

        case 'integer': {
            const { min, max } = constraint;
            // `Number.isInteger` is false for Infinity and NaN, so this is also
            // the recorded design's "a numeric range with no upper bound is
            // refused" — an unbounded range cannot be expressed here at all.
            if (!Number.isInteger(min) || !Number.isInteger(max)) {
                return {
                    code: 'constraint_range_not_integers',
                    detail:
                        'An integer range needs finite integer bounds — a fractional or unbounded bound has ' +
                        'no reviewable meaning.',
                };
            }
            if (max < min) {
                return {
                    code: 'constraint_range_inverted',
                    detail: `An integer range with max (${max}) below min (${min}) admits nothing.`,
                };
            }
            return null;
        }

        case 'length': {
            const { min, max } = constraint;
            if (!Number.isInteger(min) || !Number.isInteger(max)) {
                return {
                    code: 'constraint_length_not_integers',
                    detail: 'A length bound needs finite integer bounds.',
                };
            }
            if (min < 1) {
                return {
                    code: 'constraint_length_admits_empty',
                    detail:
                        'A minimum length below 1 admits the empty string, which is "no value at all" ' +
                        'rather than a bounded one.',
                };
            }
            if (max < min) {
                return {
                    code: 'constraint_length_inverted',
                    detail: `A length bound with max (${max}) below min (${min}) admits nothing.`,
                };
            }
            if (max > MAX_VALUE_LENGTH) {
                return {
                    code: 'constraint_length_too_long',
                    detail: `A length bound may not exceed ${MAX_VALUE_LENGTH} characters.`,
                };
            }
            // NOT width-probed, and that distinction is what this module turns
            // on. "3 to 10 characters" states its own width; a reviewer reading
            // it knows exactly what it admits. The regex rules below exist
            // because a pattern's width is INVISIBLE, not because arbitrary
            // content is always wrong.
            return null;
        }

        case 'regex': {
            const { pattern } = constraint;
            if (typeof pattern !== 'string' || pattern.length === 0) {
                return {
                    code: 'constraint_pattern_empty',
                    detail: 'A regex constraint needs a pattern.',
                };
            }
            if (pattern.length > MAX_PATTERN_LENGTH) {
                return {
                    code: 'constraint_pattern_too_long',
                    detail:
                        `A ${pattern.length}-character pattern is past the ${MAX_PATTERN_LENGTH} this ` +
                        `accepts. A pattern nobody can read cannot be reviewed, and this length is where ` +
                        `backtracking blowups live.`,
                };
            }
            if (hasNestedQuantifier(pattern)) {
                return {
                    code: 'constraint_pattern_nested_quantifier',
                    detail:
                        'A quantifier applied to a group that already contains one (e.g. `(a+)+`) can ' +
                        'backtrack catastrophically. Rewrite it with a counted quantifier.',
                };
            }
            const re = compile(pattern);
            if (!re) {
                return {
                    code: 'constraint_pattern_invalid',
                    detail: 'The pattern is not a valid regular expression.',
                };
            }
            // Syntactic anchors. Kept for the MESSAGE — the padding probe below
            // catches the same class and more, but says so far less clearly.
            if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
                return {
                    code: 'constraint_pattern_unanchored',
                    detail:
                        'An unanchored pattern is a SUBSTRING test: `@company\\.test` matches ' +
                        '`evil@attacker.test?x=@company.test`. Anchor it with ^ and $.',
                };
            }
            if (re.test('')) {
                return {
                    code: 'constraint_pattern_admits_empty',
                    detail:
                        'The pattern matches the empty string, so it admits "no value at all".',
                };
            }
            // Does it admit arbitrary content? A predicate matching things this
            // unrelated is not describing one kind of value.
            const admitted = ARBITRARY_CONTENT_PROBES.filter((p) => re.test(p));
            if (admitted.length > 0) {
                return {
                    code: 'constraint_pattern_admits_arbitrary',
                    detail:
                        `The pattern admits content it cannot have meant to: ${JSON.stringify(admitted[0])}. ` +
                        `If the field really is "any string of a bounded length", say that with a length ` +
                        `bound, where the width is legible.`,
                };
            }
            // Anchored IN BEHAVIOUR. `^foo|bar$` passes the syntactic check and
            // anchors neither branch, because alternation binds looser than ^
            // and $; padding a match on both sides is what exposes it.
            const escapable = ANCHOR_PROBES.flatMap((p) =>
                re.test(p)
                    ? [`${p}${PAD}`, `${PAD}${p}`].filter((padded) => re.test(padded))
                    : [],
            );
            if (escapable.length > 0) {
                return {
                    code: 'constraint_pattern_anchor_escapable',
                    detail:
                        `The pattern still matches ${JSON.stringify(escapable[0])}, so its anchors do not ` +
                        `bind every branch — alternation binds looser than ^ and $, so \`^a|b$\` anchors ` +
                        `neither side. Wrap the alternation: \`^(?:a|b)$\`.`,
                };
            }
            // Bounded match length, which is also what keeps a dispatch-time
            // match cheap.
            const longA = 'a'.repeat(MAX_MATCHABLE_LENGTH + 1);
            const long0 = '0'.repeat(MAX_MATCHABLE_LENGTH + 1);
            if (re.test(longA) || re.test(long0)) {
                return {
                    code: 'constraint_pattern_unbounded_length',
                    detail:
                        `The pattern matches an input longer than ${MAX_MATCHABLE_LENGTH} characters, so ` +
                        `it does not bound the field's size. Replace an open \`+\` or \`*\` with a counted ` +
                        `quantifier such as \`{1,64}\`.`,
                };
            }
            return null;
        }
    }
}

/** Why a dispatched value is refused. `null` means it may be sent. */
export type ValueRefusal = { code: string; detail: string };

/**
 * Does this value satisfy an ALREADY-APPROVED constraint?
 *
 * Runs per dispatch, so it is ordered cheapest-first and caps the input before
 * any pattern is applied to it.
 */
export function refusalForValue(
    constraint: ValueConstraint,
    value: unknown,
): ValueRefusal | null {
    switch (constraint.kind) {
        case 'enum':
            if (typeof value !== 'string') {
                return { code: 'value_not_a_string', detail: 'An enum field takes a string.' };
            }
            if (!constraint.values.includes(value)) {
                return {
                    code: 'value_not_in_enum',
                    detail: `${JSON.stringify(value)} is not one of the approved values.`,
                };
            }
            return null;

        case 'integer':
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                return { code: 'value_not_an_integer', detail: 'This field takes an integer.' };
            }
            if (value < constraint.min || value > constraint.max) {
                return {
                    code: 'value_out_of_range',
                    detail: `${value} is outside the approved range ${constraint.min}..${constraint.max}.`,
                };
            }
            return null;

        case 'length':
            if (typeof value !== 'string') {
                return { code: 'value_not_a_string', detail: 'This field takes a string.' };
            }
            if (value.length < constraint.min || value.length > constraint.max) {
                return {
                    code: 'value_length_out_of_range',
                    detail:
                        `A ${value.length}-character value is outside the approved ` +
                        `${constraint.min}..${constraint.max}.`,
                };
            }
            return null;

        case 'regex': {
            if (typeof value !== 'string') {
                return { code: 'value_not_a_string', detail: 'This field takes a string.' };
            }
            // BEFORE the match, not after. An approved pattern is length-bounded
            // by `refusalForConstraint`, but this function must stay cheap even
            // when handed a row that predates that rule or was written by a path
            // this module does not own.
            if (value.length > MAX_VALUE_LENGTH) {
                return {
                    code: 'value_too_long',
                    detail: `A ${value.length}-character value is past the ${MAX_VALUE_LENGTH} ceiling.`,
                };
            }
            const re = compile(constraint.pattern);
            if (!re) {
                // Fail CLOSED. A stored pattern that no longer compiles is not a
                // reason to send the value unchecked.
                return {
                    code: 'value_constraint_uncompilable',
                    detail:
                        'The approved pattern for this field does not compile, so nothing can be ' +
                        'validated against it.',
                };
            }
            if (!re.test(value)) {
                return {
                    code: 'value_does_not_match',
                    detail: `${JSON.stringify(value)} does not match the approved pattern for this field.`,
                };
            }
            return null;
        }
    }
}
