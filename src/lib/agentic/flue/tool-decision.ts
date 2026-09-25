/**
 * The Art 12 record for a call this deployment did not serve.
 *
 * `model-decision.ts` records the decision a MODEL made; this records the one
 * fact that file cannot: that a step of this run was executed by a THIRD PARTY.
 * Everything else about an external call is already written down — the funnel's
 * hash-chained audit row names the tool and the policy version, and the
 * `TOOL_CALL` step carries the arguments the model chose. What none of them say
 * is that the work left the platform, which is the disclosure an Art 12 record
 * exists to make.
 *
 * ## Why the `provider` column is the honest home
 *
 * It already means "who processed this". For a model call that is the inference
 * vendor; for an external tool call it is the MCP server. Adding a column for
 * the same question would give a reader two places to look and one of them
 * would be empty half the time.
 *
 * The value is `mcp:<connectionId>` rather than the server's URL. The id cannot
 * move — a tenant can re-point a connection without the record losing what it
 * referred to — and it joins straight back to the `IntegrationConnection` row
 * that carries the name, the URL and who configured it. A URL copied into a
 * compliance row is a second copy of an egress target that can silently go
 * stale.
 *
 * ## Written where `runId` is, and nowhere else
 *
 * `sessionRef` is the Art 14 join: it is how a human reviewing a run finds the
 * decisions the run made. `RequestContext` carries no run id, so a row written
 * from a tool's `run` could not set it — and `tools-adapter.ts` states plainly
 * that it may not reach for Prisma. The engine is the one place that holds the
 * run, the step and the write seam at once.
 *
 * ## A failed call is recorded too
 *
 * An external call that threw still SENT something outward. A record that
 * disclosed only the successes would be a record of the calls that worked
 * rather than of the data that left.
 */
import { logAiDecision } from '@/app-layer/ai/decision-log';
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { logger } from '@/lib/observability/logger';

import { aiSystemIdFor } from './model-decision';

/**
 * Record that an external server executed a step of this run.
 *
 * A no-op for a built-in tool — the overwhelming majority of calls — so the
 * engine can call it unconditionally rather than deciding at the call site
 * whether a tool is somebody else's. That decision belongs to the one function
 * that knows how an external name is spelled.
 *
 * Best-effort, like `recordModelDecision`: a run that failed because its
 * DISCLOSURE row could not be written would be a worse outcome than a missing
 * row, and the funnel's audit entry is the durable record either way.
 */
export async function recordExternalToolDecision(
    ctx: RequestContext,
    input: {
        runId: string;
        toolName: string;
        status: 'DONE' | 'FAILED';
        latencyMs?: number | null;
    },
): Promise<void> {
    const ref = parseExternalToolName(input.toolName);
    if (!ref) return;

    try {
        await runInTenantContext(ctx, async (db) => {
            await logAiDecision(db, ctx, {
                // Namespaced away from `agentic-run:` on purpose: these rows
                // answer "what left the platform", and a reader filtering for
                // model decisions should not have to exclude them by hand.
                feature: 'agentic-tool:external',
                provider: `mcp:${ref.connectionId}`,
                // No model served this. Null rather than a placeholder — a
                // made-up model name in a compliance row is worse than a gap,
                // because a gap is legible as one.
                model: null,
                // The tool the far end ran. Never the arguments: those are
                // already on the `TOOL_CALL` step, and `logAiDecision` digests
                // whatever it is given, so repeating them here would add a
                // second hash of the same thing and no new fact.
                sanitizedInput: ref.toolName,
                outputSummary: `external ${input.status.toLowerCase()}`,
                sessionRef: input.runId,
                latencyMs: input.latencyMs ?? null,
                aiSystemId: ctx.agentId ? await aiSystemIdFor(db, ctx) : null,
            });
        });
    } catch (err) {
        logger.warn('flue.external_tool_decision_unrecorded', {
            tenantId: ctx.tenantId,
            runId: input.runId,
            connectionId: ref.connectionId,
            error: err instanceof Error ? err.message : 'non-Error thrown',
        });
    }
}
