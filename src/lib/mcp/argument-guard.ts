/**
 * The AI Guard's EGRESS slice on a direct MCP caller's READ tool arguments.
 *
 * ## Why the direct route needs it
 *
 * An agent Inflect runs reaches the funnel through `runGuardedTool`
 * (`src/lib/agentic/flue/tools-adapter.ts`), whose step 1 scans the model's
 * proposed arguments before the funnel runs. An agent the CUSTOMER runs —
 * their own Agent SDK code, a Managed Agent, any MCP client — reaches the same
 * funnel through `/api/mcp`, and until this module that door scanned nothing.
 * Proposals were still guarded (`createAgentProposal` scans each item at the
 * queue); a read's arguments were not.
 *
 * This is the same slice, in the same place relative to the funnel: BEFORE
 * `runReadTool`, because the funnel both authorizes and executes, and a scan
 * after it would report on a read that already ran.
 *
 * ## Both verdicts refuse
 *
 * `block` refuses, as it must everywhere. `flag` refuses too, as it does in
 * `runGuardedTool`: a flagged argument is one a person should look at before
 * anything acts on it, and a direct MCP call has no run to park and no
 * reviewer waiting, so the only honest answer is no. The guard itself writes
 * the hash-chained audit row for any non-clean verdict, carrying rule ids only.
 *
 * ## The refusal names no rule (#4205)
 *
 * The caller is told `ai_guard_blocked` or `ai_guard_review_required` and
 * nothing else. It used to carry the rule ids, via the shared
 * `assertGuardAllowed` / `assertNoReviewRequired`, and on THIS door that is an
 * oracle: a direct caller has no latch stopping it from calling again, so it
 * can vary one argument at a time and read back which rule fired until it finds
 * an argument that passes. A prompt-injected agent can do the same.
 *
 * The ids are not lost — `guardEgress` has already written them to the
 * hash-chained row, which is where an operator reads them. What changes is only
 * who learns them.
 *
 * This is done HERE rather than in `assertGuardAllowed`, deliberately. That
 * helper is shared with the hosted-agent paths, where the refusal travels to a
 * run's own decision log rather than to a stranger, and rewording it would
 * change the refusal text everywhere and redden every test pinned to that
 * prose for no gain.
 *
 * ## What it deliberately does not do
 *
 * It does not scan a PROPOSE call. `createAgentProposal` already runs both the
 * injection and the egress scan on the proposed content, and a non-clean item
 * becomes a terminal QUARANTINED row a reviewer can see. A refusal here would
 * replace that visible record with a bare error, so the route calls this for
 * read tools only.
 *
 * It does not scan the RESULT. `runGuardedTool` scans a result because it is
 * about to enter Inflect's own model; a direct caller's result enters the
 * caller's model, which Inflect neither runs nor can protect from here.
 */
import type { RequestContext } from '@/app-layer/types';
import { guardEgress } from '@/app-layer/ai/guard';
import { forbidden } from '@/lib/errors/types';

/**
 * How much of the tool name the audit `source` carries.
 *
 * The name reaching this module is RESOLVED — `runReadTool` has already matched
 * it against the offered set, so an arbitrary string a caller invented cannot
 * get here (#4205). The bound is for what is left: an external tool's name is
 * advertised by a CUSTOMER's server, so it is still somebody else's text
 * landing in a hash-chained row that streams to a SIEM. Generous enough that no
 * real name is touched — `mcp-tool-args:list_risks` and the longest
 * `ext:<connectionId>:<tool>` both fit well inside it.
 */
const MAX_SOURCE_TOOL_NAME = 120;

/** The guard's `source` for a direct MCP call, so its audit rows say where they came from. */
export function mcpArgumentSource(toolName: string): string {
    return `mcp-tool-args:${toolName.slice(0, MAX_SOURCE_TOOL_NAME)}`;
}

/**
 * Scan a direct MCP tool call's arguments, and refuse unless the verdict is clean.
 *
 * Throws `forbidden('ai_guard_blocked')` or
 * `forbidden('ai_guard_review_required')` — the codes, carrying no rule ids,
 * which the route maps to a JSON-RPC error. See the header.
 */
export async function assertMcpArgumentsAllowed(
    ctx: RequestContext,
    toolName: string,
    args: unknown,
): Promise<void> {
    const outcome = await guardEgress(ctx, args, { source: mcpArgumentSource(toolName) });
    // The narrower verdict first, so a block reports itself as blocked rather
    // than as the milder "review required" it also is — the order
    // `ReviewLatch.check` uses for the same reason.
    if (outcome.blocked) throw forbidden('ai_guard_blocked');
    if (outcome.reviewRequired) throw forbidden('ai_guard_review_required');
}
