/**
 * One key-normalisation rule, two callers.
 *
 * `computeProvisionalPoints` (the submit path) did a raw `map[value]` lookup
 * while `computeAnswerPoints` (the review path) uppercased and mapped
 * booleans. So the lowercase literal the form submits ("yes") missed the
 * uppercase key the fixtures are written with ("YES") and scored ZERO —
 * silently, on 9 of 11 scoring YES_NO questions per shipped template.
 *
 * A vendor answering "no" to every security question scored the same as one
 * answering "yes". The provisional function's own docstring claimed it
 * mirrored the canonical one; it did not.
 *
 * These exercise the shared `answerPointsKey` directly, because the rule is
 * now one function and that is the thing that must not drift again.
 */
import {
    answerPointsKey,
    computeAnswerPoints,
    riskPointsFor,
} from '@/app-layer/services/vendor-scoring';

describe('answerPointsKey', () => {
    it.each([
        ['yes', 'YES'],
        ['no', 'NO'],
        ['YES', 'YES'],
        ['Partial', 'PARTIAL'],
    ])('uppercases %s -> %s', (input, expected) => {
        expect(answerPointsKey(input)).toBe(expected);
    });

    it.each([
        [true, 'YES'],
        [false, 'NO'],
    ])('maps boolean %s -> %s', (input, expected) => {
        expect(answerPointsKey(input)).toBe(expected);
    });

    it('unwraps the { value } envelope the forms submit', () => {
        expect(answerPointsKey({ value: 'yes' })).toBe('YES');
    });

    it('stringifies a number', () => {
        expect(answerPointsKey(3)).toBe('3');
    });

    it.each([null, undefined, [], {}])('returns null for %s — not a bare key', (v) => {
        expect(answerPointsKey(v)).toBeNull();
    });
});

describe('the submit path scores the same as the review path', () => {
    const question = {
        id: 'q1',
        riskPointsJson: { YES: 0, NO: 10 },
    } as unknown as Parameters<typeof computeAnswerPoints>[0];

    it.each([
        ['yes', 0],
        ['no', 10],
        ['YES', 0],
        ['NO', 10],
    ])('a %s answer scores %s regardless of case', (answer, expected) => {
        expect(
            computeAnswerPoints(question, { answerJson: answer } as never),
        ).toBe(expected);
    });

    it('a lowercase answer is NOT silently zero — the defect, stated', () => {
        // Before the fix the submit path returned 0 here, so a vendor
        // answering "no" to a security question scored as if they answered
        // "yes".
        expect(computeAnswerPoints(question, { answerJson: 'no' } as never)).toBe(10);
    });
});

/**
 * The submit path is module-private, so it is pinned at the source.
 *
 * The tests above exercise `computeAnswerPoints` and the shared helper — and
 * I checked: they ALL PASS with the submit-path fix reverted, because the
 * canonical function was never the broken one. A test that cannot fail when
 * the fix is removed is not covering the fix.
 *
 * Same shape as the defect itself: two things that look correct in isolation,
 * with the bug living between them.
 */
describe('computeProvisionalPoints uses the shared normalisation', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/app-layer/usecases/vendor-assessment-response.ts'),
        'utf8',
    );

    it('imports the shared lookup', () => {
        expect(src).toMatch(/import \{ riskPointsFor \} from '@\/app-layer\/services\/vendor-scoring'/);
    });

    it('does NOT do a raw map[value] lookup', () => {
        // The exact defect: `map[value]` with the submitted literal, which
        // missed the uppercase fixture key.
        expect(src).not.toMatch(/typeof map\[value\] === 'number'/);
        expect(src).toMatch(/riskPointsFor\(q\.riskPointsJson, value\)/);
    });
});

/**
 * BOTH key conventions score, which is the point.
 *
 * Uppercasing everywhere fixes the shipped fixtures (`YES`/`NO`) and BREAKS
 * lowercase maps — and lowercase maps exist: an existing suite is written
 * against `{ yes: 0, no: 5 }`, which is the only reason the second convention
 * surfaced. Forcing one convention would have traded a silent zero on one set
 * of templates for a silent zero on the other.
 */
describe('riskPointsFor handles both key conventions', () => {
    it.each([
        [{ YES: 0, NO: 10 }, 'no', 10],
        [{ YES: 0, NO: 10 }, 'NO', 10],
        [{ yes: 0, no: 5 }, 'no', 5],
        [{ yes: 0, no: 5 }, 'NO', 5],
        [{ Yes: 1, No: 7 }, 'no', 7],
    ])('map %p with answer %s scores %s', (map, answer, expected) => {
        expect(riskPointsFor(map, answer)).toBe(expected);
    });

    it('unwraps the { value } envelope against either convention', () => {
        expect(riskPointsFor({ NO: 10 }, { value: 'no' })).toBe(10);
        expect(riskPointsFor({ no: 10 }, { value: 'NO' })).toBe(10);
    });

    it('returns null (not 0) when the answer is genuinely absent from the map', () => {
        // null lets the caller distinguish "no mapping" from "mapped to zero",
        // which matters because 0 is a legitimate score.
        expect(riskPointsFor({ YES: 0, NO: 10 }, 'maybe')).toBeNull();
    });

    it('maps a boolean through either convention', () => {
        expect(riskPointsFor({ NO: 10 }, false)).toBe(10);
        expect(riskPointsFor({ no: 10 }, false)).toBe(10);
    });
});
