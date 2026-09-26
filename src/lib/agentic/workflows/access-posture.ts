import type { WorkflowContext, WorkflowDefinition } from '../workflow-types';

const arrayLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/**
 * ACCESS POSTURE — "is this work assigned to somebody who still works here?"
 *
 * ── WHY THIS WORKFLOW EXISTS ────────────────────────────────────────────────
 *
 * #2859 made an external tool grantable to an agent, and the first production
 * run of a governed agent proved every link of that chain except the one it was
 * for: the connection authorised, the catalogue read, three definitions were
 * approved by a named human, three tools were granted — and the agent called
 * none of them. `WorkflowStep` recorded four TOOL_CALLs, all internal.
 *
 * Nothing had gone wrong. `runMessage` builds a Flue run's objective from the
 * definition's `description` plus its declared steps, and the only Flue
 * workflow that existed asked for a compliance posture review over four named
 * internal tools. A model told to do that has no reason to query a directory,
 * and it did not. The capability was reachable and unreached.
 *
 * ── WHY THE INSTRUCTION IS IN THE DESCRIPTION AND NOT A STEP ────────────────
 *
 * A `READ` step names its tool as a static string, and an external tool's name
 * is `mcp__<connectionId>__<name>` — the connection id is per-tenant runtime
 * data that a definition compiled into the build cannot know. So no declared
 * step can ever name one, and an external tool is reachable ONLY by a model
 * choosing it.
 *
 * That makes the description the only place the choice can be invited, which is
 * exactly what it is for: it is the first line of the message the agent is
 * given. The steps below are the reads that must happen; the directory check is
 * asked for in prose because prose is the only instrument that can ask for it.
 *
 * ── WHY IT IS A REAL QUESTION AND NOT A DEMONSTRATION ───────────────────────
 *
 * A finding assigned to somebody who has left is not in progress. It is
 * stranded, and it is indistinguishable from live work for exactly as long as
 * nobody asks the directory — which is the gap between an access review and the
 * remediation queue that access reviews do not close. That is worth asking
 * whether or not it also exercises a transport.
 *
 * ── VENDOR-NEUTRAL ON PURPOSE ───────────────────────────────────────────────
 *
 * "The directory tools you have been granted" names no vendor and no protocol.
 * A tenant whose directory is Entra, Okta or Google gets the same objective and
 * the same run; the tools it can actually reach are whatever a human approved
 * and granted, which is the only thing that should decide it. It is also what
 * the operator-copy rule requires — name the feature, never the transport.
 */
export const accessPostureWorkflow: WorkflowDefinition = {
    // The whole point is a model CHOOSING a tool from an objective, which is
    // the Flue engine's contract. On a deployment without Flue this resolves to
    // the static engine and runs the declared reads only — a narrower answer,
    // not a broken one.
    driver: 'flue',

    key: 'access-posture',
    name: 'Access posture',
    description:
        'Review the open findings and overdue remediation tasks in this workspace, and '
        + 'then check the people they are assigned to against the directory, using the '
        + 'directory tools you have been granted. Work assigned to somebody whose account '
        + 'is no longer active is not in progress — it is stranded, and it looks exactly '
        + 'like live work until somebody asks the directory. Report what is open, and '
        + 'separately what appears to be assigned to somebody who is no longer there. '
        + 'Read-only: look things up, change nothing, propose nothing.',
    steps: [
        {
            kind: 'READ',
            label: 'findings',
            tool: 'list_findings',
            args: () => ({ limit: 100 }),
        },
        {
            // Enrichment rather than the point, so a tenant whose task domain
            // is unreachable still gets the finding half — the same reasoning
            // `posture-review` gives for its own optional reads.
            kind: 'READ',
            label: 'overdueTasks',
            tool: 'list_tasks',
            args: () => ({ due: 'overdue', limit: 100 }),
            continueOnFailure: true,
        },
        {
            kind: 'SYNTHESIS',
            label: 'review',
            synthesize: (ctx: WorkflowContext) => {
                const findings = arrayLen(ctx.outputs['findings']);
                const overdue = arrayLen(ctx.outputs['overdueTasks']);

                // Deliberately says only what THESE steps read. The directory
                // half is the model's to report in its own answer: it chose
                // those calls, their results are in its context and not in
                // `ctx.outputs`, and a synthesis that claimed a number for them
                // would be inventing one.
                return {
                    text:
                        `${findings} open finding(s) and ${overdue} overdue task(s) reviewed `
                        + 'for assignment to people who may no longer hold an active account.',
                    data: { findings, overdue },
                };
            },
        },
    ],
};
