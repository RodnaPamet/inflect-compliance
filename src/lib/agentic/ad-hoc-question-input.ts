/**
 * READ THE QUESTION A PERSON TYPED (#3869).
 *
 * The most attacker-shaped input in the product: free text, typed by a person,
 * delivered to a model. `run-message.ts` already fences and labels it as
 * `agent.run-input` so the model meets it as data rather than instruction —
 * that is the model-facing half and this module does not repeat it. What this
 * does is decide whether the text is a QUESTION at all, before anything spends
 * a token on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CAP IS MEASURED ON THE RAW INPUT, BEFORE SANITISING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Order matters and the obvious order is the wrong one. `sanitizePlainText`
 * can only SHRINK its input — it strips tags and attributes — so sanitising
 * first and capping after means a megabyte of markup is decoded, parsed and
 * rebuilt before anyone asks whether it was allowed to be that big. That is
 * the same mistake as `res.text()` followed by a length check: by the time you
 * could measure it, you have already done the work and held it all in memory.
 *
 * So the raw length is refused first. The consequence is deliberate: 2500
 * characters of markup that would sanitise down to fifty is REFUSED rather
 * than accepted, because the cap is on what a person typed, and something
 * needing 2450 characters of markup is not a question.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A NON-STRING IS REFUSED, NOT COERCED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `sanitizePlainText` returns `''` for `null`, `undefined` and any non-string.
 * That is right for ITS job and wrong to rely on here: a number, an object or
 * an array would become an empty string and then be refused as "empty", which
 * reports the wrong cause to the caller and hides a client sending the wrong
 * shape. The type is checked first so the refusal names what happened.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SANITISING TO NOTHING IS ITS OWN REFUSAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `<script>alert(1)</script>` is within the cap and is a non-empty string, and
 * after sanitising there is no question left. Accepting it would start a run,
 * spend a tenant's tokens and file an Art 12 decision record for a question
 * nobody asked. So the check is on the SANITISED text being non-empty, which
 * is a different fact from the raw text being non-empty — and asserting only
 * the latter is how an empty question gets through.
 */
import { sanitizePlainText } from '@/lib/security/sanitize';
import { AD_HOC_QUESTION_MAX_CHARS } from './workflows/ad-hoc-question';

/** Why a question was not accepted, as a named code. */
export type AdHocQuestionRefusal =
    /** Not a string at all — a client sent the wrong shape. */
    | 'QUESTION_NOT_TEXT'
    /** Nothing was typed, or only whitespace. */
    | 'QUESTION_EMPTY'
    /** Longer than `AD_HOC_QUESTION_MAX_CHARS`, measured on the RAW input. */
    | 'QUESTION_TOO_LONG'
    /** Within the cap, but nothing survived sanitising. */
    | 'QUESTION_NOT_READABLE';

export type AdHocQuestionReading =
    | { readonly ok: true; readonly question: string }
    | {
          readonly ok: false;
          readonly refusal: AdHocQuestionRefusal;
          readonly detail: string;
      };

/**
 * The question, sanitised and bounded, or the named reason it is not one.
 *
 * The returned string is what should reach the run input: nothing else should
 * re-read the raw value, because two readers of one untrusted input eventually
 * disagree about what it says.
 */
export function readAdHocQuestion(raw: unknown): AdHocQuestionReading {
    // 1. SHAPE, before anything treats it as text.
    if (typeof raw !== 'string') {
        return {
            ok: false,
            refusal: 'QUESTION_NOT_TEXT',
            detail: `The question must be a string; received ${raw === null ? 'null' : typeof raw}.`,
        };
    }

    // 2. LENGTH, on the RAW input, before any parsing work is done on it.
    //    Measured in code units rather than bytes: the cap exists to bound a
    //    prompt and a context window, both of which are counted in characters,
    //    and a byte cap would refuse a legitimate question written in a script
    //    whose characters cost three bytes each.
    if (raw.length > AD_HOC_QUESTION_MAX_CHARS) {
        return {
            ok: false,
            refusal: 'QUESTION_TOO_LONG',
            detail:
                `The question is ${raw.length} characters; the limit is ${AD_HOC_QUESTION_MAX_CHARS}. ` +
                'Ask a shorter question, or attach the material as evidence and ask about it.',
        };
    }

    // 3. EMPTY, told apart from "unreadable" below. A caller that sent nothing
    //    and a caller that sent only markup are different problems.
    if (raw.trim() === '') {
        return { ok: false, refusal: 'QUESTION_EMPTY', detail: 'No question was supplied.' };
    }

    // 4. SANITISE, then re-check. Steps 3 and 4 are both needed: 3 catches an
    //    empty submission with the right reason, 4 catches an input that was
    //    not empty and is not a question.
    const question = sanitizePlainText(raw).trim();
    if (question === '') {
        return {
            ok: false,
            refusal: 'QUESTION_NOT_READABLE',
            detail: 'Nothing readable remained after the question was sanitised — it carried no text, only markup.',
        };
    }

    return { ok: true, question };
}
