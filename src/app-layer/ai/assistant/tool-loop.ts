/**
 * The assistant's tool-use loop (#3808).
 *
 * This replaces ONE thing in `usecases/assistant.ts`: the deterministic
 * keyword router that file describes as "the first cut". Everything around it —
 * the governed ordering, the propose-not-commit path, the quarantine honesty —
 * is untouched and must stay that way.
 *
 * ═══ THE LOOP IS AN ENGINE, AND NOTHING MORE ═══
 *
 * `flue/tools-adapter.ts` states the division this module obeys:
 *
 *   > The external engine decides WHAT TO TRY. `runReadTool` and
 *   > `runProposeTool` decide WHAT IS PERMITTED. ... Nothing here
 *   > re-implements any of that, and nothing here may.
 *
 * So this file contains no permission check, no tenant filter and no audit
 * write. It chooses which tool to call and stops when it should; the funnel
 * decides whether the call happens. A reader looking here for the authorization
 * story is in the wrong file by design.
 *
 * ═══ WHY THERE IS NO PROVIDER IMPORT HERE ═══
 *
 * The provider arrives as {@link AssistantTurnProvider} — one method, one
 * round-trip. Three reasons, and the third is the load-bearing one:
 *
 *   · the loop is testable without a network or a key;
 *   · the same loop serves anthropic, openrouter, local and stub, which is how
 *     the six existing `ai/*-provider.ts` implementations are already organised;
 *   · a provider the loop CANNOT reach directly cannot be mutated by it. The
 *     model arrives as a SPECIFIER resolved per turn through
 *     `flue/model-selection.ts`, whose docstring explains that the runtime's
 *     `setProvider` mutates a module-scoped singleton and "two concurrent runs
 *     in one Node process would race, and the loser executes against the
 *     winner's provider". With per-tenant `aiResidency: LOCAL_ONLY` a hard
 *     invariant that race is a CROSS-TENANT EGRESS, not a flake — a LOCAL_ONLY
 *     tenant's reasoning sent to an endpoint another tenant registered a
 *     millisecond earlier, with nothing in the trail to show it. A
 *     conversational assistant makes concurrency the normal case rather than
 *     the exception, so this is the hazard most worth designing against here.
 *     `tests/guards/flue-provider-is-never-set-per-run.test.ts` fails any call
 *     to that setter anywhere under `src/`.
 */
/**
 * How a turn ended.
 *
 * `halted-*` is not an error and not a success: the loop stopped because it hit
 * a bound, and the ANSWER MUST SAY SO. A loop that returns its partial work as
 * though complete is the same failure as a check reporting PASSED without
 * running — the reader cannot tell a bounded answer from a finished one.
 */
export type LoopOutcome =
    | 'answered'
    | 'halted-iterations'
    | 'halted-tool-calls'
    | 'halted-wall-clock'
    | 'halted-provider-unavailable'
    /**
     * A tool tripped the REVIEW guard, so the turn stops here.
     *
     * Distinct from a tool failure on purpose, and the distinction is the whole
     * point. A failed read becomes a RESULT the model is told about, so it can
     * say the data is unavailable (#3816). A guard trip must NOT: handing the
     * model "that read was refused" and letting it continue is precisely the
     * routing-around the latch exists to stop — `tools-adapter.ts` keeps one
     * latch for the whole set so "a flagged `list_risks`" cannot be followed by
     * "a clean `list_controls`", and a loop that treated the refusal as data
     * would reintroduce that at the engine layer.
     */
    | 'halted-guard-review';

/** One tool call the loop actually dispatched, for the trail and the UI. */
export interface LoopToolCall {
    readonly name: string;
    readonly ok: boolean;
    /** Serialised bytes handed to the model AFTER bounding. */
    readonly bytes: number;
    readonly truncated: boolean;
}

export interface LoopResult {
    readonly text: string;
    readonly outcome: LoopOutcome;
    readonly calls: readonly LoopToolCall[];
    /**
     * Summed across every round-trip in the turn, or null if NO provider reply
     * reported usage.
     *
     * Null rather than 0 deliberately: "this turn cost nothing" and "we do not
     * know what this turn cost" are different facts, and a cost record that
     * conflates them under-reports spend.
     */
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    /** True when ANY tool result was truncated — the UI must label the answer. */
    readonly truncatedAny: boolean;
    readonly iterations: number;
}

/** A provider round-trip's result, normalised across providers. */
export interface ProviderTurn {
    readonly text: string | null;
    readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly args: unknown }>;
    /** `max_tokens` is surfaced rather than folded into `end`: a truncated reply is not a finished one. */
    readonly stopReason: 'end' | 'tool_use' | 'max_tokens';
    /**
     * What the round-trip cost, when the provider says.
     *
     * Optional because not every provider reports it, and a missing figure must
     * read as UNKNOWN rather than as zero — `0` would understate a tenant's
     * recorded spend, which is the one direction a cost record must not fail in.
     */
    readonly usage?: { readonly tokensIn: number; readonly tokensOut: number };
}

/** What the loop sends. `toolResults` carries the previous turn's dispatches. */
export interface ProviderRequest {
    readonly specifier: string;
    readonly system: string;
    readonly question: string;
    readonly history: ReadonlyArray<
        | { readonly role: 'assistant'; readonly text: string | null; readonly toolCalls: ProviderTurn['toolCalls'] }
        | { readonly role: 'tool'; readonly id: string; readonly name: string; readonly content: string }
    >;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string; readonly jsonSchema: unknown }>;
    readonly signal?: AbortSignal;
}

export interface AssistantTurnProvider {
    complete(req: ProviderRequest): Promise<ProviderTurn>;
}

/**
 * The bounds, all three of them, and why each exists separately.
 *
 * They are not interchangeable and a single "max steps" would not cover them:
 * `iterations` bounds how many times the model may think, `toolCalls` bounds
 * how much it may READ across a whole conversation (a single iteration can
 * request several calls), and `wallClockMs` bounds the only one a user feels.
 * A loop that respected two of the three has an unbounded dimension.
 */
export interface LoopBounds {
    readonly iterations: number;
    readonly toolCalls: number;
    readonly wallClockMs: number;
    /**
     * Per-result ceiling in SERIALISED BYTES, not rows (#3815).
     *
     * Ten long rows blow a context window faster than a hundred short ones, so
     * a row cap is the wrong instrument. When a result exceeds this it is cut
     * and the model is TOLD, because a model reasoning over a silent subset
     * states a conclusion about "the controls" having seen a third of them —
     * a confident wrong answer, which in a compliance product is worse than a
     * refusal.
     */
    readonly resultBytes: number;
}

export const DEFAULT_LOOP_BOUNDS: LoopBounds = {
    iterations: 6,
    toolCalls: 24,
    wallClockMs: 60_000,
    resultBytes: 24_000,
};

/** The sentence a halted turn appends. Exported so the UI and tests share one wording. */
export function haltNotice(outcome: LoopOutcome, bounds: LoopBounds): string | null {
    switch (outcome) {
        case 'answered':
            return null;
        case 'halted-iterations':
            return `I stopped after ${bounds.iterations} reasoning steps, so this answer may be incomplete. Ask a narrower question to get a full one.`;
        case 'halted-tool-calls':
            return `I stopped after ${bounds.toolCalls} data lookups in this conversation, so this answer may be incomplete. Start a new conversation to reset that budget.`;
        case 'halted-wall-clock':
            return `I stopped after ${Math.round(bounds.wallClockMs / 1000)} seconds, so this answer may be incomplete.`;
        case 'halted-provider-unavailable':
            return 'The language model was unavailable, so I could not answer this. Your data was not read and nothing was created.';
        case 'halted-guard-review':
            return 'I stopped: the content guard flagged something in what I read and it needs a human to look at it. Nothing was created, and I have not answered from the flagged material.';
    }
}

/**
 * Bound one tool result, and say whether it was cut.
 *
 * Cuts on a UTF-8 byte budget rather than `String.length`, because the budget
 * being protected is the provider's, which counts bytes — a cap measured in
 * UTF-16 code units under-counts a document full of non-ASCII and over-counts
 * nothing, so it is the wrong unit in exactly one direction.
 */
export function boundResult(raw: string, limitBytes: number): { content: string; bytes: number; truncated: boolean } {
    const encoder = new TextEncoder();
    const full = encoder.encode(raw);
    if (full.byteLength <= limitBytes) return { content: raw, bytes: full.byteLength, truncated: false };

    // Decode a prefix with `fatal: false` so a cut landing mid-codepoint yields
    // a replacement character rather than throwing — the cut is the point, and
    // a throw here would turn a truncation into a failed tool call.
    const head = new TextDecoder('utf-8', { fatal: false }).decode(full.slice(0, limitBytes));
    const note = `\n\n[TRUNCATED: this result was cut at ${limitBytes} bytes. You are seeing a PREFIX, not the whole set. Say so in your answer, and do not state totals or conclusions about the full set from it.]`;
    return { content: head + note, bytes: limitBytes, truncated: true };
}

/** What the loop needs to dispatch one tool, decoupled from the adapter's shape. */
export interface LoopTool {
    readonly name: string;
    readonly description: string;
    /**
     * The JSON Schema sent to the PROVIDER, copied from the MCP tool's own
     * `inputSchema` — no second catalogue.
     *
     * Named `jsonSchema` and not `inputSchema` deliberately.
     * `local/require-mcp-tool-authorization` recognises an MCP tool descriptor
     * STRUCTURALLY — `name` + `description` + `inputSchema` + `run` — and
     * demands an `authorize` block, because "a tool that can perform a check is
     * a tool that can skip one". This type is not such a descriptor: it carries
     * no authority at all, and its `run` delegates to the funnel that holds it.
     * Wearing the descriptor's shape would have made that claim ambiguous to
     * the one check that enforces it, so the field says what it actually is.
     */
    readonly jsonSchema: unknown;
    /** Routes to `runReadTool` / `runProposeTool`. The loop never looks inside. */
    run(args: unknown, signal?: AbortSignal): Promise<string>;
}

export interface RunLoopOptions {
    readonly provider: AssistantTurnProvider;
    readonly specifier: string;
    readonly system: string;
    readonly question: string;
    readonly tools: readonly LoopTool[];
    readonly bounds?: LoopBounds;
    readonly signal?: AbortSignal;
    /** Injected so a bound can be proven without sleeping. Same reason `McpInvocation` carries a clock. */
    readonly now?: () => number;
    /** Tool calls already spent earlier in this conversation, so the budget spans the conversation. */
    readonly callsAlready?: number;
    /**
     * The review latch, consulted after every dispatch.
     *
     * Supplied rather than inferred: the loop must not decide for itself what a
     * thrown error meant. See `LoopOutcome['halted-guard-review']`.
     */
    readonly guardTripped?: () => boolean;
    /**
     * Called with a tool's name BEFORE it is dispatched (#3886).
     *
     * Before, not after, and that ordering is the entire point. The reason a
     * `tool_call` event exists is that naming the lookup justifies the wait —
     * "checking your evidence expiry" tells the user why the pause is
     * reasonable where a bare spinner does not. Emitted after the fact, the
     * event arrives AFTER the pause it was meant to explain, so the pause is
     * still unexplained and "a silent pause reads as a hang" is only half
     * answered.
     *
     * Both hooks are called inside a try/catch. An observer is usually an
     * emit into a stream, and a client that has gone away must not be able to
     * abort a turn that is still spending tokens on its behalf — the turn's
     * own `signal` is how a disconnect stops work, not an exception from a
     * notification.
     */
    readonly onToolCall?: (name: string) => void;
    /**
     * Called once the result is recorded, with how the call ended.
     *
     * After `calls.push`, so the trail and the event cannot disagree about
     * what happened, and before the guard-latch check, so a caller watching
     * sees the call that tripped the latch rather than only the halt.
     */
    readonly onToolResult?: (name: string, ok: boolean, truncated: boolean) => void;
}

/**
 * Drive the turn.
 *
 * ═══ FAIL CLOSED, AND NEVER MANUFACTURE A SIGNAL (#3816) ═══
 *
 * A tool call that throws becomes a RESULT SAYING SO, handed back to the model,
 * rather than an exception that ends the turn. That is deliberate and it is the
 * narrow line this function walks: the model is told the data is unavailable so
 * it can say the data is unavailable, and it is NOT given room to substitute an
 * inferred or remembered control status. The prompt carries that instruction;
 * this function carries the only evidence the model gets.
 *
 * A PROVIDER that fails is different and ends the turn, because there is no
 * answer to give — `halted-provider-unavailable`, degraded rather than thrown,
 * which is the behaviour the six existing `ai/*-provider.ts` implementations
 * already have.
 */
/**
 * Call an observer without letting it end the turn.
 *
 * The observers are emits into an SSE stream. A closed stream, a client that
 * navigated away, a bug in a formatter — none of those are reasons to abandon
 * a turn the tenant is being charged for, and none of them are the turn's own
 * `signal`, which IS how a disconnect stops work.
 */
function notify(fn: (() => void) | undefined): void {
    if (fn === undefined) return;
    try {
        fn();
    } catch {
        // Deliberately swallowed — see above. There is nowhere to report it
        // that the failing observer is not already responsible for.
    }
}

export async function runAssistantLoop(opts: RunLoopOptions): Promise<LoopResult> {
    const bounds = opts.bounds ?? DEFAULT_LOOP_BOUNDS;
    const now = opts.now ?? (() => Date.now());
    const startedAt = now();
    const byName = new Map(opts.tools.map((t) => [t.name, t]));
    const specs = opts.tools.map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));

    const history: Array<ProviderRequest['history'][number]> = [];
    const calls: LoopToolCall[] = [];
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let spentCalls = opts.callsAlready ?? 0;
    let lastText: string | null = null;
    let iterations = 0;

    const finish = (outcome: LoopOutcome): LoopResult => {
        const notice = haltNotice(outcome, bounds);
        const body = (lastText ?? '').trim();
        // The notice is APPENDED, never substituted. A halted turn that did
        // partial work should show the work and the caveat — replacing the body
        // with the caveat alone throws away what was legitimately read.
        const text = outcome === 'answered' ? body : [body, notice].filter(Boolean).join('\n\n');
        return {
            text,
            outcome,
            calls,
            tokensIn,
            tokensOut,
            truncatedAny: calls.some((c) => c.truncated),
            iterations,
        };
    };

    for (;;) {
        if (iterations >= bounds.iterations) return finish('halted-iterations');
        if (now() - startedAt >= bounds.wallClockMs) return finish('halted-wall-clock');

        iterations += 1;
        let turn: ProviderTurn;
        try {
            turn = await opts.provider.complete({
                specifier: opts.specifier,
                system: opts.system,
                question: opts.question,
                history,
                tools: specs,
                signal: opts.signal,
            });
        } catch {
            // Degrade, do not throw at the user. Nothing is said about the
            // tenant's posture, because nothing was read.
            return finish('halted-provider-unavailable');
        }

        if (turn.usage !== undefined) {
            // Accumulated across iterations, because a turn that called three
            // tools made four round-trips and the tenant paid for all of them.
            // Recording only the last would under-report a multi-step turn by
            // most of its cost.
            tokensIn = (tokensIn ?? 0) + turn.usage.tokensIn;
            tokensOut = (tokensOut ?? 0) + turn.usage.tokensOut;
        }

        if (turn.text !== null && turn.text.trim() !== '') lastText = turn.text;

        if (turn.toolCalls.length === 0) {
            // `max_tokens` is a stop the user must know about for the same
            // reason a cap is: the reply is cut, not complete.
            return finish(turn.stopReason === 'max_tokens' ? 'halted-iterations' : 'answered');
        }

        history.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

        for (const call of turn.toolCalls) {
            if (spentCalls >= bounds.toolCalls) return finish('halted-tool-calls');
            if (now() - startedAt >= bounds.wallClockMs) return finish('halted-wall-clock');
            spentCalls += 1;

            const tool = byName.get(call.name);
            if (tool === undefined) {
                // A name the model invented, or one filtered out of this user's
                // offered set. Reported as a result rather than a throw: the
                // model should correct itself, and an unknown name is not an
                // authorization event — the funnel never saw it.
                // Observed like any other call. The model DID attempt it, the
                // attempt is in `calls`, and a watcher that saw nothing here
                // would show a gap where a real (failed) lookup happened.
                notify(() => opts.onToolCall?.(call.name));
                history.push({
                    role: 'tool',
                    id: call.id,
                    name: call.name,
                    content: `ERROR: no tool named "${call.name}" is available to you. Do not try it again.`,
                });
                calls.push({ name: call.name, ok: false, bytes: 0, truncated: false });
                notify(() => opts.onToolResult?.(call.name, false, false));
                continue;
            }

            // BEFORE the dispatch — the whole point of #3886. The client
            // learns the name while the call is in flight, so the pause it is
            // about to sit through is already explained.
            notify(() => opts.onToolCall?.(call.name));

            let bounded: { content: string; bytes: number; truncated: boolean };
            let ok = true;
            try {
                const raw = await tool.run(call.args, opts.signal);
                bounded = boundResult(raw, bounds.resultBytes);
            } catch (err) {
                ok = false;
                // The REASON reaches the model so it can be specific about what
                // is unavailable, but it is the funnel's message — this function
                // does not compose a posture claim of its own.
                const reason = err instanceof Error ? err.message : String(err);
                bounded = boundResult(`ERROR: this data could not be read: ${reason}`, bounds.resultBytes);
            }

            history.push({ role: 'tool', id: call.id, name: call.name, content: bounded.content });
            calls.push({ name: call.name, ok, bytes: bounded.bytes, truncated: bounded.truncated });
            notify(() => opts.onToolResult?.(call.name, ok, bounded.truncated));

            // AFTER recording, so the trail shows the call that tripped it, and
            // BEFORE the next dispatch, so nothing runs past the trip.
            if (opts.guardTripped?.() === true) return finish('halted-guard-review');
        }
    }
}
