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
 * The refusal reaches the caller as a JSON-RPC error with the same rule ids.
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
import { assertGuardAllowed, assertNoReviewRequired, guardEgress } from '@/app-layer/ai/guard';

/** The guard's `source` for a direct MCP call, so its audit rows say where they came from. */
export function mcpArgumentSource(toolName: string): string {
    return `mcp-tool-args:${toolName}`;
}

/**
 * Scan a direct MCP tool call's arguments, and refuse unless the verdict is clean.
 *
 * Throws the guard's own typed `forbidden` (`ai_guard_blocked` /
 * `ai_guard_review_required`), which the route maps to a JSON-RPC error.
 */
export async function assertMcpArgumentsAllowed(
    ctx: RequestContext,
    toolName: string,
    args: unknown,
): Promise<void> {
    const outcome = await guardEgress(ctx, args, { source: mcpArgumentSource(toolName) });
    // The narrower assertion first, so a block reports itself as blocked rather
    // than as the milder "review required" it also is — the order
    // `ReviewLatch.check` uses for the same reason.
    assertGuardAllowed(outcome);
    assertNoReviewRequired(outcome);
}
