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

    const out: LoopTool[] = [];
    for (const def of set.tools) {
        const inputSchema = schemas.get(def.name);
        // A tool the adapter offered but the registry cannot describe would
        // reach the provider with no schema, and the model would guess at its
        // arguments. Dropped rather than sent, because a guessed argument is a
        // refused call that looks like a model error.
        if (inputSchema === undefined) continue;
        out.push({
            name: def.name,
            description: def.description,
            jsonSchema: inputSchema,
            run: async (args, signal) => def.run({ toolCallId: `assistant-${def.name}`, signal, data: args }),
        });
    }
    return {
        tools: out,
        reviewRequired: () => set.review.required,
        omitted: set.omitted,
    };
}
