import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { resolveFlueModel, type FlueModelSelection, type FlueModelRefusal } from './model-selection';

/**
 * EVERYTHING A FLUE RUN DECIDES BEFORE IT TOUCHES THE RUNTIME.
 *
 * ── WHY THE DRIVER IS SPLIT AT ALL ──────────────────────────────────────────
 *
 * A Flue run needs two things that no single jest project can load together.
 * It needs Prisma — to resolve the invocation, record steps and charge tokens
 * — and it needs `@flue/runtime`, which is ESM-only and can only be loaded
 * under the `flue` project, where `pg` does not load at all ("Class extends
 * value [object Module] is not a constructor").
 *
 * That is not a testing inconvenience to route around; it is a line worth
 * drawing anyway. Everything DECIDABLE about a run — may it start, which
 * model, what would refuse it — is arithmetic over values, and arithmetic
 * belongs on the side that can be tested exhaustively and cheaply. What is
 * left on the runtime side is dispatch and collection, which is the part that
 * genuinely needs a runtime to mean anything.
 *
 * So: this module decides, the driver executes, and neither one has to import
 * the other's dependencies.
 */

/** Why a run may not start. Each is an operator-actionable configuration gap. */
export type FlueStartRefusal =
    | FlueModelRefusal
    /** The definition asked for a driver other than flue. */
    | 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER'
    /** The run resumed past the steps a definition declares. */
    | 'NO_STEPS_REMAIN'
    /**
     * The chosen model is not one the runtime registered at boot.
     *
     * Decided AFTER the plan — it needs the started runtime's provider list —
     * but its message belongs with the others, so an operator reading
     * `errorMessage` sees one vocabulary rather than two.
     */
    | 'MODEL_NOT_REGISTERED';

export type FlueRunPlan =
    | { ok: true; modelSpecifier: string; residency: 'EXTERNAL' | 'LOCAL_ONLY' }
    | { ok: false; reason: FlueStartRefusal };

/**
 * Decide whether this run may start on the Flue engine, and against what.
 *
 * ORDERED so the cheapest and most specific refusal wins. A definition that
 * asked for the static engine is refused before any residency arithmetic,
 * because "you asked for something else" is a better answer than "your local
 * gateway is unconfigured" for a run that never wanted this engine.
 *
 * NOTE this does NOT decide authority. The tool allowlist, the key's scopes,
 * the autonomy ceiling and the policy card are settled by `resolveMcpInvocation`
 * and the funnel behind every tool call — a plan that returns `ok` has decided
 * only that the engine may run, never what it may reach.
 */
export function planFlueRun(
    def: WorkflowDefinition,
    fromSeq: number,
    selection: FlueModelSelection,
): FlueRunPlan {
    if (def.driver !== 'flue') {
        return { ok: false, reason: 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER' };
    }
    // A resume past the last declared step has nothing to execute. Refusing
    // here rather than dispatching an agent with no work keeps a no-op out of
    // the ledger, where it would look like a run that did something.
    if (fromSeq >= def.steps.length) {
        return { ok: false, reason: 'NO_STEPS_REMAIN' };
    }

    const model = resolveFlueModel(selection);
    if (!model.ok) return { ok: false, reason: model.reason };

    return { ok: true, modelSpecifier: model.specifier, residency: model.residency };
}

/**
 * The message a refused run records.
 *
 * One sentence, naming the reason and what to do about it. These land in
 * `WorkflowRun.errorMessage`, which is what the run list and the run detail
 * page show an operator — so a bare enum value would be a code someone has to
 * go and look up while a run is stopped.
 */
export function refusalMessage(reason: FlueStartRefusal): string {
    switch (reason) {
        case 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER':
            return 'flue_driver_not_requested: this workflow does not ask for the Flue engine.';
        case 'NO_STEPS_REMAIN':
            return 'flue_no_steps_remain: the run resumed past the last declared step.';
        case 'LOCAL_GATEWAY_NOT_CONFIGURED':
            return (
                'flue_local_gateway_not_configured: this workspace is LOCAL_ONLY and no ' +
                'local AI gateway is configured, so the run cannot reason without leaving ' +
                'the residency boundary. Set the gateway URL, or move the workspace to EXTERNAL.'
            );
        case 'LOCAL_MODEL_NOT_CONFIGURED':
            return (
                'flue_local_model_not_configured: the local AI gateway is configured but ' +
                'names no model. Set the local model.'
            );
        case 'MODEL_NOT_REGISTERED':
            return (
                'flue_model_not_registered: the model this workspace asks for is not one ' +
                'this deployment registered at startup. Providers are registered once at ' +
                'boot, so a per-workspace model override must also be configured on the ' +
                'deployment.'
            );
        case 'EXTERNAL_CREDENTIAL_NOT_CONFIGURED':
            return (
                'flue_external_credential_not_configured: no model credential is configured ' +
                'for this deployment, so no run can reason.'
            );
    }
}
