/**
 * A DELIBERATELY SMALL date vocabulary for operator-typed grant windows (#3351).
 *
 * ═══ WHY NO MODEL TOUCHES THIS ═══
 *
 * The intent layer's containment argument is that the model only ever CHOOSES
 * from sets this product controls — a template from the approved list, a
 * subject from a resolved population — and never generates a value. An end
 * date is the one field with no finite option set, so if a model produced it,
 * that argument would have a hole exactly where the consequence is "access
 * lasts longer than anyone agreed".
 *
 * So this parses it instead, from a closed vocabulary, and REFUSES everything
 * it does not recognise. A refusal is cheap — the operator types a date — and
 * it is the only failure mode a parser this small has. The alternative, a
 * library that understands "the Thursday after next unless it's a holiday", is
 * a lot of behaviour nobody reviewed standing between a sentence and a
 * directory write.
 *
 * ═══ WHAT IT DOES NOT DO ═══
 *
 * It does NOT enforce `MAX_GRANT_DAYS`. That cap lives in `expiryRefusal` and
 * is checked downstream on every path, human or otherwise, and a second copy
 * here is the drift #3314 exists to prevent — the one that matters being the
 * quiet one. This answers "what instant did they name", not "may they have
 * it".
 *
 * ═══ UTC, AND "UNTIL <DAY>" MEANS THE END OF THAT DAY ═══
 *
 * Both are judgements, so both are stated rather than inferred. A grant
 * "until Friday" that expired at 00:00 on Friday would cut a day short of what
 * the operator meant, so a named day resolves to its last instant in UTC. The
 * resolved value is recorded on the proposal NEXT TO the phrase it came from,
 * which is what lets a reviewer catch a reading they disagree with — that
 * pairing is the real check here, not the parser's cleverness.
 */

/** Why a phrase could not be read as a date. Each is operator-facing. */
export type DatePhraseRefusal =
    | { readonly kind: 'empty' }
    | { readonly kind: 'unrecognised'; readonly phrase: string }
    | { readonly kind: 'in_the_past'; readonly resolved: Date };

export type DatePhraseResult =
    | { readonly ok: true; readonly endDateTime: Date; readonly reading: string }
    | { readonly ok: false; readonly refusal: DatePhraseRefusal };

const WEEKDAYS: Readonly<Record<string, number>> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
};

/** The last instant of `d`'s UTC day. */
function endOfUtcDay(d: Date): Date {
    return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
    );
}

function addUtcDays(from: Date, days: number): Date {
    return new Date(from.getTime() + days * 86_400_000);
}

/**
 * Read a phrase as the instant a grant should end, or refuse.
 *
 * `reading` is a plain-English restatement of what was understood, for the
 * operator to confirm BEFORE anything is proposed. "Friday" alone is ambiguous
 * between this week's and next; the restatement is where that stops being
 * ambiguous, and it names the resolved date so a disagreement is visible
 * without arithmetic.
 */
export function readEndDatePhrase(phrase: string, now: Date): DatePhraseResult {
    const text = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (text === '') return { ok: false, refusal: { kind: 'empty' } };

    const refuseUnrecognised: DatePhraseResult = {
        ok: false,
        refusal: { kind: 'unrecognised', phrase: phrase.trim() },
    };

    let resolved: Date | null = null;
    let reading = '';

    // An explicit instant or date, which is always allowed and never guessed at.
    if (/^\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?$/i.test(text)) {
        const parsed = new Date(/t/i.test(text) ? text : `${text}T23:59:59.999Z`);
        if (Number.isNaN(parsed.getTime())) return refuseUnrecognised;
        resolved = parsed;
        reading = /t/i.test(text)
            ? `the instant ${parsed.toISOString()}`
            : `the end of ${text} (UTC)`;
    } else if (text === 'today') {
        resolved = endOfUtcDay(now);
        reading = `the end of today, ${endOfUtcDay(now).toISOString().slice(0, 10)} (UTC)`;
    } else if (text === 'tomorrow') {
        resolved = endOfUtcDay(addUtcDays(now, 1));
        reading = `the end of tomorrow, ${resolved.toISOString().slice(0, 10)} (UTC)`;
    } else {
        const inDays = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(text);
        const weekday = /^(?:(next|this) )?([a-z]+)$/.exec(text);
        if (inDays) {
            const n = Number(inDays[1]);
            // Zero is refused rather than read as "today": "in 0 days" is not
            // something an operator types on purpose, and guessing which of
            // two readings they meant is the thing this file does not do.
            if (n === 0) return refuseUnrecognised;
            const days = inDays[2].startsWith('week') ? n * 7 : n;
            resolved = endOfUtcDay(addUtcDays(now, days));
            reading = `${days} day(s) from now, ending ${resolved.toISOString().slice(0, 10)} (UTC)`;
        } else if (weekday && Object.hasOwn(WEEKDAYS, weekday[2])) {
            const target = WEEKDAYS[weekday[2]];
            // "this friday" / bare "friday" mean the NEXT occurrence, and today
            // does not count: a grant until today would already be expiring.
            // "next friday" means the one after that.
            let delta = (target - now.getUTCDay() + 7) % 7;
            if (delta === 0) delta = 7;
            if (weekday[1] === 'next') delta += 7;
            resolved = endOfUtcDay(addUtcDays(now, delta));
            reading =
                `the end of ${weekday[2]} ${resolved.toISOString().slice(0, 10)} (UTC)`
                + (weekday[1] === 'next' ? ', the one after this week' : '');
        } else {
            return refuseUnrecognised;
        }
    }

    if (resolved.getTime() <= now.getTime()) {
        return { ok: false, refusal: { kind: 'in_the_past', resolved } };
    }
    return { ok: true, endDateTime: resolved, reading };
}

/**
 * Find the date phrase inside a sentence, or `null`.
 *
 * DETERMINISTIC, and scoped to the same closed vocabulary `readEndDatePhrase`
 * accepts — this is a scan for known forms, not an attempt to understand the
 * sentence. A model is never asked where the date is, for the same reason it
 * is never asked what the date is: there is no option set to constrain it to.
 *
 * The leading preposition is stripped here rather than in the vocabulary, so
 * "until friday" works in a sentence while the vocabulary itself stays a list
 * of date forms and nothing else. Deliberately narrow: "by", "until", "till",
 * "through" and "to" are the words an operator actually writes before a date.
 *
 * Returns the FIRST match. A sentence naming two dates is ambiguous, and the
 * restatement in `reading` is what surfaces that to the operator before
 * anything is proposed — the alternative, refusing on a second match, would
 * reject "move the friday review to next friday" for a date it read correctly.
 */
export function findEndDatePhrase(text: string): string | null {
    const t = text.toLowerCase();
    const forms = [
        // Longest-first, so "next friday" is not clipped to "friday" and
        // "in 2 weeks" is not read as a bare weekday.
        /\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/,
        /\b\d{4}-\d{2}-\d{2}\b/,
        /\bin \d{1,3} (?:days?|weeks?)\b/,
        /\bnext (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
        /\bthis (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
        /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
        /\btomorrow\b/,
        /\btoday\b/,
    ];
    let best: { index: number; match: string } | null = null;
    for (const re of forms) {
        const m = re.exec(t);
        if (m === null) continue;
        // Earliest in the sentence wins; within one position, the first
        // (longest) form in the list above wins, because it is tried first.
        if (best === null || m.index < best.index) best = { index: m.index, match: m[0] };
    }
    return best === null ? null : best.match;
}

/** The operator-facing sentence for a refusal. Never invents a date. */
export function describeDatePhraseRefusal(r: DatePhraseRefusal): string {
    switch (r.kind) {
        case 'empty':
            return 'No end date was given. A grant must say when it ends.';
        case 'unrecognised':
            return (
                `"${r.phrase}" was not understood as an end date. Recognised forms are a date `
                + '(2026-11-14), an instant (2026-11-14T17:00:00Z), "today", "tomorrow", '
                + '"in 3 days", "in 2 weeks", a weekday ("friday"), or "next friday". '
                + 'Anything else is refused rather than guessed at.'
            );
        case 'in_the_past':
            return (
                `That resolves to ${r.resolved.toISOString()}, which is not in the future, so `
                + 'nothing was proposed.'
            );
        default: {
            const unreachable: never = r;
            return unreachable;
        }
    }
}
