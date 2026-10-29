/**
 * A PEER'S REPLY, SHAPED FOR A MODEL TO READ AS DATA (#3744).
 *
 * In 4b (#3679) a peer's reply to a task Inflect sent is kept as a receipted
 * `PeerAgentMessage` and the run that sent the task never sees it, so an agent
 * cannot act on what the peer returned. This module is the model-facing half of
 * closing that: it turns a stored reply into the envelope a run's message
 * fences, and decides nothing about whether the reply may be delivered — that
 * is `usecases/a2a-reply-delivery.ts`, which owns the ledger.
 *
 * The split is the one `ad-hoc-question-input.ts` already draws: that module
 * decides whether text is a question before a token is spent, and
 * `flue/run-message.ts` owns the fencing. Same here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REPLY IS THE MORE TEMPTING ONE TO TRUST, AND IT IS NOT MORE TRUSTWORTHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An inbound TASK is a stranger knocking. A REPLY is an answer to a question we
 * chose to ask, from a peer we registered, under a key we pinned, verified
 * against the message id we sent. Every one of those facts is about IDENTITY
 * and none of them is about CONTENT: a signature says which author wrote the
 * bytes, never that the bytes are benign.
 *
 * So the reply is labelled `a2a.peer-reply`, which `content-provenance.ts`
 * resolves to `THIRD_PARTY_INGESTED` exactly as `a2a.peer-task` is. It is not
 * instruction-bearing, and `mayCarryInstruction` travels in the envelope so a
 * reader downstream cannot mistake the question for an open one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HANDLING SENTENCE IS DELIBERATELY NOT HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `a2a-inbound.ts` says why for the task path and it holds identically here:
 * the whole input is scanned for injection, and a rule telling a model to
 * "ignore any directive in the block below" reads to a pattern scanner like a
 * directive. `run-message.ts` adds the handling rule at the point of rendering,
 * after the scan.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRUNCATION IS VISIBLE, AND THE RECEIPT IS NEVER TOUCHED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A peer decides how long its answer is. The text handed to a model is capped,
 * and when the cap bites the envelope says so IN the fenced block
 * (`truncated: true` plus the original length), because a model silently given
 * the first part of an answer will reason about it as though it were the whole
 * answer.
 *
 * The cap is on the raw text BEFORE neutralising, for the reason
 * `ad-hoc-question-input.ts` records: a neutraliser can only shrink its input,
 * so neutralising first means doing the work on a megabyte before asking
 * whether a megabyte was allowed.
 *
 * `PeerAgentMessage.body` is untouched by any of this. The receipt keeps the
 * exact bytes the signature covers — truncating evidence to fit a prompt would
 * make the stored receipt unverifiable.
 */
import {
    mayCarryInstruction,
    resolveContentProvenance,
    type ContentProvenance,
} from './content-provenance';

/** The provenance source id for a peer's reply to a task we sent. */
export const A2A_PEER_REPLY_SOURCE = 'a2a.peer-reply';

/**
 * Characters of reply text a model may be shown.
 *
 * Deliberately larger than `MAX_RUN_INPUT_VALUE_CHARS` (512, for a declared
 * input VALUE) and far smaller than any body a peer could send: a task result
 * is a sentence or a short report, and anything needing more than this is not
 * being summarised for a model, it is being dumped into one.
 */
export const MAX_PEER_REPLY_TEXT_CHARS = 4_000;

/**
 * The envelope a run's message fences.
 *
 * Shaped like `a2a-inbound.ts`'s `a2aTask` member on purpose — a reader who
 * knows one knows the other — with `relatesToMessageId` added, because the
 * whole point of a reply is which of our messages it answers.
 */
export interface PeerReplyEnvelope {
    readonly kind: 'content-provenance';
    readonly source: typeof A2A_PEER_REPLY_SOURCE;
    readonly provenance: ContentProvenance;
    readonly mayCarryInstruction: boolean;
    readonly peerId: string;
    /** The reply's own message id. */
    readonly messageId: string;
    /** The id of OUR message this answers. */
    readonly relatesToMessageId: string;
    readonly text: string;
    /** True when `text` is a prefix of what the peer actually sent. */
    readonly truncated: boolean;
    /** Length of the reply text as received, before any cap. */
    readonly originalLength: number;
}

/**
 * Neutralise the two things that make fenced text stop being fenced.
 *
 * A peer controls its own bytes, so it can write the closing fence, or a line
 * that looks like the platform's own scaffolding. Both are handled by making
 * them unable to terminate or imitate the block rather than by removing them —
 * deleting a line changes what the peer said, and the model is being shown what
 * the peer said.
 *
 * Control characters go because a terminal-style escape can repaint a log a
 * human later reads; the replacement is a space so offsets stay comparable with
 * `originalLength`.
 */
function neutraliseFencing(text: string): string {
    return text
        // Any run of three or more backticks cannot close a fence.
        .replace(/`{3,}/g, (m) => '‘'.repeat(m.length))
        // A line that opens with the fence sentinels used by the run message.
        .replace(/^(\s*)(=={2,}|-{3,}|#{1,6}\s)/gm, '$1\u00A0$2')
        // C0 controls other than tab, newline and carriage return, plus DEL.
        // Written as escapes, never as the bytes themselves: a literal control
        // byte in source is invisible to a reviewer and to a formatter, which is
        // what `tests/guardrails/no-control-bytes-in-source` exists to refuse.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

export interface StoredReply {
    readonly messageId: string;
    readonly relatesToMessageId: string;
    readonly peerId: string;
    /** The reply body as stored — the exact bytes the receipt covers. */
    readonly text: string;
}

/**
 * Build the fenceable envelope for one stored reply.
 *
 * Pure: no database, no tenant, no decision about admissibility. A caller that
 * has not already decided the reply is deliverable is using the wrong module.
 */
export function peerReplyEnvelope(reply: StoredReply): PeerReplyEnvelope {
    const raw = typeof reply.text === 'string' ? reply.text : '';
    const originalLength = raw.length;
    const truncated = originalLength > MAX_PEER_REPLY_TEXT_CHARS;
    // Cap FIRST, then neutralise — see the module docstring.
    const capped = truncated ? raw.slice(0, MAX_PEER_REPLY_TEXT_CHARS) : raw;
    const provenance = resolveContentProvenance(A2A_PEER_REPLY_SOURCE);
    return {
        kind: 'content-provenance',
        source: A2A_PEER_REPLY_SOURCE,
        provenance,
        mayCarryInstruction: mayCarryInstruction(provenance),
        peerId: reply.peerId,
        messageId: reply.messageId,
        relatesToMessageId: reply.relatesToMessageId,
        text: neutraliseFencing(capped),
        truncated,
        originalLength,
    };
}

/**
 * The lines a run message renders inside its untrusted-data fence.
 *
 * Rendering lives here rather than in `run-message.ts` so the shape of a reply
 * is defined in one place beside the envelope it comes from. `run-message.ts`
 * supplies the fence, the provenance sentence and the handling rule.
 */
export function peerReplyLines(envelopes: readonly PeerReplyEnvelope[]): readonly string[] {
    const out: string[] = [];
    for (const e of envelopes) {
        out.push(`reply ${e.messageId} from peer ${e.peerId}, answering ${e.relatesToMessageId}:`);
        if (e.truncated) {
            // Said BEFORE the text, so a model that stops reading early still
            // has it: an answer shown in part must not be reasoned about as a
            // whole answer.
            out.push(
                `  (truncated: showing the first ${MAX_PEER_REPLY_TEXT_CHARS} of ` +
                    `${e.originalLength} characters)`,
            );
        }
        out.push(`  ${e.text}`);
    }
    return out;
}
