/**
 * THE DEFERRAL TRANSCRIPT (Step 2f of `docs/claude-tool-runner-design.md`,
 * "3. The transcript", #5530).
 *
 * When a Tool Runner run defers a call to a person, it parks on the request it
 * would send next: the request's `system` and `tools` exactly as sent, every
 * earlier message, the assistant reply that made the call exactly as returned
 * (text, `tool_use` and `thinking` blocks with their signatures, in order), and
 * that turn's tool results with the deferred call's slot left open.
 *
 * BYTE-FAITHFUL. Written with `JSON.stringify` over the SDK's own objects and
 * read back with `JSON.parse`, never sanitised, never re-serialised through a
 * schema, never trimmed: a thinking block's signature binds those bytes, and an
 * edited block is one the API refuses. `parseTranscript` checks the envelope
 * and returns the parsed objects untouched.
 *
 * SEALED. The store keeps `sha256(transcriptJson)` beside the encrypted column,
 * as `WorkflowRun.contextHash` sits beside `contextJson`; a resume recomputes it
 * and halts on a mismatch rather than repairing anything.
 *
 * The deferred call's result is written into its slot at the resume, from the
 * PROPOSAL ROW (`decisionResult`), never from the transcript: the only new thing
 * a resumed conversation carries is the queue's decision.
 *
 * The CONTINUATION CHECKPOINT (#5854 item 3, below) is kept the same way: a
 * second format, `inflect-tool-runner-checkpoint/1`, for the conversation a
 * retried segment continues from.
 *
 * Pure: no Prisma, no SDK runtime, so the engine, the store and the tests share
 * one definition of the format.
 */
import { createHash } from 'crypto';

import type {
    BetaContentBlockParam,
    BetaMessageParam,
    BetaToolResultBlockParam,
    BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';

/** The format id a transcript names. A new shape is a new id, never a lenient reader of both. */
export const TRANSCRIPT_FORMAT = 'inflect-tool-runner-deferral/1';

/** One parked conversation. */
export interface DeferralTranscript {
    readonly format: typeof TRANSCRIPT_FORMAT;
    /** The model id the transcript was produced on, pinned for the resume. */
    readonly model: string;
    /** The request's `system`, as sent. */
    readonly system: BetaToolRunnerParams['system'];
    /** The request's tool definitions, as sent: the runnable tools less their functions. */
    readonly tools: readonly BetaToolUnion[];
    /** Every message up to and including the assistant reply that made the deferred call. */
    readonly messages: readonly BetaMessageParam[];
    /**
     * That turn's tool results, in order, the deferred call's slot open
     * (`content: ''`). Calls held behind the deferral carry the sentence that
     * says they were not run.
     */
    readonly pendingResults: readonly BetaToolResultBlockParam[];
    /** The deferred call's `tool_use` id: the open slot. */
    readonly toolUseId: string;
}

/** The serialised transcript and its seal. */
export function sealTranscript(transcript: DeferralTranscript): { json: string; hash: string } {
    const json = JSON.stringify(transcript);
    return { json, hash: transcriptHashOf(json) };
}

/** Hex SHA-256 of the stored plaintext. */
export function transcriptHashOf(json: string): string {
    return createHash('sha256').update(json, 'utf8').digest('hex');
}

/** Why a stored transcript could not be resumed from. */
export type TranscriptRefusal = 'UNSEALED' | 'UNREADABLE';

/**
 * Open a stored transcript: the seal first, then the envelope. The parsed
 * objects are returned as `JSON.parse` produced them; nothing inside a message
 * is validated, rewritten or dropped.
 */
export function openTranscript(
    json: string,
    hash: string,
): { ok: true; transcript: DeferralTranscript } | { ok: false; reason: TranscriptRefusal } {
    if (transcriptHashOf(json) !== hash) return { ok: false, reason: 'UNSEALED' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { ok: false, reason: 'UNREADABLE' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'UNREADABLE' };
    const t = parsed as Record<string, unknown>;
    const ok =
        t.format === TRANSCRIPT_FORMAT &&
        typeof t.model === 'string' &&
        t.model.length > 0 &&
        typeof t.toolUseId === 'string' &&
        Array.isArray(t.tools) &&
        Array.isArray(t.messages) &&
        t.messages.length > 0 &&
        Array.isArray(t.pendingResults) &&
        (t.pendingResults as unknown[]).some(
            (b) => !!b && typeof b === 'object' && (b as { tool_use_id?: unknown }).tool_use_id === t.toolUseId,
        );
    if (!ok) return { ok: false, reason: 'UNREADABLE' };
    return { ok: true, transcript: parsed as DeferralTranscript };
}

/** The sentence a call held behind a deferral gets: it was not run, and may be made again. */
export const HELD_BEHIND_DEFERRAL_MESSAGE =
    'This call was not run: it was held behind a call waiting for a person\'s decision. You may make it again.';

/** The proposal row a decision result is written from. */
export interface DecidedProposal {
    readonly kind: string;
    readonly operation: string;
    readonly status: string;
    readonly createdEntityId: string | null;
}

/**
 * THE DEFERRED CALL'S RESULT, from the proposal row (point 5 of "4. Who
 * decides"). An approval names what was created; a rejection is an error
 * result and carries no reason, because the reason is a person's free text and
 * the model needs the fact, not the prose.
 */
export function decisionResult(proposal: DecidedProposal): { content: string; isError: boolean } {
    const applied = proposal.operation === 'UPDATE' ? 'It was applied to' : 'It was created as';
    const target = `${proposal.kind} ${proposal.createdEntityId ?? '(no record id was returned)'}`;
    if (proposal.status === 'ACCEPTED') {
        return { content: `A person approved this proposal. ${applied} ${target}.`, isError: false };
    }
    if (proposal.status === 'EDITED') {
        return { content: `A person approved this proposal with changes. ${applied} ${target}.`, isError: false };
    }
    return { content: 'A person rejected this proposal. Nothing was created.', isError: true };
}

/**
 * The messages a resumed segment sends: the stored ones, and the turn's tool
 * results as one user message with the deferred slot filled. Every stored
 * object is passed through as it was parsed.
 */
export function resumedMessages(transcript: DeferralTranscript, result: { content: string; isError: boolean }): BetaMessageParam[] {
    const results: BetaContentBlockParam[] = transcript.pendingResults.map((block) =>
        block.tool_use_id === transcript.toolUseId
            ? { ...block, content: result.content, ...(result.isError ? { is_error: true } : {}) }
            : block,
    );
    return [...transcript.messages, { role: 'user', content: results }];
}

// ─── THE CONTINUATION CHECKPOINT (#5854 item 3) ─────────────────────
//
// Owner decision of 2026-11-24: a Tool Runner run whose segment is retried, or
// taken over by another worker, CONTINUES its conversation. The engine keeps
// the conversation the way the deferral transcript is kept (byte-faithful,
// sealed, encrypted, cleared when the run ends) at every reply that asks for
// tools, and each call's result as it settles, so the next attempt sends the
// request the dead one would have sent next.

/** The format id a checkpoint names. A new shape is a new id, never a lenient reader of both. */
export const CHECKPOINT_FORMAT = 'inflect-tool-runner-checkpoint/1';

/**
 * One checkpointed conversation: the request that produced the last reply
 * asking for tools, and that reply. Its calls' results are kept beside it
 * (`resultsJson`), because they arrive one at a time.
 */
export interface ConversationCheckpoint {
    readonly format: typeof CHECKPOINT_FORMAT;
    /** The model id the conversation is on, pinned for the continuation. */
    readonly model: string;
    /** The request's `system`, as sent. */
    readonly system: BetaToolRunnerParams['system'];
    /** The request's tool definitions, as sent: the runnable tools less their functions. */
    readonly tools: readonly BetaToolUnion[];
    /** Every message of the request, then the assistant reply that asked for tools. */
    readonly messages: readonly BetaMessageParam[];
}

/** The serialised checkpoint and its seal. */
export function sealCheckpoint(checkpoint: ConversationCheckpoint): { json: string; hash: string } {
    const json = JSON.stringify(checkpoint);
    return { json, hash: transcriptHashOf(json) };
}

/** The serialised results and their seal. */
export function sealResults(results: readonly BetaToolResultBlockParam[]): { json: string; hash: string } {
    const json = JSON.stringify(results);
    return { json, hash: transcriptHashOf(json) };
}

/** The `tool_use` blocks of an assistant message, in order. */
export function toolUsesOf(message: BetaMessageParam | undefined): Array<{ id: string; name: string }> {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return [];
    return message.content.flatMap((block) =>
        block && typeof block === 'object' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
            ? [{ id: block.id, name: block.name }]
            : [],
    );
}

/**
 * Open a stored checkpoint and its results: both seals first, then both
 * envelopes. The parsed objects are returned as `JSON.parse` produced them;
 * nothing inside a message is validated, rewritten or dropped. The last
 * message must be an assistant reply that asked for at least one tool, and
 * every kept result must answer one of its calls, once.
 */
export function openCheckpoint(
    stored: { transcriptJson: string; transcriptHash: string; resultsJson: string | null; resultsHash: string | null },
):
    | { ok: true; checkpoint: ConversationCheckpoint; results: readonly BetaToolResultBlockParam[] }
    | { ok: false; reason: TranscriptRefusal } {
    if (transcriptHashOf(stored.transcriptJson) !== stored.transcriptHash) return { ok: false, reason: 'UNSEALED' };
    if (stored.resultsJson !== null && (stored.resultsHash === null || transcriptHashOf(stored.resultsJson) !== stored.resultsHash)) {
        return { ok: false, reason: 'UNSEALED' };
    }
    let parsed: unknown;
    let results: unknown;
    try {
        parsed = JSON.parse(stored.transcriptJson);
        results = stored.resultsJson === null ? [] : JSON.parse(stored.resultsJson);
    } catch {
        return { ok: false, reason: 'UNREADABLE' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(results)) {
        return { ok: false, reason: 'UNREADABLE' };
    }
    const t = parsed as Record<string, unknown>;
    if (
        t.format !== CHECKPOINT_FORMAT ||
        typeof t.model !== 'string' ||
        t.model.length === 0 ||
        !Array.isArray(t.tools) ||
        !Array.isArray(t.messages) ||
        t.messages.length < 2
    ) {
        return { ok: false, reason: 'UNREADABLE' };
    }
    const calls = toolUsesOf((t.messages as BetaMessageParam[])[t.messages.length - 1]);
    if (calls.length === 0) return { ok: false, reason: 'UNREADABLE' };
    const ids = new Set(calls.map((c) => c.id));
    const answered = new Set<string>();
    for (const block of results as unknown[]) {
        const b = block as { type?: unknown; tool_use_id?: unknown } | null;
        if (!b || typeof b !== 'object' || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') {
            return { ok: false, reason: 'UNREADABLE' };
        }
        if (!ids.has(b.tool_use_id) || answered.has(b.tool_use_id)) return { ok: false, reason: 'UNREADABLE' };
        answered.add(b.tool_use_id);
    }
    return {
        ok: true,
        checkpoint: parsed as ConversationCheckpoint,
        results: results as readonly BetaToolResultBlockParam[],
    };
}

/**
 * ONE CALL'S RESULT, in exactly the block the SDK's runner sends for it
 * (`runToolCall`: `{ type, tool_use_id, content, is_error? }`, in that key
 * order). A value the tool returned is its content; a throw is
 * `Error: <message>` with `is_error`, the SDK's `thrownErrorText`. Kept as a
 * call settles; the turn's exact message replaces them when the turn ends.
 */
export function toolResultBlockOf(
    toolUseId: string,
    outcome: { readonly returned: unknown } | { readonly threw: unknown },
): BetaToolResultBlockParam {
    if ('returned' in outcome) {
        return { type: 'tool_result', tool_use_id: toolUseId, content: outcome.returned } as BetaToolResultBlockParam;
    }
    const e = outcome.threw;
    return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
    };
}

/** A call that was executing when the attempt died: whether it took effect is not known. */
export const TOOL_CALL_OUTCOME_UNKNOWN = 'TOOL_CALL_OUTCOME_UNKNOWN';

/** What the model reads for such a call. It is never run again; the model decides. */
export const TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE =
    `${TOOL_CALL_OUTCOME_UNKNOWN}: this call was being made when the run was interrupted, and its outcome is not known. ` +
    'It was not run again. It may or may not have taken effect: check before you make it again.';

/** A call the attempt never started, held behind the one that was executing when it died. */
export const TOOL_CALL_NOT_RUN = 'TOOL_CALL_NOT_RUN';

/** What the model reads for such a call. */
export const TOOL_CALL_NOT_RUN_MESSAGE =
    `${TOOL_CALL_NOT_RUN}: this call was not run: the run was interrupted before it started. You may make it again.`;

/** How each call of the checkpointed reply is answered when the run continues. */
export type ContinuedAnswer = 'KEPT' | typeof TOOL_CALL_OUTCOME_UNKNOWN | typeof TOOL_CALL_NOT_RUN;

/**
 * THE MESSAGES A CONTINUED SEGMENT SENDS: the checkpoint's, then one user
 * message answering every call of its last reply, in the reply's order. A kept
 * result is passed through as it was parsed. A call named in-flight is
 * answered `TOOL_CALL_OUTCOME_UNKNOWN` and any other unanswered call
 * `TOOL_CALL_NOT_RUN`, each an error result: nothing is guessed and nothing is
 * run again.
 */
export function continuedMessages(
    checkpoint: ConversationCheckpoint,
    results: readonly BetaToolResultBlockParam[],
    inFlightToolUseId: string | null,
): { messages: BetaMessageParam[]; answers: Array<{ toolUseId: string; name: string; answer: ContinuedAnswer }> } {
    const kept = new Map(results.map((b) => [b.tool_use_id, b]));
    const calls = toolUsesOf(checkpoint.messages[checkpoint.messages.length - 1]);
    const answers = calls.map((call) => ({
        toolUseId: call.id,
        name: call.name,
        answer: (kept.has(call.id)
            ? 'KEPT'
            : call.id === inFlightToolUseId
              ? TOOL_CALL_OUTCOME_UNKNOWN
              : TOOL_CALL_NOT_RUN) as ContinuedAnswer,
    }));
    const content: BetaContentBlockParam[] = answers.map((a) =>
        a.answer === 'KEPT'
            ? (kept.get(a.toolUseId) as BetaToolResultBlockParam)
            : {
                  type: 'tool_result',
                  tool_use_id: a.toolUseId,
                  content: a.answer === TOOL_CALL_OUTCOME_UNKNOWN ? TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE : TOOL_CALL_NOT_RUN_MESSAGE,
                  is_error: true,
              },
    );
    return { messages: [...checkpoint.messages, { role: 'user', content }], answers };
}
