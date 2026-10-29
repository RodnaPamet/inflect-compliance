/**
 * ONE ART 12 DECISION ROW PER MODEL CALL of the Tool Runner engine (Step 2b).
 *
 * The row's input digest is taken over the request that produced the call
 * (`runner.params` while the reply is handled), and the MODEL_CALL step names
 * the same digest, which is how a reviewer follows a step to its row. The
 * request is hashed and never stored (`logAiDecision`).
 *
 * The model is the one that ANSWERED (`message.model`), which a server-side
 * fallback can make different from the one asked for.
 */
import { logAiDecision } from '@/app-layer/ai/decision-log';
import type { RequestContext } from '@/app-layer/types';
import { aiSystemIdFor } from '@/lib/agentic/flue/model-decision';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/** The provider every Tool Runner call goes to. */
export const TOOL_RUNNER_PROVIDER = 'anthropic';

export async function recordToolRunnerDecision(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    request: unknown,
    /** This call's own text, sanitised and bounded by `logAiDecision`. */
    outputSummary: string | null,
    usage: { tokensIn: number; tokensOut: number },
    model: string,
    latencyMs: number | null,
): Promise<void> {
    try {
        await runInTenantContext(ctx, async (db) => {
            await logAiDecision(db, ctx, {
                feature: `agentic-run:${def.key}`,
                provider: TOOL_RUNNER_PROVIDER,
                model,
                sanitizedInput: request,
                sessionRef: runId,
                outputSummary,
                latencyMs,
                tokensIn: usage.tokensIn || null,
                tokensOut: usage.tokensOut || null,
                aiSystemId: ctx.agentId ? await aiSystemIdFor(db, ctx) : null,
            });
        });
    } catch (err) {
        // The run's own record (the MODEL_CALL step) is already written; a
        // regulator's row that cannot be written must not stop it.
        logger.error('tool-runner: could not record the Art 12 decision row', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            workflow: def.key,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
    }
}
