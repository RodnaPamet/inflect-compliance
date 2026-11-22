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
