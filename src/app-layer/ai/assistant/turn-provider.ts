/**
 * The assistant's provider seam — one tool-use round-trip (#3808).
 *
 * Extends the pattern the six existing `ai/*-provider.ts` implementations
 * already use (direct `POST /v1/messages`, pinned model, abort on a timeout,
 * degrade rather than throw) with the two capabilities none of them has: a
 * `tools` array on the request, and `tool_use` blocks parsed out of the reply.
 *
 * Deliberately NOT a new provider layer. The owner's decision for #3808 was to
 * extend this pattern rather than adopt an SDK, because an SDK would sit
 * alongside six hand-written providers in a codebase whose roadmap opens
 * "the single most expensive mistake available here is building a second one of
 * any of them".
 *
 * ═══ THE SPECIFIER IS CHECKED, NOT TRUSTED ═══
 *
 * `flue/model-selection.ts` hands out `"<provider-id>/<model-id>"` and owns the
 * residency decision. This file re-checks the provider id before sending
 * anything, and REFUSES a specifier addressed elsewhere.
 *
 * That is not redundant defence-in-depth for its own sake. The failure it
 * catches is the one `model-selection.ts` exists for: with per-tenant
 * `aiResidency: LOCAL_ONLY` a hard invariant, an external provider that served
 * a `inflect-local/...` specifier would be a CROSS-TENANT EGRESS — a
 * LOCAL_ONLY tenant's reasoning sent outside, with nothing in the trail to show
 * it. A conversational assistant makes concurrency the normal case, so the
 * check lives at the boundary that actually opens the socket rather than only
 * at the one that chose the model.
 */
import { anthropicWorkspaceHeaders } from '@/lib/ai/anthropic-workspace';
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import type { AssistantTurnProvider, ProviderRequest, ProviderTurn } from './tool-loop';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Larger than the risk-assessment provider's 4096 because a tool-use turn
 * carries tool results in its context and must still have room to answer.
 * A reply that hits this is reported as a halt rather than parsed as complete.
 */
/**
 * Output cap per provider round-trip.
 *
 * EXPORTED because it is one of the three constants that bound assistant spend
 * (#3918). `spend-ceiling.ts` multiplies it by the loop's iteration cap and the
 * tenant daily quota to state the ceiling in tokens, so the figure in that
 * module's docblock cannot drift from this value.
 */
export const MAX_TOKENS = 8192;

/**
 * Per ROUND-TRIP, not per turn. The loop's own `wallClockMs` bounds the whole
 * turn; this stops one hung request from consuming all of it.
 */
const TIMEOUT_MS = 45_000;

/** Split `"<provider-id>/<model-id>"`, which is the only shape `resolveFlueModel` emits. */
export function splitSpecifier(specifier: string): { providerId: string; model: string } | null {
    const slash = specifier.indexOf('/');
    if (slash <= 0 || slash === specifier.length - 1) return null;
    return { providerId: specifier.slice(0, slash), model: specifier.slice(slash + 1) };
}

/** Anthropic's wire shape for one content block we care about. */
type AnthropicBlock =
    | { type: 'text'; text?: string }
    | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
    | { type: string; [k: string]: unknown };

/**
 * An assistant turn exactly as the API returned it, carried for replay (#4153).
 *
 * This is the Anthropic provider's {@link ProviderTurn.providerPart}. The
 * `kind` tag means a part written by some other provider is never mistaken for
 * one of ours. A turn that carries it is replayed from it, not rebuilt.
 */
interface AnthropicReplay {
    readonly kind: 'anthropic-content';
    readonly content: readonly unknown[];
}

function isAnthropicReplay(part: unknown): part is AnthropicReplay {
    return (
        typeof part === 'object' &&
        part !== null &&
        (part as { kind?: unknown }).kind === 'anthropic-content' &&
        Array.isArray((part as { content?: unknown }).content)
    );
}

/**
 * Build Anthropic's `messages` from the loop's history.
 *
 * AN ASSISTANT TURN IS REPLAYED, NOT REBUILT, when it carries its replay part
 * (#4153). The reply's content goes back exactly as it came, in its order:
 * `thinking` and `redacted_thinking` blocks with their signatures, the text
 * blocks untrimmed, and the `tool_use` blocks with their inputs. On the Claude 5
 * models thinking is on by default (it cannot be turned off on Opus 5.5), and
 * its blocks carry the model's reasoning and its progress notes between tool
 * calls. Two rules follow from the API:
 *
 *   - blocks a model cannot read are dropped, unbilled, but never edited;
 *   - a replayed block stays valid only while the system prompt, the tools
 *     array and every earlier message are byte-identical to when it was
 *     produced. The loop sends the same system and tools on every round-trip,
 *     and its history is append-only.
 *
 * Rebuilding the turn from `text` + `toolCalls` dropped every thinking block,
 * and would have broken that prefix in any case. Only a turn with no replay
 * part, which is every turn built by hand in a test, is rebuilt the old way.
 *
 * CONSECUTIVE TOOL RESULTS ARE BATCHED into one user message, because that is
 * the API's shape: a turn that requested three tools expects one user message
 * carrying three `tool_result` blocks. Emitting three separate user messages
 * interleaves roles the API rejects, and the error it returns does not say so.
 */
export function buildMessages(req: ProviderRequest): Array<{ role: 'user' | 'assistant'; content: unknown }> {
    const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
        { role: 'user', content: req.question },
    ];
    let pendingResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    const flush = (): void => {
        if (pendingResults.length === 0) return;
        out.push({ role: 'user', content: pendingResults });
        pendingResults = [];
    };

    for (const entry of req.history) {
        if (entry.role === 'tool') {
            pendingResults.push({ type: 'tool_result', tool_use_id: entry.id, content: entry.content });
            continue;
        }
        flush();
        if (isAnthropicReplay(entry.providerPart)) {
            out.push({ role: 'assistant', content: entry.providerPart.content });
            continue;
        }
        const blocks: unknown[] = [];
        if (entry.text !== null && entry.text.trim() !== '') blocks.push({ type: 'text', text: entry.text });
        for (const c of entry.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        out.push({ role: 'assistant', content: blocks });
    }
    flush();
    return out;
}

/** Normalise Anthropic's reply into the loop's provider-agnostic shape. */
export function parseTurn(data: {
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
}): ProviderTurn {
    const blocks = data.content ?? [];
    const text = blocks
        .filter((b): b is { type: 'text'; text?: string } => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();

    const toolCalls = blocks
        .filter((b): b is { type: 'tool_use'; id?: string; name?: string; input?: unknown } => b.type === 'tool_use')
        .filter((b) => typeof b.id === 'string' && typeof b.name === 'string')
        .map((b) => ({ id: b.id as string, name: b.name as string, args: b.input ?? {} }));

    // `max_tokens` is carried through rather than folded into `end`: the loop
    // reports a cut reply as a halt, because a truncated answer presented as a
    // finished one is the failure the bounds exist to prevent.
    const stopReason: ProviderTurn['stopReason'] =
        data.stop_reason === 'max_tokens' ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end';

    // Only reported when BOTH halves are present. A partial usage object would
    // otherwise be recorded as a complete cost with one side silently zero,
    // which under-reports — the direction a spend record must not fail in.
    const usage =
        typeof data.usage?.input_tokens === 'number' && typeof data.usage?.output_tokens === 'number'
            ? { tokensIn: data.usage.input_tokens, tokensOut: data.usage.output_tokens }
            : undefined;

    // THE REPLAY PART, unless a `tool_use` block was unusable. The filter above
    // drops a block with no id or name, so the loop would dispatch, and answer,
    // fewer calls than the replayed turn names, and the API rejects a
    // `tool_use` with no `tool_result`. In that case only, the turn is rebuilt
    // from what was parsed, the way it was before #4153.
    const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use').length;
    const providerPart: AnthropicReplay | undefined =
        Array.isArray(data.content) && toolUseBlocks === toolCalls.length
            ? { kind: 'anthropic-content', content: data.content }
            : undefined;

    return {
        text: text === '' ? null : text,
        toolCalls,
        stopReason,
        usage,
        ...(providerPart === undefined ? {} : { providerPart }),
    };
}

export class SpecifierMismatchError extends Error {
    constructor(expected: string, got: string) {
        super(
            `This provider serves "${expected}" specifiers only, and was handed "${got}". ` +
                'Refusing rather than serving it: a residency decision made in model-selection.ts ' +
                'must not be overridden at the socket.',
        );
        this.name = 'SpecifierMismatchError';
    }
}

/**
 * The external (Anthropic) tool-use provider.
 *
 * Reachable only by an EXTERNAL-residency tenant — `resolveFlueModel`
 * short-circuits LOCAL_ONLY before any external consideration, and the
 * specifier check below is the second gate on the same invariant.
 */
export class AnthropicAssistantProvider implements AssistantTurnProvider {
    constructor(
        private readonly apiKey: string,
        private readonly workspaceId?: string,
    ) {}

    async complete(req: ProviderRequest): Promise<ProviderTurn> {
        const parts = splitSpecifier(req.specifier);
        if (parts === null || parts.providerId !== FLUE_PROVIDER_IDS.external) {
            throw new SpecifierMismatchError(FLUE_PROVIDER_IDS.external, req.specifier);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        // A client disconnect must stop the upstream call (#3825). Wired here so
        // the behaviour exists before the streaming route needs it, rather than
        // being retrofitted onto a provider that ignored the signal.
        const onAbort = (): void => controller.abort();
        req.signal?.addEventListener('abort', onAbort, { once: true });

        let response: Response;
        try {
            response = await fetch(ANTHROPIC_API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'content-type': 'application/json',
                    ...anthropicWorkspaceHeaders(this.workspaceId),
                },
                body: JSON.stringify({
                    model: parts.model,
                    max_tokens: MAX_TOKENS,
                    system: req.system,
                    messages: buildMessages(req),
                    tools: req.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        input_schema: t.jsonSchema,
                    })),
                }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
            req.signal?.removeEventListener('abort', onAbort);
        }

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'unknown');
            throw new Error(`Anthropic API error ${response.status}: ${errorText.slice(0, 200)}`);
        }

        return parseTurn(await response.json());
    }
}

/**
 * The provider for a resolved model choice, or `null` when there is none.
 *
 * ═══ NULL IS A REAL ANSWER HERE, AND THE DIFFERENCE FROM FLUE MATTERS ═══
 *
 * `resolveFlueModel` REFUSES an unconfigured run rather than falling back,
 * and its docstring gives the reason: "A reasoning loop has no such answer.
 * There is no deterministic substitute for a model call, so an unconfigured run
 * must not start: a stub-backed 'agent run' would produce steps, charge tokens,
 * and write proposals that nothing reasoned about."
 *
 * The assistant is the exception to that reasoning, not a violation of it. It
 * HAS a deterministic substitute — the keyword router it is replacing, which
 * answers from the tenant's live posture data. That is a real answer, the way a
 * knowledge-base template is a real answer for a risk suggestion, rather than a
 * stub pretending to reason. So returning `null` here hands the turn back to
 * that router instead of refusing the user.
 *
 * A LOCAL_ONLY tenant also lands here, deliberately: there is no local tool-use
 * provider yet, and the only alternatives are the deterministic router or an
 * external call. Falling back is the safe one — a residency invariant must not
 * be traded for a better answer.
 */
export function assistantProviderFor(
    choice: { ok: true; specifier: string; residency: 'EXTERNAL' | 'LOCAL_ONLY' },
    env: { ANTHROPIC_API_KEY?: string; ANTHROPIC_WORKSPACE_ID?: string },
): AssistantTurnProvider | null {
    if (choice.residency === 'LOCAL_ONLY') return null;
    const parts = splitSpecifier(choice.specifier);
    if (parts === null || parts.providerId !== FLUE_PROVIDER_IDS.external) return null;
    if (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY === '') return null;
    return new AnthropicAssistantProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_WORKSPACE_ID);
}
