/**
 * The earlier turns a request may carry, and how the server reads them (#5054).
 *
 * ═══ EVERYTHING IN HERE IS THE PERSON'S OWN TEXT ═══
 *
 * History arrives from the browser. The browser can send any "answer" it
 * likes, so an earlier assistant turn proves nothing: it is text the asker
 * supplied, exactly as the question is. The server therefore treats every
 * question AND every answer in it as untrusted input. It is scanned by the
 * same input guard as the question, refused by the same predicate, and given
 * to the model as earlier messages that the system prompt says are context and
 * never instructions.
 *
 * ═══ A LIST OF PAIRS, NOT A LIST OF MESSAGES ═══
 *
 * There is no `role` field. A role field is a value somebody can set to
 * `system` or `tool`, and a list of messages can carry two user turns in a
 * row, a tool result, or a proposal id. Pairs alternate by construction, and
 * `.strict()` refuses any other key with a 400, so nothing a request carries
 * here can look like a tool result or name a proposal. The one extra key,
 * `answerSeal`, is the server's own mark on an answer it gave
 * (`answer-seal.ts`): it spares that text a second scan and grants nothing.
 *
 * Server-only by convention: the browser imports `./limits`, never this file,
 * so the schema's zod import stays out of the client's reasons to load it.
 *
 * @module ai/assistant/history
 */
import { z } from 'zod';

import { ANSWER_SEAL_PATTERN } from './answer-seal';
import {
    ASSISTANT_HISTORY_MAX_CHARS,
    ASSISTANT_HISTORY_MAX_TURNS,
    ASSISTANT_QUESTION_MAX_CHARS,
    historyChars,
    type AssistantHistoryTurn,
} from './limits';

/**
 * Text with something in it. The provider refuses a whitespace-only text
 * block, and that refusal would reach the person as "the model was
 * unavailable", which is the wrong sentence for a request that was malformed.
 */
const NON_BLANK = /\S/;

export const AssistantHistoryTurnSchema = z
    .object({
        question: z.string().min(1).max(ASSISTANT_QUESTION_MAX_CHARS).regex(NON_BLANK),
        answer: z.string().min(1).max(ASSISTANT_HISTORY_MAX_CHARS).regex(NON_BLANK),
        /** See `answer-seal.ts`. Verified in `runGoverned`; a bad one only means "scan it". */
        answerSeal: z.string().regex(ANSWER_SEAL_PATTERN).optional(),
    })
    .strict();

export const AssistantHistorySchema = z
    .array(AssistantHistoryTurnSchema)
    .max(ASSISTANT_HISTORY_MAX_TURNS)
    .refine((turns) => historyChars(turns) <= ASSISTANT_HISTORY_MAX_CHARS, {
        message: `history is limited to ${ASSISTANT_HISTORY_MAX_CHARS} characters in total`,
    });

/** The guard `source` for history, so an audit row says which field carried an injection. */
export const HISTORY_GUARD_SOURCE = 'assistant:history';

/** The `details.reason` on the refusal of a request whose history the guard withheld. */
export const ASSISTANT_HISTORY_REFUSED = 'ASSISTANT_HISTORY_REFUSED';

/**
 * The whole history as one text, in order, for ONE guard scan.
 *
 * One scan rather than one per turn: every match a single turn would produce
 * still matches here (the blank-line separator keeps word boundaries and the
 * line-start anchors), and a payload split across two turns is caught too,
 * because the injection rules' spans cross a newline. It also writes at most
 * one audit row a request.
 *
 * NO ROLE LABELS. A line starting "assistant:" trips
 * `inj.system_role.declared`, so labelling the turns would refuse every
 * request that carried any history at all.
 */
export function historyGuardText(
    history: readonly AssistantHistoryTurn[],
    /**
     * True for an answer the server sealed for this asker (#5054). Such an
     * answer is the server's own text, already egress-guarded, and is left
     * out. Questions are never left out. Defaults to "nothing is vouched for".
     */
    answerIsServers: (turn: AssistantHistoryTurn) => boolean = () => false,
): string {
    return history.flatMap((t) => (answerIsServers(t) ? [t.question] : [t.question, t.answer])).join('\n\n');
}
