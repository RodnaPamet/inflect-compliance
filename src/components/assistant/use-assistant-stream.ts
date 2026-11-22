'use client';

/**
 * The client half of the SSE turn (#3848, #3849, #3850).
 *
 * ═══ WHY `fetch` + A READER, NOT `EventSource` ═══
 *
 * `EventSource` can only issue a GET and cannot set headers, and this turn is
 * a POST with a JSON body (the question plus the page context). It also
 * reconnects automatically, which is wrong for a metered turn: a dropped
 * connection would silently start a SECOND billed turn, and the user would
 * see the answer restart with no indication they had paid twice.
 */

import { useCallback, useRef, useState } from 'react';

import type { AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';
import type { AssistantHistoryTurn } from '@/app-layer/ai/assistant/limits';

/** What the UI needs to render, accumulated from the event stream. */
export interface AssistantTurnState {
    /** The phase, for the "what is it doing" line. A silent pause reads as a hang. */
    phase: 'idle' | 'thinking' | 'calling' | 'answering' | 'done';
    /** The tool currently being called, named — #3848 asks for the NAME, not a spinner. */
    callingTool: string | null;
    /** Tools called this turn, in order, with how each ended. */
    calls: ReadonlyArray<{ name: string; ok: boolean; truncated: boolean }>;
    answer: string | null;
    /**
     * The server's seal on `answer` (#5054), kept so the answer can go back as
     * history without being re-scanned as the person's own text. Never shown.
     */
    answerSeal: string | null;
    /** A refusal and its reason (#3849). Distinct from an error. */
    refusal: string | null;
    /** A bound was hit and the turn stopped early. */
    halt: string | null;
    /**
     * Any tool result was truncated (#3850). Surfaced separately from the
     * per-call flag so the answer can be labelled even when the user has not
     * expanded the call list.
     */
    truncatedAny: boolean;
    /** A transport failure. NOT a refusal — the distinction is the point. */
    error: string | null;
    /**
     * The stream ended before any event arrived (#5054). A flag rather than a
     * sentence in `error`, so the sheet says it in the person's language.
     */
    connectionClosed: boolean;
    /**
     * The proposal this turn queued or quarantined, when it did (#3847).
     *
     * `status` is kept verbatim from the server rather than reduced to a
     * boolean here. The UI's one hard rule is that a quarantined proposal is
     * never called queued, and collapsing the status at the edge of the
     * client is where that rule would get lost.
     */
    proposal: { id: string; kind: string; status: string } | null;
    /**
     * The person pressed Stop, or closed the sheet, before the turn finished.
     *
     * A turn of its own phase, `done`, so the input is usable again: before
     * #5054 an abort left the phase where it was, and Stop kept showing over a
     * disabled input with nothing left to stop.
     */
    stopped: boolean;
}

/** One question in the conversation, and what came back for it. */
export interface AssistantTurn {
    readonly id: number;
    /** Exactly as sent. Rendered as React text, line breaks kept. */
    readonly question: string;
    readonly state: AssistantTurnState;
}

const IDLE: AssistantTurnState = {
    phase: 'idle',
    callingTool: null,
    calls: [],
    answer: null,
    answerSeal: null,
    refusal: null,
    halt: null,
    truncatedAny: false,
    error: null,
    connectionClosed: false,
    proposal: null,
    stopped: false,
};

/**
 * May this turn go to the server as history (#5054)?
 *
 * Only a turn that finished with an answer the person saw. A refused, failed
 * or stopped turn never does, so a guard refusal cannot carry over into later
 * requests, and a turn the person abandoned is not presented to the model as
 * something it said. A proposal turn qualifies, but only its sentence is ever
 * sent: the proposal's id and status stay in the browser.
 */
export function isHistoryEligible(turn: AssistantTurn): boolean {
    const s = turn.state;
    return (
        s.phase === 'done' &&
        !s.stopped &&
        s.refusal === null &&
        s.error === null &&
        !s.connectionClosed &&
        s.answer !== null &&
        /\S/.test(s.answer)
    );
}

/** The question and answer of an eligible turn, the answer's seal when it has one, and nothing else. */
export function historyTurnOf(turn: AssistantTurn): AssistantHistoryTurn {
    const seal = turn.state.answerSeal;
    return {
        question: turn.question,
        answer: turn.state.answer ?? '',
        ...(seal === null ? {} : { answerSeal: seal }),
    };
}

/**
 * Apply one event.
 *
 * A pure reducer, exported so the rendered tests can drive every event type
 * without a server, a stream, or a fake `fetch`. The alternative — asserting
 * on the hook through a mocked transport — tests the mock's framing as much as
 * the reducer, and the framing is the part least likely to be wrong.
 */
export function applyAssistantEvent(
    state: AssistantTurnState,
    event: AssistantStreamEvent,
): AssistantTurnState {
    switch (event.type) {
        case 'thinking':
            return { ...state, phase: 'thinking' };
        case 'tool_call':
            return { ...state, phase: 'calling', callingTool: event.name };
        case 'tool_result':
            return {
                ...state,
                // The call is finished, so nothing is "currently" being called.
                // Leaving the name set would keep "Reading controls…" on screen
                // while the model is composing.
                callingTool: null,
                phase: 'thinking',
                calls: [
                    ...state.calls,
                    { name: event.name, ok: event.ok, truncated: event.truncated },
                ],
                truncatedAny: state.truncatedAny || event.truncated,
            };
        case 'answer':
            return {
                ...state,
                phase: 'answering',
                answer: event.text,
                answerSeal: typeof event.seal === 'string' ? event.seal : null,
                callingTool: null,
                proposal: event.proposal ?? null,
            };
        case 'refusal':
            return { ...state, phase: 'answering', refusal: event.reason, callingTool: null };
        case 'halt':
            return { ...state, halt: event.notice };
        case 'done':
            return {
                ...state,
                phase: 'done',
                callingTool: null,
                // The terminal event is authoritative about truncation: a
                // result can be truncated by the loop's byte cap after the
                // per-call flag was already sent.
                truncatedAny: state.truncatedAny || event.truncatedAny,
            };
        default:
            // An event type this client does not know about. Ignored rather
            // than treated as an error, which is what lets the server add one
            // without breaking older clients.
            return state;
    }
}

/** Parse one SSE `data:` payload. Returns null for anything unreadable. */
export function parseSseData(block: string): AssistantStreamEvent | null {
    const dataLines = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(dataLines.join('\n'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
        return parsed as AssistantStreamEvent;
    } catch {
        // A half-delivered frame. Dropping it loses one event; throwing would
        // lose the rest of the turn.
        return null;
    }
}

export interface AskOptions {
    question: string;
    pageContext?: Record<string, unknown>;
    /** Earlier turns to send, already windowed. Omitted from the body when empty. */
    history?: readonly AssistantHistoryTurn[];
}

/**
 * The conversation, held in memory only (#5054).
 *
 * Never written to browser storage: that would leave tenant data at rest in
 * the browser, and the server trusts none of it anyway. It survives closing
 * and reopening the sheet, which stays mounted, and is gone on reload.
 */
export function useAssistantStream(streamUrl: string) {
    const [turns, setTurns] = useState<readonly AssistantTurn[]>([]);
    const abortRef = useRef<AbortController | null>(null);
    const liveIdRef = useRef<number | null>(null);
    const nextIdRef = useRef(1);

    /** Apply `fn` to one turn's state. A stopped turn takes no more events. */
    const update = useCallback(
        (id: number, fn: (s: AssistantTurnState) => AssistantTurnState) => {
            setTurns((ts) =>
                ts.map((t) => (t.id === id && !t.state.stopped ? { ...t, state: fn(t.state) } : t)),
            );
        },
        [],
    );

    const cancel = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        const live = liveIdRef.current;
        liveIdRef.current = null;
        if (live === null) return;
        // Settled HERE, not by the reader: an aborted fetch returns early and
        // an aborted read is not an error, so nothing else would end the turn.
        update(live, (s) =>
            s.phase === 'done' ? s : { ...s, phase: 'done', callingTool: null, stopped: true },
        );
    }, [update]);

    const ask = useCallback(
        async ({ question, pageContext, history = [] }: AskOptions) => {
            // One turn at a time. Starting a second without cancelling the
            // first would interleave two streams and bill for both.
            cancel();
            const abort = new AbortController();
            abortRef.current = abort;
            const id = nextIdRef.current;
            nextIdRef.current += 1;
            liveIdRef.current = id;
            const setState = (fn: (s: AssistantTurnState) => AssistantTurnState) => update(id, fn);

            setTurns((ts) => [...ts, { id, question, state: { ...IDLE, phase: 'thinking' } }]);

            let res: Response;
            try {
                res = await fetch(streamUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        question,
                        ...(pageContext === undefined ? {} : { pageContext }),
                        // Omitted when empty, like the page context's own
                        // collections: an old server reads the body unchanged.
                        ...(history.length === 0 ? {} : { history }),
                    }),
                    signal: abort.signal,
                });
            } catch (err) {
                if (abort.signal.aborted) return;
                setState((s) => ({ ...s, phase: 'done', error: String(err) }));
                return;
            }

            if (!res.ok || res.body === null) {
                // The capacity refusal (429) arrives as JSON, not as a stream,
                // and it has a reason worth showing rather than a generic
                // failure — being told to try again shortly is actionable.
                let reason: string | null = null;
                try {
                    const body: unknown = await res.json();
                    const maybe = (body as { error?: { message?: unknown } } | null)?.error?.message;
                    if (typeof maybe === 'string') reason = maybe;
                } catch {
                    reason = null;
                }
                setState((s) => ({
                    ...s,
                    phase: 'done',
                    error: reason ?? `The assistant is unavailable (${res.status}).`,
                }));
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    // SSE frames are separated by a blank line. The tail is
                    // kept, because a frame can arrive split across reads.
                    const frames = buffer.split('\n\n');
                    buffer = frames.pop() ?? '';
                    for (const frame of frames) {
                        const event = parseSseData(frame);
                        if (event !== null) setState((s) => applyAssistantEvent(s, event));
                    }
                }
            } catch (err) {
                if (!abort.signal.aborted) {
                    setState((s) => ({ ...s, phase: 'done', error: String(err) }));
                }
            } finally {
                if (abortRef.current === abort) abortRef.current = null;
                if (liveIdRef.current === id) liveIdRef.current = null;
                // A stream that ended without `done` still ends the turn, so
                // the input comes back. Said, when nothing at all arrived, so a
                // dropped connection is not an empty answer; the sheet words it.
                // A stopped turn is left alone (`update` skips it).
                setState((s) =>
                    s.phase === 'done'
                        ? s
                        : {
                              ...s,
                              phase: 'done',
                              callingTool: null,
                              connectionClosed: s.answer === null && s.refusal === null && s.error === null,
                          },
                );
            }
        },
        [streamUrl, cancel, update],
    );

    /** New conversation: stop anything live and forget every turn. */
    const reset = useCallback(() => {
        cancel();
        setTurns([]);
    }, [cancel]);

    const last = turns.length === 0 ? null : turns[turns.length - 1];
    const busy = last !== null && last.state.phase !== 'idle' && last.state.phase !== 'done';

    return { turns, busy, ask, cancel, reset };
}
