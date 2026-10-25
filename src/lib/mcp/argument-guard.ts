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
 * This is the same slice, in the same place relative to the read: before it
 * executes, because a scan after it would report on a read that already ran.
 *
 * ## Both verdicts refuse
 *
 * `block` refuses, as it must everywhere. `flag` refuses too, as it does in
 * `runGuardedTool`: a flagged argument is one a person should look at before
 * anything acts on it, and a direct MCP call has no run to park and no
 * reviewer waiting, so the only honest answer is no. The guard itself writes
 * the hash-chained audit row for any non-clean verdict, carrying rule ids only.
 *
 * ## The caller is not told which rule fired (#4205)
 *
 * The refusal reaches the caller as a JSON-RPC error naming the verdict and
 * nothing else. It used to carry the rule ids, and this route has no latch:
 * a caller, or a prompt-injected agent, could retry and learn which rule fired
 * each time, which is how a payload is tuned to slip past the scanner.
 * `propose-tools.ts` withholds the ids for the same reason. The audit row
 * keeps them for the people who need them.
 *
 * ## It runs after the gate (#4205)
 *
 * The route passes it to `runReadTool` as `beforeRun`, which runs after the
 * tool has resolved and passed `authorizeToolCall`. Before #4205 it ran ahead
 * of both: a made-up tool name with secret-shaped arguments wrote a guard row
 * whose source was the caller's own text, and a call the gate would have
 * refused was recorded as a guard verdict instead of `AUTHZ_DENIED`.
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
    // The narrower refusal first, so a block reports itself as blocked rather
    // than as the milder "review required" it also is — the order
    // `ReviewLatch.check` uses for the same reason. The codes are the ones
    // `assertGuardAllowed` / `assertNoReviewRequired` use; the rule ids are not
    // repeated.
    if (outcome.blocked) {
        throw forbidden('ai_guard_blocked: the AI Guard refused these arguments.');
    }
    if (outcome.reviewRequired) {
        throw forbidden('ai_guard_review_required: the AI Guard flagged these arguments for review.');
    }
}
