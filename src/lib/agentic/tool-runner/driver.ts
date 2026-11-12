/**
 * THE TOOL RUNNER RUN DRIVER (Step 2b of `docs/claude-tool-runner-design.md`).
 *
 * Plans a run or refuses it before anything is sent, then hands the run to
 * `execute.ts`. The plan is arithmetic over the definition and the tenant's
 * residency, and `clientForRun` makes the residency decision: a LOCAL_ONLY
 * tenant is refused before anything external is read.
 *
 * Mapped in `drivers/index.ts`, and unreachable in this build:
 * `DRIVER_IMPLEMENTED['tool-runner']` is false, so `resolveAgentDriver` never
 * permits this engine and `selectRunDriver` never chooses it. Step 2c turns it
 * on.
 *
 * No dynamic-import boundary, unlike Flue: `@anthropic-ai/sdk` ships a
 * `require` condition, so this module loads in every Jest project.
 */
import type Anthropic from '@anthropic-ai/sdk';

import type { RequestContext } from '@/app-layer/types';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import {
    EXTERNAL_AI_ACK_SELECT,
    acknowledgementFrom,
    type ExternalAiAcknowledgement,
} from '@/lib/agentic/external-residency-gate';
import { RESIDENCY_SELECT, residencyTermsFrom } from '@/lib/agentic/flue/model-selection';
import { ENGINE_CAPS, type WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { clientForRun, type ToolRunnerClientRefusal, type ToolRunnerResidencyTerms } from './client';
import { executeToolRunnerRun } from './execute';

/** Why a run may not start on this engine. Each is an operator-actionable gap. */
export type ToolRunnerStartRefusal =
    | ToolRunnerClientRefusal
    /** The definition asked for another engine. */
    | 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER'
    /** The run resumed with its whole step budget already spent. */
    | 'NO_STEPS_REMAIN';

export type ToolRunnerRunPlan =
    | { ok: true; client: Anthropic; providerId: string }
    | { ok: false; reason: ToolRunnerStartRefusal };

/** Plan a run, or refuse it. Builds the run's client and sends nothing. */
export function planToolRunnerRun(
    def: WorkflowDefinition,
    fromSeq: number,
    selection: ToolRunnerResidencyTerms,
    runId?: string,
): ToolRunnerRunPlan {
    if (def.driver !== 'tool-runner') return { ok: false, reason: 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER' };
    if (fromSeq >= ENGINE_CAPS.MAX_STEPS) return { ok: false, reason: 'NO_STEPS_REMAIN' };
    const choice = clientForRun(selection, { runId });
    if (!choice.ok) return { ok: false, reason: choice.reason };
    return { ok: true, client: choice.client, providerId: choice.providerId };
}

/** The sentence a refused run is settled with. */
export function refusalMessage(reason: ToolRunnerStartRefusal): string {
    switch (reason) {
        case 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER':
            return 'tool_runner_not_requested: this workflow does not ask for the Tool Runner engine.';
        case 'NO_STEPS_REMAIN':
            return `tool_runner_no_steps_remain: the run resumed with its entire step budget already spent (${ENGINE_CAPS.MAX_STEPS}).`;
        case 'TOOL_RUNNER_LOCAL_ONLY_UNSERVED':
            return (
                'tool_runner_local_only_unserved: this workspace is LOCAL_ONLY, and the Tool Runner engine speaks only ' +
                'Anthropic\'s API, which no local gateway serves. Nothing was sent. Run it on the Flue engine.'
            );
        case 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED':
            return 'tool_runner_external_credential_not_configured: no Anthropic API key is configured for this deployment.';
        case 'SDK_AMBIENT_HEADERS_SET':
            return (
                'tool_runner_ambient_headers_set: ANTHROPIC_CUSTOM_HEADERS is set on this deployment, and the SDK would ' +
                'add it to every request. Unset it to run this engine.'
            );
    }
}

/**
 * The two per-tenant postures a Tool Runner run needs, read together: a named
 * type rather than an inline literal in the signature, for the reason the Flue
 * driver's `FlueRunPostures` gives.
 */
interface ToolRunnerPostures {
    readonly residency: ToolRunnerResidencyTerms;
    readonly acknowledgement: ExternalAiAcknowledgement;
}

/**
 * The tenant's residency terms and its business-data transfer acknowledgement
 * (#3872), in ONE read, as the Flue driver's `posturesFor` reads them (#5364).
 * The acknowledgement travels with the run for the reason it does there: the
 * question is what permitted this run, not what is set now.
 */
async function posturesFor(ctx: RequestContext): Promise<ToolRunnerPostures> {
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { ...RESIDENCY_SELECT, ...EXTERNAL_AI_ACK_SELECT },
        }),
    );
    return { residency: residencyTermsFrom(settings), acknowledgement: acknowledgementFrom(settings) };
}

export async function runToolRunnerDriver(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
): Promise<RunDriverOutcome> {
    const postures = await posturesFor(ctx);
    const plan = planToolRunnerRun(def, fromSeq, postures.residency, runId);
    if (!plan.ok) {
        // Settled, not thrown: the run row already exists.
        const status = await failRun(ctx, runId, refusalMessage(plan.reason));
        return { status, stepFailures: 0 };
    }

    logger.warn('tool-runner: starting a run on the Tool Runner engine', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        requestId: ctx.requestId,
        runId,
        workflowKey: def.key,
    });

    return executeToolRunnerRun(ctx, runId, def, fromSeq, runStartMs, plan.client, {
        providerId: plan.providerId,
        externalAiAcknowledgement: postures.acknowledgement,
    });
}
