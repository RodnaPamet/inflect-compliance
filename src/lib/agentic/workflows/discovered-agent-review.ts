/**
 * DISCOVERED AGENT REVIEW — the first workflow that declares skills (#3668,
 * step 1d of the agentic IAM roadmap).
 *
 * One discovered agent in, two answers out: a verdict with its evidence for
 * every harness criterion (`harness-level-assessment`), and an owner suggested
 * from the signals a scan observed, for a person to confirm
 * (`nhi-ownership-attribution`). Each answer parses through
 * `src/lib/agentic/iam-skill-outputs.ts` before anything may use it: the
 * attribution can only ever be a suggestion, and the assessment names an
 * evidence reference for every criterion or says it is not evidenced.
 *
 * ── THE SKILLS ARE DECLARED HERE, AND ONLY HERE ─────────────────────────────
 *
 * A run mounts exactly what its definition declares (rule 2 of
 * `docs/agent-skill-standard.md`), and only on the Flue engine: the static
 * engine walks the steps and mounts nothing, recording `[]`. Admission resolves
 * both names through the mount gate and pins each one's name, version and
 * hash before the run row exists, so a skill whose evaluation record stopped
 * passing refuses the run rather than teaching it something unevaluated.
 *
 * ── THE REQUIRED INPUT, AND HOW IT BECOMES THE SKILLS' INPUT ────────────────
 *
 * The run cannot start without `discoveredAgentId` (refused at admission,
 * before the row exists). Both skills declare `requiredInput: discoveredAgent`
 * — the scan record of the one agent — and the READ step below is what turns
 * the id into that record, under the label the skills name it by.
 *
 * ── READ-ONLY, LIKE EVERY FLUE-REQUESTING WORKFLOW ──────────────────────────
 *
 * No PROPOSE step and no write tool. Proposing an owner is TEXT here; turning a
 * confirmed suggestion into a register row is the registration intake's act
 * (step 2a), performed by a person.
 */
import type { WorkflowContext, WorkflowDefinition } from '../workflow-types';
import { requiredString } from './required-input';

/** The two IAM skills, by name — the whole of what a run of this workflow is taught. */
export const DISCOVERED_AGENT_REVIEW_SKILLS = ['harness-level-assessment', 'nhi-ownership-attribution'] as const;

interface Facts {
    discoveredId?: string;
    scan?: { scanRef?: string; completeness?: string } | null;
    observations?: unknown[] | null;
}

export const discoveredAgentReviewWorkflow: WorkflowDefinition = {
    // The skills are mounted only on the Flue engine; on a deployment that has
    // not enabled it this runs the declared read and synthesis, statically.
    driver: 'flue',
    skills: DISCOVERED_AGENT_REVIEW_SKILLS,
    /** Refused at admission without it — see `requiredInput` on the type. */
    requiredInput: ['discoveredAgentId'],

    key: 'discovered-agent-review',
    name: 'Discovered agent review',
    description:
        'Review one discovered agent from what its harness scan observed. For every harness '
        + 'criterion give a verdict with the evidence pointer behind it, or say it is not '
        + 'evidenced; state no level. Then suggest an accountable owner from the signals, '
        + 'graded, for a person to confirm, or say who could not be proposed and why. '
        + 'Read-only: record nothing, mark nothing owned, propose nothing.',
    steps: [
        {
            kind: 'READ',
            // The name both skills give their required input.
            label: 'discoveredAgent',
            tool: 'get_discovered_agent',
            args: (ctx) => ({ discoveredAgentId: requiredString(ctx, 'discoveredAgentId') }),
        },
        {
            kind: 'SYNTHESIS',
            label: 'review',
            synthesize: (ctx: WorkflowContext) => {
                const facts = ctx.outputs['discoveredAgent'] as Facts | undefined;
                const observed = Array.isArray(facts?.observations) ? facts.observations.length : null;
                const scan = facts?.scan ?? null;
                // Deliberately says only what the READ step returned. The
                // verdicts and the owner suggestion are the skills' answers,
                // given on the Flue engine; a synthesis that stated a level or
                // an owner from these counts would be inventing one.
                return {
                    text:
                        `Discovered agent ${facts?.discoveredId ?? requiredString(ctx, 'discoveredAgentId')}: `
                        + (scan
                            ? `${observed === null ? 'unreadable' : observed} criterion observation(s) from scan `
                                + `${scan.scanRef} (${scan.completeness}).`
                            : 'no scan item has been read for it.')
                        + ' No level and no owner is stated here.',
                    data: {
                        discoveredAgentId: requiredString(ctx, 'discoveredAgentId'),
                        observations: observed,
                        scanCompleteness: scan?.completeness ?? null,
                    },
                };
            },
        },
    ],
};
