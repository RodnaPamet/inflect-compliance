/**
 * A RETRIED MANAGED AGENTS SEGMENT RECONNECTS TO ITS SESSION (#5854, owner
 * decision 2026-11-25).
 *
 * > A retried, or lease-taken-over, Managed Agents segment that already made a
 * > tool call does NOT pause for a person. It RECONNECTS to the session it
 * > created at Anthropic and continues there. It reads the session's event
 * > history and answers each pending custom-tool call the way the Tool Runner
 * > continuation does: a kept result as kept, the call in flight
 * > `TOOL_CALL_OUTCOME_UNKNOWN`, a call not run `TOOL_CALL_NOT_RUN`.
 *
 * Pure: no Prisma, no SDK runtime. The engine (`execute.ts`) reads the ledger,
 * the checkpoint and the session's history, and this module decides what they
 * say. Two things live here:
 *
 *   • THE SESSION CHECKPOINT. The engine keeps the in-flight marker and each
 *     call's result on the run's ONE checkpoint row (`WorkflowRunCheckpoint`,
 *     `checkpoint-store.ts`), as the Tool Runner does. Its conversation is at
 *     Anthropic, so the "transcript" the row carries is a pointer: the session
 *     and the span whose calls the results answer, sealed like every
 *     transcript. Its results are the custom-tool results in the shape the
 *     engine sends them (`KeptCallResult`).
 *   • THE PLAN. From the session's history and the spans the ledger recorded:
 *     which events the dead attempt already accounted for, whether it had sent
 *     the opening message, whether it had stopped the session (an interrupt),
 *     and which custom-tool calls have no result event. Each open call is then
 *     answered by the Tool Runner's rule (`answerOpenCalls`), and never run.
 */
import {
    TOOL_CALL_NOT_RUN,
    TOOL_CALL_NOT_RUN_MESSAGE,
    TOOL_CALL_OUTCOME_UNKNOWN,
    TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE,
    transcriptHashOf,
    type ContinuedAnswer,
} from '@/lib/agentic/tool-runner/transcript';

/** The format id the checkpoint's pointer names. A new shape is a new id. */
export const SESSION_CHECKPOINT_FORMAT = 'inflect-managed-agents-session/1';

/** What the checkpoint row's transcript holds for this engine: where the conversation is. */
export interface SessionCheckpoint {
    readonly format: typeof SESSION_CHECKPOINT_FORMAT;
    /** The session the run's conversation lives in. */
    readonly sessionId: string;
    /** The `span.model_request_end` whose calls the kept results answer. */
    readonly spanEventId: string;
}

/** One custom-tool call's result, as the engine sends it (`user.custom_tool_result`). */
export interface KeptCallResult {
    /** The `agent.custom_tool_use` event's id. */
    readonly id: string;
    readonly text: string;
    readonly isError: boolean;
}

/** The serialised pointer and its seal. */
export function sealSessionCheckpoint(checkpoint: Omit<SessionCheckpoint, 'format'>): { json: string; hash: string } {
    const json = JSON.stringify({ format: SESSION_CHECKPOINT_FORMAT, sessionId: checkpoint.sessionId, spanEventId: checkpoint.spanEventId });
    return { json, hash: transcriptHashOf(json) };
}

/** The serialised results and their seal. */
export function sealKeptResults(results: readonly KeptCallResult[]): { json: string; hash: string } {
    const json = JSON.stringify(results.map((r) => ({ id: r.id, text: r.text, isError: r.isError })));
    return { json, hash: transcriptHashOf(json) };
}

/**
 * ONE CALL'S RESULT, as the engine answers it: what the tool returned (a
 * string as it is, anything else as JSON), or a throw's message as an error.
 * The engine's own answer and the kept one are built here, so a kept result
 * is byte for byte what the dead attempt would have sent.
 */
export function keptResultOf(id: string, outcome: { readonly returned: unknown } | { readonly threw: unknown }): KeptCallResult {
    if ('returned' in outcome) {
        const out = outcome.returned;
        return { id, text: typeof out === 'string' ? out : JSON.stringify(out), isError: false };
    }
    const err = outcome.threw;
    return { id, text: err instanceof Error ? err.message : 'The tool call failed.', isError: true };
}

/** A call's start could not be recorded, so it was not made. */
export const CALL_START_NOT_RECORDED_MESSAGE =
    'TOOL_CALL_NOT_STARTED: the run could not record that this call was starting, so it was not made.';

/** Why a stored checkpoint could not be read. */
export type SessionCheckpointRefusal = 'UNSEALED' | 'UNREADABLE';

/** An opened checkpoint: the kept results and the call in flight, for this session only. */
export interface OpenedSessionCheckpoint {
    readonly kept: ReadonlyMap<string, KeptCallResult>;
    readonly inFlightCallId: string | null;
}

const NO_CHECKPOINT: OpenedSessionCheckpoint = { kept: new Map(), inFlightCallId: null };

/**
 * Open the run's checkpoint for the session being reconnected: the seals
 * first, then the envelopes. A pointer naming ANOTHER session is not this
 * session's record and reads as no checkpoint (nothing kept, nothing in
 * flight), never as a refusal: the calls are then answered `TOOL_CALL_NOT_RUN`,
 * which says only that this session's record holds no result for them.
 */
export function openSessionCheckpoint(
    stored: {
        readonly transcriptJson: string;
        readonly transcriptHash: string;
        readonly resultsJson: string | null;
        readonly resultsHash: string | null;
        readonly inFlightToolUseId: string | null;
    } | null,
    sessionId: string,
): { ok: true; checkpoint: OpenedSessionCheckpoint } | { ok: false; reason: SessionCheckpointRefusal } {
    if (stored === null) return { ok: true, checkpoint: NO_CHECKPOINT };
    if (transcriptHashOf(stored.transcriptJson) !== stored.transcriptHash) return { ok: false, reason: 'UNSEALED' };
    if (stored.resultsJson !== null && (stored.resultsHash === null || transcriptHashOf(stored.resultsJson) !== stored.resultsHash)) {
        return { ok: false, reason: 'UNSEALED' };
    }
    let pointer: unknown;
    let results: unknown;
    try {
        pointer = JSON.parse(stored.transcriptJson);
        results = stored.resultsJson === null ? [] : JSON.parse(stored.resultsJson);
    } catch {
        return { ok: false, reason: 'UNREADABLE' };
    }
    const p = pointer as Partial<SessionCheckpoint> | null;
    if (
        !p ||
        typeof p !== 'object' ||
        Array.isArray(p) ||
        p.format !== SESSION_CHECKPOINT_FORMAT ||
        typeof p.sessionId !== 'string' ||
        typeof p.spanEventId !== 'string' ||
        !Array.isArray(results)
    ) {
        return { ok: false, reason: 'UNREADABLE' };
    }
    if (p.sessionId !== sessionId) return { ok: true, checkpoint: NO_CHECKPOINT };
    const kept = new Map<string, KeptCallResult>();
    for (const r of results as unknown[]) {
        const k = r as Partial<KeptCallResult> | null;
        if (!k || typeof k !== 'object' || typeof k.id !== 'string' || typeof k.text !== 'string' || typeof k.isError !== 'boolean') {
            return { ok: false, reason: 'UNREADABLE' };
        }
        if (kept.has(k.id)) return { ok: false, reason: 'UNREADABLE' };
        kept.set(k.id, { id: k.id, text: k.text, isError: k.isError });
    }
    return { ok: true, checkpoint: { kept, inFlightCallId: stored.inFlightToolUseId } };
}

/** The fields of a session event this module reads. */
export interface HistoryEvent {
    readonly id?: unknown;
    readonly type: string;
    readonly name?: unknown;
    readonly custom_tool_use_id?: unknown;
}

/** What the session's history says, read against the ledger. */
export interface ReconnectPlan {
    /**
     * The history holds a `user.interrupt`: an earlier attempt STOPPED this
     * session (a kill, an abort, a cap, a guard verdict) and died before it
     * settled the run. The session is not continued.
     */
    readonly stoppedEarlier: boolean;
    /** The opening `user.message` reached the session. */
    readonly openingSent: boolean;
    /**
     * The index of the last `span.model_request_end` the ledger recorded, or
     * -1. Every event up to it was accounted for by the attempt that recorded
     * it: its model calls are on the ledger, its text was scanned, its calls'
     * turn checkpointed. The engine handles the events after it as new.
     */
    readonly accountedThrough: number;
    /** The id of the last event the history held: where the reconnect picked up. */
    readonly lastEventId: string | null;
    /** The custom-tool calls the history answers already. */
    readonly answered: ReadonlySet<string>;
    /** The custom-tool calls with no result event, in the order they were made. */
    readonly openCalls: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** Read the session's history against the spans the ledger recorded. */
export function planReconnect(history: readonly HistoryEvent[], recordedSpanIds: ReadonlySet<string>): ReconnectPlan {
    let accountedThrough = -1;
    let stoppedEarlier = false;
    let openingSent = false;
    const answered = new Set<string>();
    const calls: Array<{ id: string; name: string }> = [];
    history.forEach((ev, i) => {
        const id = typeof ev.id === 'string' ? ev.id : null;
        switch (ev.type) {
            case 'span.model_request_end':
                if (id !== null && recordedSpanIds.has(id)) accountedThrough = i;
                return;
            case 'user.interrupt':
                stoppedEarlier = true;
                return;
            case 'user.message':
                openingSent = true;
                return;
            case 'agent.custom_tool_use':
                if (id !== null) calls.push({ id, name: typeof ev.name === 'string' ? ev.name : '' });
                return;
            case 'user.custom_tool_result':
                if (typeof ev.custom_tool_use_id === 'string') answered.add(ev.custom_tool_use_id);
                return;
            default:
                return;
        }
    });
    const last = history.length > 0 ? history[history.length - 1].id : null;
    return {
        stoppedEarlier,
        openingSent,
        accountedThrough,
        lastEventId: typeof last === 'string' ? last : null,
        answered,
        openCalls: calls.filter((c) => !answered.has(c.id)),
    };
}

/** How one open call is answered, and the text the session receives. */
export interface ReconnectAnswer {
    readonly id: string;
    readonly name: string;
    readonly answer: ContinuedAnswer;
    readonly text: string;
    readonly isError: boolean;
}

/**
 * THE TOOL RUNNER'S RULE, for a session's open calls: a result the checkpoint
 * kept is sent as kept; the call the checkpoint names in flight is answered
 * `TOOL_CALL_OUTCOME_UNKNOWN`; any other is `TOOL_CALL_NOT_RUN`. Each of the
 * last two is an error result. Nothing is guessed and nothing is run again.
 */
export function answerOpenCalls(
    openCalls: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    checkpoint: OpenedSessionCheckpoint,
): ReconnectAnswer[] {
    return openCalls.map((call) => {
        const kept = checkpoint.kept.get(call.id);
        if (kept) return { id: call.id, name: call.name, answer: 'KEPT', text: kept.text, isError: kept.isError };
        if (call.id === checkpoint.inFlightCallId) {
            return { id: call.id, name: call.name, answer: TOOL_CALL_OUTCOME_UNKNOWN, text: TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE, isError: true };
        }
        return { id: call.id, name: call.name, answer: TOOL_CALL_NOT_RUN, text: TOOL_CALL_NOT_RUN_MESSAGE, isError: true };
    });
}
