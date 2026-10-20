/**
 * What the assistant stream emits, and why each event exists (#3809).
 *
 * ═══ A SILENT PAUSE READS AS A HANG ═══
 *
 * The event set is not a convenience for the UI; each member exists because
 * without it some real state is indistinguishable from a stalled connection:
 *
 *   · `thinking` — the model has the question and no tool result yet;
 *   · `tool_call` — a named lookup is in flight, which is what justifies the
 *     wait to the person watching. A bare spinner does not;
 *   · `tool_result` — the lookup returned, and whether it was TRUNCATED;
 *   · `answer` — the text, in one or more chunks;
 *   · `refusal` — a guard said no, WITH its reason. An empty stream that ends
 *     is indistinguishable from a crash, so the user retries, which spends
 *     again and teaches them the feature is unreliable;
 *   · `halt` — a bound was reached. The answer so far is real but incomplete,
 *     and saying so is the whole point of the bounds;
 *   · `done` — the turn is over. Without it a client cannot tell "finished"
 *     from "connection still open, nothing more coming yet".
 *
 * `error` is deliberately NOT in that list. Every terminal state a user should
 * see is either `refusal`, `halt` or `done`; an `error` event would be a fourth
 * way to end that carries no actionable reason, and the thing it would be used
 * for — the provider being unavailable — is already a `halt` outcome that says
 * the data was not read and nothing was created.
 */
import type { LoopOutcome } from './tool-loop';

export type AssistantStreamEvent =
    | { readonly type: 'thinking' }
    | { readonly type: 'tool_call'; readonly name: string }
    | { readonly type: 'tool_result'; readonly name: string; readonly ok: boolean; readonly truncated: boolean }
    | { readonly type: 'answer'; readonly text: string }
    | { readonly type: 'refusal'; readonly reason: string }
    | { readonly type: 'halt'; readonly outcome: LoopOutcome; readonly notice: string }
    | { readonly type: 'done'; readonly truncatedAny: boolean };

/**
 * SSE wire format, matching `notifications/stream/route.ts`.
 *
 * `data: <json>\n\n` with no `event:` field — the client switches on the
 * payload's own `type`, so adding an event later does not require the client to
 * subscribe to a new named channel it does not know about yet.
 */
export function sseData(event: AssistantStreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

/** An SSE comment. Invisible to `EventSource` consumers, used for the heartbeat. */
export function sseComment(text: string): string {
    return `: ${text}\n\n`;
}
