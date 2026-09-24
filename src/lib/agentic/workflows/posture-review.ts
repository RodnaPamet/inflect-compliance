/**
 * Canned workflow — "Posture review", and the FIRST definition that asks for
 * the Flue engine.
 *
 * ── WHY A NEW DEFINITION RATHER THAN A FLAG ON AN EXISTING ONE ──────────────
 *
 * `selectRunDriver` resolves flue only when the DEFINITION asks for it, so
 * until one does, points 02-05 of the integration plan cannot execute however
 * the operator sets the switches. The obvious minimal change is to add
 * `driver: 'flue'` to a workflow that already ships — and it is the wrong one,
 * because the two engines do not run a definition the same way. The static
 * engine WALKS the steps: it calls each `args`, each `buildItems`, each
 * `synthesize`, in order. Flue does not (`runMessage` in `flue/execute.ts`
 * says so in as many words) — it hands the model the description and the step
 * list as a SPECIFICATION and lets it choose its own calls. Flagging
 * `audit-prep` would therefore change what `audit-prep` does for everyone
 * already running it, silently, on the day a tenant opts in.
 *
 * So the engine becomes reachable by adding a workflow, which an operator
 * SELECTS, rather than by re-pointing one they already depend on.
 *
 * ── AND WHY IT IS READ-ONLY ─────────────────────────────────────────────────
 *
 * This is the first workflow that can execute on an engine which has never
 * run in production. Every step here is a READ or a SYNTHESIS: there is no
 * PROPOSE, so the run cannot queue a proposal, and propose-not-commit means it
 * could not have committed one anyway. That keeps the blast radius of the
 * first real Flue runs to "it read some rows and wrote a summary".
 *
 * It also sidesteps a mismatch a write-workflow would have to answer first.
 * `HUMAN_CHECKPOINT` is enforced by the static engine PARKING the run at that
 * step; a Flue run does not walk the steps, so a declared checkpoint is a line
 * of specification rather than a gate. Flue parks on approval through the tool
 * adapter instead (`tools-adapter.ts`). A definition with no PROPOSE step
 * needs neither mechanism, and the question of which one a Flue write-workflow
 * relies on can be settled before one exists rather than during.
 *
 * ── IT STILL HAS TO RUN ON THE STATIC ENGINE ────────────────────────────────
 *
 * `driver` is a REQUEST, and on every deployment that has not enabled Flue the
 * intersection resolves to static. That is not a degraded path to be tolerated
 * — it is what this workflow does today, everywhere. So the steps below are a
 * complete static definition: real tools, real args, a real synthesis. The
 * Flue request is additive.
 *
 * Input: none. The whole review is tenant-scoped reads with no parameters, so
 * it can be started from the runs page with nothing filled in.
 */
import type { WorkflowDefinition, WorkflowContext } from '../workflow-types';

interface Posture {
    stats?: { controls?: number; risks?: number; openTasks?: number };
}

const arrayLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

export const postureReviewWorkflow: WorkflowDefinition = {
    driver: 'flue',

    key: 'posture-review',
    name: 'Posture review',
    description:
        'Review what needs attention across the workspace: the compliance posture, ' +
        'evidence falling due, open findings and overdue remediation tasks — and ' +
        'say what to do first. Read-only; nothing is proposed or changed.',
    steps: [
        { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
        {
            kind: 'READ', label: 'expiringEvidence', tool: 'list_evidence_expiring',
            args: () => ({ days: 30 }),
            // Enrichment, not the point of the run. A tenant with no evidence
            // domain reachable should still get a posture review rather than a
            // FAILED row — see `continueOnFailure` in `workflow-types.ts`, and
            // note the failure is still recorded and still counted.
            continueOnFailure: true,
        },
        {
            kind: 'READ', label: 'findings', tool: 'list_findings',
            args: () => ({ limit: 100 }),
            continueOnFailure: true,
        },
        {
            kind: 'READ', label: 'overdueTasks', tool: 'list_tasks',
            args: () => ({ due: 'overdue', limit: 100 }),
            continueOnFailure: true,
        },
        {
            kind: 'SYNTHESIS',
            label: 'review',
            synthesize: (ctx: WorkflowContext) => {
                const stats = (ctx.outputs['posture'] as Posture | undefined)?.stats ?? {};
                const expiring = arrayLen(ctx.outputs['expiringEvidence']);
                const findings = arrayLen(ctx.outputs['findings']);
                const overdue = arrayLen(ctx.outputs['overdueTasks']);

                // Ordered by what stops an audit soonest: work already late,
                // then evidence about to lapse, then findings still open.
                const attention = [
                    overdue > 0 ? `${overdue} overdue task(s)` : null,
                    expiring > 0 ? `${expiring} evidence item(s) due within 30 days` : null,
                    findings > 0 ? `${findings} open finding(s)` : null,
                ].filter(Boolean) as string[];

                return {
                    text:
                        `Posture review — ${stats.controls ?? 0} controls, ${stats.risks ?? 0} risks. ` +
                        (attention.length
                            ? `Needs attention (${attention.length}): ${attention.join('; ')}.`
                            : 'Nothing overdue, expiring or open.'),
                    data: {
                        stats,
                        expiringEvidence: expiring,
                        openFindings: findings,
                        overdueTasks: overdue,
                        attention,
                    },
                };
            },
        },
    ],
};
