/**
 * READING THE QUESTION A PERSON TYPED (#3869).
 *
 * Four refusals, each named, and the ORDER between two of them is itself a
 * property worth testing rather than an implementation detail.
 *
 * ## Why the ordering case is the important one
 *
 * `sanitizePlainText` can only shrink its input, so "cap then sanitise" and
 * "sanitise then cap" accept different sets and do different amounts of work.
 * The second decodes, parses and rebuilds a megabyte of markup before asking
 * whether it was allowed to be that big — the same mistake as `res.text()`
 * followed by a length check. A test that only used plain text would pass under
 * either order and prove nothing about which one shipped.
 *
 * Mutation-proved (2026-10-22): moving the length check onto the SANITISED
 * value — the order this file argues against — fails exactly the ordering case
 * and nothing else. So that one test is what holds the order, and the other
 * seventeen would have shipped either version.
 *
 * ## And why `QUESTION_EMPTY` and `QUESTION_NOT_READABLE` are separate
 *
 * A caller that sent nothing and a caller that sent only markup are different
 * problems — a bug in a form versus something trying its luck. Collapsing them
 * into one code would make the logs unable to tell those apart, which is the
 * whole reason these are named codes and not a boolean.
 */
import { readAdHocQuestion } from '@/lib/agentic/ad-hoc-question-input';
import { AD_HOC_QUESTION_MAX_CHARS } from '@/lib/agentic/workflows/ad-hoc-question';

describe('a real question is accepted and comes back sanitised', () => {
    it('passes plain text through unchanged', () => {
        const out = readAdHocQuestion('Which controls have no evidence this quarter?');
        expect(out).toEqual({ ok: true, question: 'Which controls have no evidence this quarter?' });
    });

    it('strips markup but keeps the question inside it', () => {
        // The text survives; the tags do not. Asserted on a case that has BOTH,
        // because an input that is only markup is a different case below and an
        // input that is only text would not exercise the stripping at all.
        const out = readAdHocQuestion('<b>Which</b> controls are <i>overdue</i>?');
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.question).toContain('Which');
            expect(out.question).toContain('overdue');
            expect(out.question).not.toContain('<b>');
            expect(out.question).not.toContain('<i>');
        }
    });

    it('trims, so leading whitespace is not sent to the model as content', () => {
        const out = readAdHocQuestion('   Which risks are untreated?   ');
        if (out.ok) expect(out.question).toBe('Which risks are untreated?');
    });

    it('accepts a question exactly at the cap — the boundary is inclusive', () => {
        // Off-by-one in the forgiving direction is still a defect: a stated
        // limit that refuses the stated length is a limit nobody can rely on.
        const atCap = 'a'.repeat(AD_HOC_QUESTION_MAX_CHARS);
        expect(readAdHocQuestion(atCap).ok).toBe(true);
    });
});

describe('a non-string is refused by SHAPE, never coerced', () => {
    // `sanitizePlainText` returns '' for all of these, so without an explicit
    // type check each would be reported as "empty" — the wrong cause, and one
    // that hides a client sending the wrong shape entirely.
    it.each([
        ['a number', 42, 'number'],
        ['an object', { question: 'x' }, 'object'],
        ['an array', ['x'], 'object'],
        ['undefined', undefined, 'undefined'],
        ['null', null, 'null'],
    ])('refuses %s with QUESTION_NOT_TEXT, naming what arrived', (_label, value, named) => {
        const out = readAdHocQuestion(value);
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.refusal).toBe('QUESTION_NOT_TEXT');
            // The detail names the received type, so a client error is
            // diagnosable from the log without reproducing it.
            expect(out.detail).toContain(named);
        }
    });
});

describe('the cap is measured on the RAW input, before any sanitising', () => {
    it('refuses one character over the cap', () => {
        const out = readAdHocQuestion('a'.repeat(AD_HOC_QUESTION_MAX_CHARS + 1));
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.refusal).toBe('QUESTION_TOO_LONG');
            // The actual length is reported, not just the limit: "too long" with
            // no number leaves the caller guessing how much to cut.
            expect(out.detail).toContain(String(AD_HOC_QUESTION_MAX_CHARS + 1));
        }
    });

    it('THE ORDERING CASE: over-cap markup that would sanitise small is still refused', () => {
        // This is the assertion that distinguishes the two possible orders.
        // Padding is an HTML comment, which `sanitizePlainText` removes
        // entirely — so the sanitised form is a handful of characters and would
        // sail under the cap if sanitising ran first.
        const padding = `<!--${'x'.repeat(AD_HOC_QUESTION_MAX_CHARS * 2)}-->`;
        const raw = `${padding}Hi?`;
        expect(raw.length).toBeGreaterThan(AD_HOC_QUESTION_MAX_CHARS);

        const out = readAdHocQuestion(raw);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refusal).toBe('QUESTION_TOO_LONG');

        // The positive half, so this is not just "big things are refused":
        // the SAME tiny question, without the padding, is accepted. Without
        // this the case above would pass for a reader that refused everything.
        const small = readAdHocQuestion('Hi?');
        expect(small.ok).toBe(true);
    });
});

describe('empty and unreadable are told apart', () => {
    it.each([[''], ['   '], ['\n\t  \n']])('refuses %p with QUESTION_EMPTY', (raw) => {
        const out = readAdHocQuestion(raw);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refusal).toBe('QUESTION_EMPTY');
    });

    it.each([['<script>alert(1)</script>'], ['<div><span></span></div>'], ['<!-- just a comment -->']])(
        'refuses %p with QUESTION_NOT_READABLE — not empty, and not a question',
        (raw) => {
            // Within the cap and a non-empty string, so only the SANITISED
            // emptiness check catches it. Accepting one of these would start a
            // run, spend a tenant's tokens and file an Art 12 decision record
            // for a question nobody asked.
            expect(raw.trim()).not.toBe('');
            expect(raw.length).toBeLessThanOrEqual(AD_HOC_QUESTION_MAX_CHARS);

            const out = readAdHocQuestion(raw);
            expect(out.ok).toBe(false);
            if (!out.ok) expect(out.refusal).toBe('QUESTION_NOT_READABLE');
        },
    );

    it('and the two codes are distinct, so the logs can tell them apart', () => {
        const empty = readAdHocQuestion('  ');
        const markup = readAdHocQuestion('<span></span>');
        expect(empty.ok).toBe(false);
        expect(markup.ok).toBe(false);
        if (!empty.ok && !markup.ok) expect(empty.refusal).not.toBe(markup.refusal);
    });
});
