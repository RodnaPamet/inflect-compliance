/**
 * AUDIT NARRATIVE — the auditor agent explains a period's workpapers (#3749).
 *
 * One period in, one narrative per workpaper out: a few sentences a reviewer
 * reads beside the workpaper — what the procedure tested, what the sample
 * showed, and the conclusion the workpaper records. The five procedures
 * themselves are deterministic code on the control-test runner; this is the
 * part of the auditor's work that code does not do.
 *
 * ── THE SKILL ───────────────────────────────────────────────────────────────
 *
 * `iam-audit-procedures`, declared here and mounted only on the Flue engine
 * through the mount gate, which refuses the run before its row exists unless
 * the skill's evaluation record passes. Its "Narrating a period's workpapers"
 * section is what a run of this workflow uses.
 *
 * ── READ-ONLY, BY CONSTRUCTION ──────────────────────────────────────────────
 *
 * `readOnly`: on Flue the run is offered the read surface alone, so the
 * auditor agent's `propose_finding` grant is withheld for it (owner decision 2
 * on #3749: the procedure runner already proposed a finding for every
 * exception). No PROPOSE step, and no tool here writes a workpaper or touches
 * a finding. The narrative is TEXT in the answer; turning it into a stored row
 * is the capture's act (`audit-workpaper-narrative.ts`), which holds it to the
 * workpaper first.
 *
 * ── THE INPUT ───────────────────────────────────────────────────────────────
 *
 * `periodLabel`, refused at admission when absent. The READ step lists that
 * period's workpapers through `list_audit_workpapers`, under the label the
 * skill names them by.
 */
import type { WorkflowContext, WorkflowDefinition } from '../workflow-types';
import { requiredString } from './required-input';

/** The one skill a run of this workflow is taught. */
export const AUDIT_NARRATIVE_SKILLS = ['iam-audit-procedures'] as const;

interface Listing {
    workpapers?: Array<{ narrated?: boolean }>;
    truncated?: boolean;
}

export const auditNarrativeWorkflow: WorkflowDefinition = {
    driver: 'flue',
    skills: AUDIT_NARRATIVE_SKILLS,
    readOnly: true,
    /** Refused at admission without it — see `requiredInput` on the type. */
    requiredInput: ['periodLabel'],

    key: 'audit-narrative',
    name: 'Audit workpaper narrative',
    description:
        "Read one period's audit workpapers and draft, for each one not yet narrated, the short "
        + 'narrative a reviewer reads beside it: what the procedure tested, what the sample showed, '
        + 'and the conclusion the workpaper records. State no conclusion and cite no code the '
        + 'workpaper does not record. Read-only: write no workpaper, propose nothing, close nothing.',
    steps: [
        {
            kind: 'READ',
            // The name the skill gives its input.
            label: 'workpapers',
            tool: 'list_audit_workpapers',
            args: (ctx) => ({ periodLabel: requiredString(ctx, 'periodLabel') }),
        },
        {
            kind: 'SYNTHESIS',
            label: 'narrative',
            synthesize: (ctx: WorkflowContext) => {
                const listing = ctx.outputs['workpapers'] as Listing | undefined;
                const all = Array.isArray(listing?.workpapers) ? listing.workpapers : [];
                const pending = all.filter((w) => w.narrated !== true).length;
                // Says only what the READ step returned. The narratives are the
                // skill's answer, given on the Flue engine; a synthesis that
                // described a workpaper from these counts would be inventing one.
                return {
                    text:
                        `Period ${requiredString(ctx, 'periodLabel')}: ${all.length} workpaper(s)`
                        + `${listing?.truncated ? ' (more exist)' : ''}, ${pending} not yet narrated.`
                        + ' No narrative is written here.',
                    data: {
                        periodLabel: requiredString(ctx, 'periodLabel'),
                        workpapers: all.length,
                        notNarrated: pending,
                        truncated: listing?.truncated === true,
                    },
                };
            },
        },
    ],
};
