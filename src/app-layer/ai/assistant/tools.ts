/**
 * The assistant's tool set — the existing funnels, nothing new (#3810).
 *
 * `flueToolsFor` already bridges the MCP read and propose surfaces into an
 * engine-shaped tool list whose `run` routes through `runReadTool` /
 * `runProposeTool`. Despite the name it is not flue-specific: it takes an
 * `McpInvocation` and returns plain `{ name, description, run }` definitions.
 * So this file adapts rather than re-implements, and in particular it inherits
 * the **ReviewLatch** — "review, once required, stays required across every
 * subsequent tool, on EITHER surface" — which a hand-rolled list would not
 * have, and whose absence would let a flagged read be followed by a clean
 * proposal.
 *
 * ═══ WHERE THE JSON SCHEMA COMES FROM ═══
 *
 * The provider needs JSON Schema; `FlueToolDefinition.input` is a valibot
 * schema, because that is what flue's runtime validates with. Rather than
 * convert, each tool's schema is read from the MCP tool's OWN `inputSchema`,
 * which already exists for the wire protocol. That keeps the registry the one
 * catalogue — `tools-adapter.ts` warns that a second `READ_TOOLS.filter(...)`
 * chain elsewhere "is the shape that lets two catalogues of the same thing
 * disagree", and a converted schema would be a second description of the same
 * input.
 *
 * ═══ WHAT BOUNDS THE SET FOR A SESSION USER ═══
 *
 * A session user's invocation has `agentId: null`, so `grantedTools` is null
 * and the deny-by-default exposure term is SKIPPED rather than narrowed — which
 * `workflow-runs.ts` flags as "the worse one" for an unbound caller. The
 * binding filter here is the third one `loadableReadTools` applies:
 * `canSee(inv, t.authorize.keys)`, the acting context's own permission keys.
 *
 * So the assistant is offered exactly the tools its asker could call
 * themselves. That is the guarantee — the assistant cannot out-read its asker —
 * and it also keeps `AUTHZ_DENIED` meaningful: the registry warns that
 * advertising tools which will 403 "turns every plan into a sequence of
 * denials ... a design that manufactures thousands of them from ordinary
 * planning is a design that trains operators to ignore it".
 */
import { flueToolsFor } from '@/lib/agentic/flue/tools-adapter';
import { loadableReadTools } from '@/lib/mcp/tools/registry';
import { loadableProposeTools } from '@/lib/mcp/tools/propose-tools';
import type { McpInvocation } from '@/lib/mcp/authorize';
import type { LoopTool } from './tool-loop';

/**
 * What one propose CALL did, recovered as data (#3882).
 *
 * ═══ WHY THIS IS PARSED HERE AND NOT SOMEWHERE ELSE ═══
 *
 * `runProposeTool` returns structured JSON it authors itself —
 * `{ proposed, quarantined, kind, proposalIds, quarantinedProposalIds, message }`
 * — so recovering the ids is reading a contract, not scraping prose.
 *
 * It is read in THIS module for two reasons. `tool-loop.ts` must not learn
 * what a proposal is: it is a generic dispatch loop, and a loop that knew
 * about proposals would have to know about the next thing too. And the model's
 * own sentence must not be the channel, because then the user-facing text
 * would be relayed rather than composed — the guarantee #3847 depends on.
 *
 * This module already adapts every tool's `run` into the loop's shape, so the
 * parse sits on a seam that exists rather than inventing one.
 */
export interface ProposalOutcome {
    /** The propose tool that produced it, e.g. `propose_risks`. */
    readonly tool: string;
    /** `AgentProposalKind` as the funnel reported it. */
    readonly kind: string;
    /** Ids that reached the review queue. */
    readonly queued: readonly string[];
    /** Ids the content guard withheld — terminal, never reviewable. */
    readonly quarantined: readonly string[];
    /**
     * The item titles the model submitted, in order.
     *
     * Carried so the one-item sentence can quote the title exactly as the
     * deterministic path always has, rather than the wording changing because
     * the caller changed. The VERDICT — queued or quarantined — never comes
     * from here; it comes from which id array the funnel put an id in.
     */
    readonly titles: readonly string[];
    /**
     * Set when the result could not be read.
     *
     * Recorded rather than swallowed, and NOT collapsed into "nothing was
     * proposed": a row may exist. Composing "nothing was created" from an
     * unreadable result would be the same error as a metric reporter posting
     * `0` on a failed read — it converts "we cannot tell" into an all-clear,
     * and here the all-clear is about a compliance record.
     */
    readonly unreadable?: true;
}

/** The tool set plus the latch the loop must consult — see `assistantTools`. */
export interface AssistantToolSet {
    readonly tools: readonly LoopTool[];
    /**
     * True once ANY tool tripped the review guard.
     *
     * The loop reads this rather than inspecting a thrown error, for two
     * reasons. The latch is the AUTHORITY — it is what `tools-adapter.ts`
     * keeps as "ONE latch for the whole tool set" so a flagged read cannot be
     * followed by a clean proposal. And matching on an error message prefix
     * (`ai_guard_review_required:`) would go silently blind the first time that
     * string is reworded, which is a failure mode this repo has already paid
     * for more than once.
     */
    reviewRequired(): boolean;
    readonly omitted: ReadonlyArray<{ name: string; reason: string }>;
    /**
     * Propose outcomes recorded this turn, in call order.
     *
     * A function rather than a field because the loop fills it as it runs —
     * a snapshot taken at construction would always be empty.
     */
    proposals(): readonly ProposalOutcome[];
}

/** Item titles out of a propose call's arguments, defensively. */
function titlesOf(args: unknown): string[] {
    const items = (args as { items?: unknown })?.items;
    if (!Array.isArray(items)) return [];
    return items
        .map((i) => (i as { title?: unknown })?.title)
        .filter((t): t is string => typeof t === 'string');
}

/** Read one propose result. Never throws; an unreadable result says so. */
export function parseProposalOutcome(
    tool: string,
    raw: string,
    titles: readonly string[] = [],
): ProposalOutcome {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            return { tool, kind: 'unknown', queued: [], quarantined: [], titles, unreadable: true };
        }
        const o = parsed as {
            kind?: unknown;
            proposalIds?: unknown;
            quarantinedProposalIds?: unknown;
        };
        const ids = (v: unknown): string[] =>
            Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        // The two arrays are the whole statement. A `status` scalar used to sit
        // beside them and was removed (#3900) because it read `PENDING` even
        // when every item had been quarantined — so it is deliberately not
        // consulted here even if an older build still sends it.
        return {
            tool,
            kind: typeof o.kind === 'string' ? o.kind : 'unknown',
            queued: ids(o.proposalIds),
            quarantined: ids(o.quarantinedProposalIds),
            titles,
        };
    } catch {
        return { tool, kind: 'unknown', queued: [], quarantined: [], titles, unreadable: true };
    }
}

/** Read + propose tools this invocation may actually call, in the loop's shape. */
export function assistantTools(
    inv: McpInvocation,
    opts: { readOnly?: boolean } = {},
): AssistantToolSet {
    const set = flueToolsFor(inv, undefined, undefined, { readOnly: opts.readOnly });

    // One lookup table from the SAME functions the adapter filtered through, so
    // a tool offered without a schema is impossible rather than merely unlikely.
    const schemas = new Map<string, unknown>();
    for (const t of loadableReadTools(inv)) schemas.set(t.name, t.inputSchema);
    for (const t of loadableProposeTools(inv)) schemas.set(t.name, t.inputSchema);

    // Which of the offered names are PROPOSE tools, taken from the same
    // function the adapter filtered through rather than from a name pattern:
    // `propose_*` is a convention, and a convention is not a list.
    const proposeNames = new Set(loadableProposeTools(inv).map((t) => t.name));
    const outcomes: ProposalOutcome[] = [];

    const out: LoopTool[] = [];
    for (const def of set.tools) {
        const inputSchema = schemas.get(def.name);
        // A tool the adapter offered but the registry cannot describe would
        // reach the provider with no schema, and the model would guess at its
        // arguments. Dropped rather than sent, because a guessed argument is a
        // refused call that looks like a model error.
        if (inputSchema === undefined) continue;
        const isPropose = proposeNames.has(def.name);
        out.push({
            name: def.name,
            description: def.description,
            jsonSchema: inputSchema,
            run: async (args, signal) => {
                const raw = await def.run({
                    toolCallId: `assistant-${def.name}`,
                    signal,
                    data: args,
                });
                // The result goes back to the model UNCHANGED. Recording the
                // outcome is a side-channel for the caller, not a rewrite of
                // what the model reads — the model still gets the funnel's own
                // honest sentence, which stays the second line of defence.
                if (isPropose) outcomes.push(parseProposalOutcome(def.name, raw, titlesOf(args)));
                return raw;
            },
        });
    }
    return {
        tools: out,
        reviewRequired: () => set.review.required,
        omitted: set.omitted,
        proposals: () => outcomes,
    };
}
