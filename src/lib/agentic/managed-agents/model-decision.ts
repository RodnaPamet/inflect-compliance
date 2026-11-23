/**
 * ONE ART 12 DECISION ROW PER `span.model_request_end` of the Managed Agents
 * engine (Step 5b of `docs/claude-managed-agents-design.md`, #4165).
 *
 * SPAN-DERIVED, and marked so. The session runs at Anthropic, so Inflect never
 * sees the prompt of an individual model call: it sees that a call ended, and
 * what it cost. The row's input digest therefore covers WHAT INFLECT SENT to
 * the session before that call (the session's `system` override, the opening
 * message and every tool result, in order), never what the model saw. The
 * owner accepted that weaker row on 2026-10-30 (decision 3): the record holds
 * what Inflect sent and every tool call through the funnel, and each call's
 * prompt is held in the customer's workspace.
 *
 * The marker is the row's `provider`, `MANAGED_AGENTS_SPAN_PROVIDER`: a value
 * no other writer uses, read by Step 5d's run timeline to label the row. No
 * column is added to `AiDecisionLog`, an append-only table this step has no
 * reason to migrate.
 */
import { logAiDecision } from '@/app-layer/ai/decision-log';
import type { RequestContext } from '@/app-layer/types';
import { aiSystemIdFor } from '@/lib/agentic/flue/model-decision';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * The `provider` of every decision row this engine writes. It names the
 * provider AND says the row is span-derived: the per-call prompt was not
 * visible to Inflect.
 */
export const MANAGED_AGENTS_SPAN_PROVIDER = 'anthropic-managed-agents:span-derived';

/** What Inflect had sent to the session when a model call ended: the decision row's input. */
export interface InflectSentInput {
    readonly basis: 'INFLECT_SENT';
    readonly agent: { readonly id: string; readonly version: number };
    readonly system: string;
    /** Every event Inflect sent, in order: the opening message, each tool result. */
    readonly sent: ReadonlyArray<unknown>;
}

export async function recordManagedAgentsDecision(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    input: InflectSentInput,
    /** The model's text for this call, only when the egress scan found it clean. */
    outputSummary: string | null,
    usage: { tokensIn: number; tokensOut: number },
    model: string,
): Promise<void> {
    try {
        await runInTenantContext(ctx, async (db) => {
            await logAiDecision(db, ctx, {
                feature: `agentic-run:${def.key}`,
                provider: MANAGED_AGENTS_SPAN_PROVIDER,
                model,
                sanitizedInput: input,
                sessionRef: runId,
                outputSummary,
                latencyMs: null,
                tokensIn: usage.tokensIn || null,
                tokensOut: usage.tokensOut || null,
                aiSystemId: ctx.agentId ? await aiSystemIdFor(db, ctx) : null,
            });
        });
    } catch (err) {
        // The run's own record (the MODEL_CALL step) is already written; a
        // regulator's row that cannot be written must not stop it.
        logger.error('managed-agents: could not record the Art 12 decision row', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            workflow: def.key,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
    }
}
