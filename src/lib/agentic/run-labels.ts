/**
 * The names a person reads for a workflow run's STATUS, a step's STATUS and the
 * STATUS of a proposal a step queued, as message keys under the `agents`
 * namespace.
 *
 * The runs list showed run statuses as words since #4472, but the run detail
 * page and an agent's Runs tab still printed the stored codes — `DONE`,
 * `AWAITING_APPROVAL`, `PENDING` — in both languages (#4532).
 *
 * Each list mirrors its Prisma enum. `tests/unit/agent-run-labels.test.ts`
 * compares every list with the generated enum and every key with both message
 * catalogues, so a value added to an enum fails CI until it is named.
 *
 * A value not on a list — a status a newer build wrote and this one does not
 * know, after a rollback — is shown as stored, which is the truth, rather than
 * as a missing-message path.
 *
 * NO IMPORTS, so client components can read it.
 */

/** `WorkflowRunStatus`, mirrored. */
export const RUN_STATUSES = [
    'RUNNING',
    'AWAITING_APPROVAL',
    'PAUSED',
    'COMPLETED',
    'ABORTED',
    'FAILED',
    'EMPTY_CATALOGUE',
] as const;

/** `WorkflowStepStatus`, mirrored. */
export const STEP_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'] as const;

/** `SuggestionItemStatus`, the column `AgentProposal.status` stores, mirrored. */
export const PROPOSAL_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'EDITED', 'QUARANTINED', 'EXPIRED'] as const;

const RUN: ReadonlySet<string> = new Set(RUN_STATUSES);
const STEP: ReadonlySet<string> = new Set(STEP_STATUSES);
const PROPOSAL: ReadonlySet<string> = new Set(PROPOSAL_STATUSES);

/** The `agents` message key naming a run status, or null for one not on the list. */
export function runStatusLabelKey(status: string): string | null {
    return RUN.has(status) ? `runs.status.${status}` : null;
}

/** The `agents` message key naming a step status, or null for one not on the list. */
export function stepStatusLabelKey(status: string): string | null {
    return STEP.has(status) ? `runs.detail.stepStatus.${status}` : null;
}

/** The `agents` message key naming a proposal status, or null for one not on the list. */
export function proposalStatusLabelKey(status: string): string | null {
    return PROPOSAL.has(status) ? `runs.detail.proposalStatus.${status}` : null;
}
