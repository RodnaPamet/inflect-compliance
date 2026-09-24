/**
 * Canned workflow — "Framework onboarding" (Epic Agentic 1B).
 *
 * Turns "you installed a framework, now stare at 40 empty requirements" into
 * "here's a proposed starting control set, approve it." A DECLARATIVE step
 * sequence the engine runs — no bespoke orchestration.
 *
 * Input: { frameworkKey } — the newly-installed framework's key.
 */
import type { WorkflowDefinition, WorkflowContext } from '../workflow-types';

interface Gaps {
    summary?: { total?: number; mapped?: number; unmapped?: number; coveragePercent?: number };
    unmappedRequirements?: Array<{ code: string; title?: string; section?: string }>;
}

const frameworkKeyOf = (ctx: WorkflowContext): string =>
    typeof ctx.input.frameworkKey === 'string' ? ctx.input.frameworkKey : '';

export const frameworkOnboardingWorkflow: WorkflowDefinition = {
    key: 'framework-onboarding',
    name: 'Framework onboarding',
    description:
        'Read the newly-installed framework, find its uncovered requirements, and ' +
        'propose a starting control set for your approval.',
    steps: [
        { kind: 'READ', label: 'tenant', tool: 'get_tenant_context' },
        {
            kind: 'READ', label: 'frameworkStatus', tool: 'get_framework_status',
            args: (ctx) => ({ frameworkKey: frameworkKeyOf(ctx) }),
        },
        {
            kind: 'READ', label: 'gaps', tool: 'find_coverage_gaps',
            args: (ctx) => ({ frameworkKey: frameworkKeyOf(ctx), limit: 50 }),
        },
        {
            kind: 'PROPOSE', label: 'proposedControls', tool: 'propose_controls',
            // One candidate control per uncovered requirement (capped at the
            // propose tool's 20-item limit).
            buildItems: (ctx) => {
                const gaps = ctx.outputs['gaps'] as Gaps | undefined;
                const unmapped = gaps?.unmappedRequirements ?? [];
                return unmapped.slice(0, 20).map((r) => ({
                    name: `${r.code} — control`,
                    description: r.title ? `Implements requirement ${r.code}: ${r.title}` : `Implements requirement ${r.code}`,
                    category: r.section ?? 'Onboarding',
                    status: 'NOT_STARTED',
                }));
            },
            rationale: (ctx) => `Proposed starting controls for the uncovered requirements of ${frameworkKeyOf(ctx)}.`,
        },
        {
            kind: 'HUMAN_CHECKPOINT', label: 'reviewControls',
            // 48 HOURS. Onboarding a framework is a setup action somebody is
            // actively doing: the run is started BY the person who will review
            // it, usually in the same sitting. A long window here would not
            // buy more scrutiny, it would leave half-finished onboardings
            // parked for a month.
            approvalWindow: '48h',
        },
        {
            kind: 'SYNTHESIS', label: 'summary',
            synthesize: (ctx) => {
                const gaps = ctx.outputs['gaps'] as Gaps | undefined;
                const proposed = ctx.outputs['proposedControls'] as { proposed?: number } | undefined;
                const key = frameworkKeyOf(ctx);
                const total = gaps?.summary?.total ?? 0;
                const remaining = gaps?.summary?.unmapped ?? 0;
                const n = proposed?.proposed ?? 0;
                return {
                    text:
                        `Onboarded ${key}: proposed ${n} controls for review. ` +
                        `${remaining} of ${total} requirements were uncovered; approving the ` +
                        `proposed controls will begin closing those gaps (evidence still required per control).`,
                    data: { frameworkKey: key, proposedControls: n, totalRequirements: total, uncovered: remaining },
                };
            },
        },
    ],
};
