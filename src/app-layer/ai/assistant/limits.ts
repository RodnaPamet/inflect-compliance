/**
 * How much text a person may send the assistant in one request (#5054).
 *
 * ═══ ONE MODULE, TWO READERS, NO IMPORTS ═══
 *
 * The question limit and the history bounds are read by the server schema
 * (`AskAssistantSchema`, `AssistantHistorySchema`) AND by the browser (the
 * counter and the over-limit refusal in `AssistantSheet`). Two copies would
 * disagree the first time one moved, and the disagreement would be a client
 * that sends a question the server rejects, or one that refuses a question the
 * server would take. So the numbers live once, here.
 *
 * This file imports NOTHING, on purpose. The client imports it, and anything
 * it imported would ship in the browser bundle: `spend-ceiling.ts` reaches the
 * rate limiter and from there `@/env`, which
 * `tests/guards/client-reachable-modules-import-no-server-env.test.ts` refuses.
 * The dependency runs the other way: `spend-ceiling.ts` imports these numbers.
 *
 * ═══ "CHARACTERS" MEANS UTF-16 CODE UNITS ═══
 *
 * `String.length` and zod's `.max()` both count UTF-16 code units, so the
 * client counter and the server schema never disagree about a length. One code
 * unit is at most 3 UTF-8 bytes, and no model token is shorter than one byte,
 * so `chars × 3` is a hard upper bound on tokens. The arithmetic that chose
 * these numbers is in `spend-ceiling.ts` (`ASSISTANT_USER_INPUT_CEILING`) and
 * pinned by `tests/unit/ai/assistant-spend-ceiling.test.ts`.
 *
 * @module ai/assistant/limits
 */

/**
 * The longest question, in characters.
 *
 * 8,000 × 3 = 24,000 bytes, which is exactly `DEFAULT_LOOP_BOUNDS.resultBytes`:
 * a question can never be larger than one tool result the loop already
 * accepts. About three pages, which is enough for "here is our onboarding
 * process, turn it into a map" (#5053).
 */
export const ASSISTANT_QUESTION_MAX_CHARS = 8_000;

/** At most this many earlier exchanges (one question and its answer each) go with a request. */
export const ASSISTANT_HISTORY_MAX_TURNS = 6;

/** At most this many characters of earlier questions and answers, summed, go with a request. */
export const ASSISTANT_HISTORY_MAX_CHARS = 24_000;

/** One UTF-16 code unit encodes to at most this many UTF-8 bytes. */
export const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

/** One earlier exchange, as the browser sends it. No role, no ids, no tool output. */
export interface AssistantHistoryTurn {
    readonly question: string;
    readonly answer: string;
    /**
     * The server's seal on `answer`, exactly as the answer came back
     * (`ai/assistant/answer-seal.ts`). It only spares the server's own words a
     * second injection scan; it names nothing and grants nothing. Absent, or
     * over any other text, and the answer is scanned like a question.
     */
    readonly answerSeal?: string;
}

/** The characters a history spends against {@link ASSISTANT_HISTORY_MAX_CHARS}. */
export function historyChars(turns: readonly AssistantHistoryTurn[]): number {
    let total = 0;
    for (const t of turns) total += t.question.length + t.answer.length;
    return total;
}

/** Appended to an answer this module shortened, so the model can tell it was cut. */
export const HISTORY_TRIM_MARKER = '\n[…]';

/**
 * The most recent turns that fit the bounds, oldest first.
 *
 * Walks back from the newest turn and takes WHOLE turns while both caps hold.
 * Only the newest turn may be shortened, and only its answer, cut from the end:
 * its question is what a follow-up such as "now make it a map" refers to, so it
 * is kept whole. The first older turn that does not fit ends the window — a
 * gap in the middle of a conversation would leave the model reading a reply to
 * a question it was never shown.
 *
 * `dropped` counts eligible turns left out, so the UI can say so.
 */
export function selectHistoryWindow(eligible: readonly AssistantHistoryTurn[]): {
    readonly turns: AssistantHistoryTurn[];
    readonly dropped: number;
} {
    const picked: AssistantHistoryTurn[] = [];
    let chars = 0;
    for (let i = eligible.length - 1; i >= 0; i -= 1) {
        if (picked.length >= ASSISTANT_HISTORY_MAX_TURNS) break;
        const turn = eligible[i];
        // A turn the server would refuse ends the window rather than the request.
        if (turn.question.length > ASSISTANT_QUESTION_MAX_CHARS) break;
        if (!/\S/.test(turn.question) || !/\S/.test(turn.answer)) break;
        const size = turn.question.length + turn.answer.length;
        if (chars + size <= ASSISTANT_HISTORY_MAX_CHARS) {
            picked.push(turn);
            chars += size;
            continue;
        }
        if (picked.length > 0) break;
        // The newest turn alone is too long. Keep its question whole and cut
        // its answer to the room left, marker included. The seal is NOT kept:
        // it was over the whole answer, so the cut answer is scanned instead.
        const room = ASSISTANT_HISTORY_MAX_CHARS - turn.question.length - HISTORY_TRIM_MARKER.length;
        if (room <= 0) break;
        const head = cutAtCodePoint(turn.answer, room).trimEnd();
        if (!/\S/.test(head)) break;
        picked.push({ question: turn.question, answer: head + HISTORY_TRIM_MARKER });
        chars = ASSISTANT_HISTORY_MAX_CHARS;
    }
    picked.reverse();
    return { turns: picked, dropped: eligible.length - picked.length };
}

/** `text` cut to at most `max` code units, never splitting a surrogate pair. */
function cutAtCodePoint(text: string, max: number): string {
    if (text.length <= max) return text;
    let end = max;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
}
