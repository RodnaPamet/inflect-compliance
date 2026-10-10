/**
 * The grant window's date vocabulary (#3351).
 *
 * This is the one field in the intent layer no model touches, because an end
 * date has no finite option set — so if a model produced it, the containment
 * argument ("the model only ever chooses from sets we control") would have a
 * hole exactly where the consequence is access outlasting what anyone agreed.
 *
 * What these cover, in order of how much they matter:
 *
 *   1. it REFUSES what it does not recognise, rather than guessing;
 *   2. the readings it does accept are the ones an operator means;
 *   3. it does NOT enforce MAX_GRANT_DAYS — that cap has one home, and a
 *      second copy here is the drift #3314 exists to prevent.
 */
import {
    readEndDatePhrase,
    describeDatePhraseRefusal,
    type DatePhraseRefusal,
} from '@/app-layer/ai/intent/relative-date';
import { MAX_GRANT_DAYS } from '@/app-layer/integrations/providers/entra-id/entitlement';

/** A Wednesday, so weekday arithmetic has a known answer. */
const NOW = new Date('2026-10-14T09:30:00.000Z');

const ok = (phrase: string) => {
    const r = readEndDatePhrase(phrase, NOW);
    if (!r.ok) throw new Error(`expected a date, got refusal ${r.refusal.kind}`);
    return r;
};
const refused = (phrase: string): DatePhraseRefusal => {
    const r = readEndDatePhrase(phrase, NOW);
    if (r.ok) throw new Error(`expected a refusal, got ${r.endDateTime.toISOString()}`);
    return r.refusal;
};

describe('it refuses rather than guessing', () => {
    it.each([
        ['the Thursday after next', 'a form it does not model'],
        ['end of the quarter', 'a business calendar it has no view of'],
        ['asap', 'not a date at all'],
        ['soon', 'not a date at all'],
        ['friday-ish', 'a weekday with noise'],
        ['in a while', 'no quantity'],
        ['2026-13-45', 'a date-shaped string that is not a date'],
        ['in 0 days', 'zero, which is two readings and neither is obvious'],
        ['last friday', 'a direction it does not model'],
        ['until friday', 'the preposition belongs to the caller, not here'],
    ])('refuses %s (%s)', (phrase) => {
        expect(refused(phrase).kind).toBe('unrecognised');
    });

    it('refuses an empty phrase as its own kind, not as unrecognised', () => {
        // Different causes get different sentences: "you left it blank" and
        // "I could not read that" send an operator to different places.
        expect(refused('   ').kind).toBe('empty');
    });

    it('refuses a date in the past, naming what it resolved to', () => {
        const r = refused('2020-01-01');
        expect(r.kind).toBe('in_the_past');
        if (r.kind !== 'in_the_past') return;
        expect(r.resolved.toISOString()).toMatch(/^2020-01-01/);
    });

});

describe('the readings an operator means', () => {
    it.each([
        ['2026-11-14', '2026-11-14T23:59:59.999Z', 'a bare date is the END of that day'],
        ['2026-11-14T17:00:00Z', '2026-11-14T17:00:00.000Z', 'an instant is taken exactly'],
        ['today', '2026-10-14T23:59:59.999Z', ''],
        ['tomorrow', '2026-10-15T23:59:59.999Z', ''],
        ['in 3 days', '2026-10-17T23:59:59.999Z', ''],
        ['in 2 weeks', '2026-10-28T23:59:59.999Z', ''],
        // NOW is a Wednesday. Friday is two days out.
        ['friday', '2026-10-16T23:59:59.999Z', 'the NEXT friday'],
        ['this friday', '2026-10-16T23:59:59.999Z', 'same as bare friday'],
        ['next friday', '2026-10-23T23:59:59.999Z', 'the one after this week'],
    ])('reads %s as %s %s', (phrase, expected) => {
        expect(ok(phrase).endDateTime.toISOString()).toBe(expected);
    });

    it('ACCEPTS "today", because end-of-day is still hours away', () => {
        // Which way this goes is a judgement, so it is pinned rather than
        // left to be discovered: "until today" resolves to the last instant
        // of today, not to now, so it is a real if short window.
        expect(ok('today').endDateTime.toISOString()).toBe('2026-10-14T23:59:59.999Z');
    });

    it('never returns TODAY for a bare weekday that is today', () => {
        // A grant "until wednesday" typed on a Wednesday means next week, not
        // "expiring in fourteen hours". `delta === 0 -> 7` is what does that,
        // and it is the easiest clause to lose.
        expect(ok('wednesday').endDateTime.toISOString()).toBe('2026-10-21T23:59:59.999Z');
    });

    it('is case and whitespace insensitive', () => {
        expect(ok('  NEXT   Friday ').endDateTime.toISOString()).toBe(
            ok('next friday').endDateTime.toISOString(),
        );
    });

    it('restates what it understood, including the resolved date', () => {
        // The restatement is the real check in this file. "Friday" is
        // ambiguous between two weeks; the reading is where that stops being
        // ambiguous for the operator BEFORE anything is proposed.
        expect(ok('next friday').reading).toContain('2026-10-23');
        expect(ok('next friday').reading).toMatch(/after this week/);
        expect(ok('in 2 weeks').reading).toContain('14 day(s)');
    });
});

describe('it does not duplicate the grant cap', () => {
    it(`reads a date well beyond MAX_GRANT_DAYS (${MAX_GRANT_DAYS}) without refusing`, () => {
        // DELIBERATE. `expiryRefusal` owns the cap and is applied downstream on
        // every path; a copy here would be two definitions of the same policy,
        // and #3314 records why that is the dangerous kind of duplication —
        // the one that drifts upward is the one nothing fails on.
        const far = new Date(NOW.getTime() + (MAX_GRANT_DAYS + 60) * 86_400_000);
        const r = readEndDatePhrase(far.toISOString().slice(0, 10), NOW);
        expect(r.ok).toBe(true);
    });
});

describe('every refusal has a sentence that names a remedy', () => {
    // Needles INLINE, not passed through `it.each`. A `toMatch(pattern)` whose
    // argument is a variable is un-analysable to Class C, and that cap exists
    // because a needle the analyser cannot read is one nobody can check
    // reaches what it names.
    it('an empty phrase says a grant must say when it ends', () => {
        expect(describeDatePhraseRefusal({ kind: 'empty' })).toMatch(/must say when it ends/i);
    });

    it('an unrecognised phrase lists the forms it does accept', () => {
        const s = describeDatePhraseRefusal({ kind: 'unrecognised', phrase: 'soon' });
        expect(s).toMatch(/Recognised forms/);
        // Actionable means naming them, not just saying there are some.
        for (const form of ['today', 'tomorrow', 'in 3 days', 'friday', 'next friday']) {
            expect(s).toContain(form);
        }
    });

    it('a past date names what it resolved to, so the reading is checkable', () => {
        expect(
            describeDatePhraseRefusal({
                kind: 'in_the_past',
                resolved: new Date('2020-01-01T00:00:00Z'),
            }),
        ).toMatch(/not in the future/);
    });
});
