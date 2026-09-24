/**
 * The registry of runnable workflow definitions (Epic Agentic 1A).
 *
 * Phase 1A ships the engine plus one trivial diagnostic workflow that proves the
 * end-to-end loop (a READ step + a SYNTHESIS step). The real
 * framework-onboarding / audit-prep workflows are added to this registry in 1B —
 * they are DECLARATIVE definitions the SAME engine runs, no bespoke
 * orchestration.
 */
import type { WorkflowDefinition } from './workflow-types';
import { frameworkOnboardingWorkflow } from './workflows/framework-onboarding';
import { auditPrepWorkflow } from './workflows/audit-prep';
import { postureReviewWorkflow } from './workflows/posture-review';

/**
 * "Diagnostic" — read the tenant's compliance posture, then synthesise a
 * one-line health summary. No PROPOSE step, no checkpoint — the smallest run
 * that exercises READ → SYNTHESIS → COMPLETED.
 */
const diagnosticWorkflow: WorkflowDefinition = {
    key: 'diagnostic',
    name: 'Posture diagnostic',
    description: 'Read the compliance posture and synthesise a one-line health summary.',
    steps: [
        { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
        {
            kind: 'SYNTHESIS',
            label: 'summary',
            synthesize: (ctx) => {
                const posture = ctx.outputs['posture'] as
                    | { stats?: { controls?: number; risks?: number; openTasks?: number } }
                    | undefined;
                const s = posture?.stats ?? {};
                return {
                    text:
                        `Posture snapshot — ${s.controls ?? 0} controls, ${s.risks ?? 0} risks, ` +
                        `${s.openTasks ?? 0} open tasks.`,
                    data: { stats: s },
                };
            },
        },
    ],
};

const REGISTRY: Record<string, WorkflowDefinition> = {
    [diagnosticWorkflow.key]: diagnosticWorkflow,
    // Epic Agentic 1B — the real canned workflows (declarative defs the engine runs).
    [frameworkOnboardingWorkflow.key]: frameworkOnboardingWorkflow,
    [auditPrepWorkflow.key]: auditPrepWorkflow,
    // The first definition that ASKS for the Flue engine. `selectRunDriver`
    // intersects that request with the operator switch, the tenant toggle and
    // `DRIVER_IMPLEMENTED`, so on every deployment that has not enabled Flue
    // this runs on the static engine like its neighbours.
    [postureReviewWorkflow.key]: postureReviewWorkflow,
};

/**
 * Register a workflow definition (used by 1B to add the real workflows). Throws
 * on a duplicate key so two definitions can never silently shadow each other.
 */
export function registerWorkflow(def: WorkflowDefinition): void {
    if (REGISTRY[def.key]) throw new Error(`Duplicate workflow key: ${def.key}`);
    REGISTRY[def.key] = def;
}

export function getWorkflowDefinition(key: string): WorkflowDefinition | undefined {
    return REGISTRY[key];
}

export function listWorkflowDefinitions(): WorkflowDefinition[] {
    return Object.values(REGISTRY);
}
