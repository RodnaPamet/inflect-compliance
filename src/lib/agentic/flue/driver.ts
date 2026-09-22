import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { planFlueRun, refusalMessage } from './driver-plan';
import type { FlueModelSelection } from './model-selection';

/**
 * The tenant's AI-residency posture — the SAME three columns
 * `risk-suggestions.ts` reads for the same decision.
 *
 * Read here rather than passed in, so `runFlueDriver` satisfies the `RunDriver`
 * contract exactly and the registry stays a plain map. A driver that needed a
 * seventh argument would make the map's value type per-driver, and then
 * `selectRunDriver` could no longer return "a driver" at all.
 *
 * A tenant with no settings row resolves to `undefined` throughout, which
 * `resolveFlueModel` reads as EXTERNAL — the same default
 * `tenant-security-settings.ts` applies when the row is absent.
 */
async function residencyTermsFor(ctx: RequestContext): Promise<FlueModelSelection> {
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { aiResidency: true, aiLocalBaseUrl: true, aiLocalModel: true },
        }),
    );
    return {
        residency: settings?.aiResidency,
        localBaseUrl: settings?.aiLocalBaseUrl,
        localModel: settings?.aiLocalModel,
    };
}

/**
 * THE FLUE RUN DRIVER — the half that needs a database.
 *
 * ── WHAT IS HERE AND WHAT IS NOT ────────────────────────────────────────────
 *
 * Deciding whether a run may start, and against which model, is arithmetic
 * over values and lives in `driver-plan.ts`, where it is tested exhaustively
 * without a runtime. What is left here is the part that genuinely needs one:
 * resolving the invocation, settling the run row, and handing the execution
 * over.
 *
 * ── THE RUNTIME IS REACHED BY DYNAMIC IMPORT, AND THAT IS LOAD-BEARING ──────
 *
 * `@flue/runtime` is ESM-only with no `require` condition. A STATIC import of
 * it anywhere in this module's graph would make every jest suite that
 * transitively reaches the driver registry unloadable — and `drivers/index.ts`
 * is reached by a great many of them.
 *
 * So the execution half sits behind `await import('./execute')`, on the path
 * that has already decided a Flue run is happening. A refused run never
 * evaluates that import at all, which is why the refusal path below is
 * testable in the ordinary node project while the execution path is not.
 *
 * `tests/guards/flue-refused-capabilities.test.ts` keeps the static import
 * from coming back.
 */
export async function runFlueDriver(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
): Promise<RunDriverOutcome> {
    const plan = planFlueRun(def, fromSeq, await residencyTermsFor(ctx));

    if (!plan.ok) {
        // SETTLED, not thrown. The run row already exists — `createSealedRun`
        // wrote it before any driver was chosen — so a throw would leave it
        // RUNNING for the reaper to settle a wall-clock budget later, with an
        // error nobody attached to it. Every other halt in this subsystem ends
        // the same way: a FAILED row carrying a sentence.
        const status = await failRun(ctx, runId, refusalMessage(plan.reason));
        return { status, stepFailures: 0 };
    }

    // WARN, not info: reaching here means a tenant is configured for an engine
    // that has never executed a production run, and an operator watching the
    // first ones should not have to go looking for the line.
    logger.warn('flue-driver: starting a run on the Flue engine', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        requestId: ctx.requestId,
        runId,
        workflowKey: def.key,
        residency: plan.residency,
        // The SPECIFIER, which names the provider id and therefore the
        // residency decision. Not a credential, and not the prompt.
        model: plan.modelSpecifier,
    });

    const { executeFlueRun } = await import('./execute');
    return executeFlueRun(ctx, runId, def, fromSeq, runStartMs, plan.modelSpecifier);
}
