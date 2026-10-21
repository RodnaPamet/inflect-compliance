/**
 * THE ANSWER TEXT OF A SETTLED RUN, for the synchronous A2A response (#3863).
 *
 * SAP's Joule toolkit reads its answer out of the `message/send` result —
 * `result.body.status.message.parts[0].text`, confirmed from
 * `references/joule-capability.md:155,436` — and never calls `tasks/get`. So a
 * response carrying only a task state gives Joule nothing to show its user.
 * This is where the words come from.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO SOURCES, BECAUSE THE TWO ENGINES ANSWER DIFFERENTLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `driver` is a REQUEST that `selectRunDriver` intersects with what the
 * deployment permits, so the SAME workflow key settles on either engine
 * depending on the tenant. Both have to answer.
 *
 *   FLUE   the model's final text is recorded by `recordModelDecision` into
 *          `AiDecisionLog.outputSummary`, the EU AI Act Art 12 row, keyed to
 *          the run through `sessionRef` — "the feedback join key", which
 *          carries the `WorkflowRun` id for an agentic run
 *          (`flue/model-decision.ts`, and the column's own comment).
 *
 *   STATIC the engine walks the steps, so a SYNTHESIS step's return value is
 *          recorded on its own row: `WorkflowStep.outputJson`, holding the
 *          `{ text, data }` the `synthesize` function produced.
 *
 * `WorkflowRun.summary` is NOT a third source and is not consulted: it is
 * never written by anything (#3910). It is the obvious-looking place to read
 * this from, which is why that is said out loud here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A SECOND SINK FOR MODEL PROSE, AND THAT IS THE POINT TO REVIEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tests/guards/flue-model-output-has-one-destination.test.ts` exists because
 * model free-text is NOT egress-scanned on the way out of the model, and the
 * reason that is safe is a claim about where it can go: a tool argument (scanned
 * before the funnel) or one column. Reading that column back out and sending it
 * to another organisation is a new destination, and the guard as written could
 * not see it — it counts reads of `reply.text` inside `execute.ts` and the
 * recorder, and this is neither.
 *
 * What makes it safe is not that the text is trusted but that the A2A answer
 * ALREADY passes `guardEgress` before it leaves: `a2a-inbound.ts` wraps every
 * response in an `answer` closure that scans it and withholds a flagged one.
 * The same discipline the in-product asking surface settled on
 * (`assistant.ts` — `guardEgress` with `source: 'assistant:outbound'` before
 * the prose reaches a user).
 *
 * So the invariant is no longer "one sink" but "no sink without a scan", and
 * the guard is rewritten to say that rather than relaxed. A future reader
 * adding a third sink has to satisfy the scan, not delete a count.
 */
import { runInTenantContext } from '@/lib/db-context';

import type { RequestContext } from '../types';

/** How much of a run's answer travels in the A2A text part. */
export const A2A_ANSWER_TEXT_MAX = 4_000;

/**
 * The settled run's answer, or `null` when it recorded none.
 *
 * `null` is a real outcome rather than an error: a run can settle having
 * written no narrative — a static definition whose synthesis returned nothing,
 * or a Flue turn that called tools and stopped. The caller says "no answer was
 * recorded" rather than inventing one.
 */
export async function settledRunAnswerText(ctx: RequestContext, runId: string): Promise<string | null> {
    // FLUE FIRST, and the order matters: a run that reached the model has the
    // model's words, which are the answer. A Flue run may also carry step rows,
    // so preferring the step would return scaffolding over the answer.
    const decision = await runInTenantContext(ctx, (db) =>
        db.aiDecisionLog.findFirst({
            where: { tenantId: ctx.tenantId, sessionRef: runId, outputSummary: { not: null } },
            orderBy: { createdAt: 'desc' },
            select: { outputSummary: true },
        }),
    );
    const fromModel = decision?.outputSummary?.trim();
    if (fromModel) return clamp(fromModel);

    // STATIC: the last SYNTHESIS step's `text`.
    const steps = await runInTenantContext(ctx, (db) =>
        db.workflowStep.findMany({
            where: { tenantId: ctx.tenantId, runId, kind: 'SYNTHESIS', outputJson: { not: null } },
            // By `seq`, which is the step's position in the run and what
            // `@@index([runId, seq])` is for — `WorkflowStep` has no
            // `createdAt`. The LAST synthesis is the answer: a definition may
            // synthesise more than once, and an earlier one is working.
            orderBy: { seq: 'desc' },
            take: 1,
            select: { outputJson: true },
        }),
    );
    const raw = steps[0]?.outputJson;
    if (!raw) return null;
    // A malformed or shapeless payload is "no answer", never a throw: this runs
    // inside a response path, and a parse error here would turn a settled run
    // into a failed request.
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
            const text = (parsed as { text: string }).text.trim();
            return text ? clamp(text) : null;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Bound the text that crosses the boundary.
 *
 * Truncated with a marker rather than silently: a host showing its user a
 * sentence that stops mid-word, with nothing saying why, has been given a
 * wrong answer rather than a short one.
 */
function clamp(text: string): string {
    if (text.length <= A2A_ANSWER_TEXT_MAX) return text;
    return `${text.slice(0, A2A_ANSWER_TEXT_MAX)}\n\n[truncated — read the full review in Inflect]`;
}

/**
 * WHAT A HOST CONSUMER IS TOLD, for every way a wait can end.
 *
 * Pure, and separated from the reading and the waiting so that what Joule's
 * user sees can be tested without a database or a clock. Each arm exists
 * because a host that is told only a state code cannot say anything useful to
 * the person who asked.
 *
 * ## No internal detail, in any arm
 *
 * A failed run carries `errorMessage`, and it is deliberately NOT forwarded.
 * It is written for an operator reading Inflect, so it can name a tool, a
 * column, a guard rule id or a stack frame — none of which a Joule user can act
 * on, and all of which would cross an organisation boundary. The words below
 * say what happened and what to do instead, which is the part that is
 * actionable. The reason is still recorded on this side: the run row and the
 * audit trail hold it for whoever can act on it.
 */
export function hostConsumerAnswerText(
    outcome: { readonly status: string; readonly settled: boolean; readonly parked: boolean },
    answerText: string | null,
    runId: string,
): string {
    if (outcome.settled) {
        switch (outcome.status) {
            case 'COMPLETED':
                // The whole point of the synchronous path. A completed run with
                // no recorded narrative is reported as such rather than as an
                // empty answer, which would read as "nothing was found".
                return (
                    answerText
                    ?? 'The review finished and recorded no written findings. '
                        + 'Open the run in Inflect to see what it examined.'
                );
            case 'FAILED':
                return (
                    'The review could not be completed. Nothing was changed. '
                    + 'The reason is recorded in the Inflect workspace for whoever administers this '
                    + `integration; quote run ${runId} when asking them.`
                );
            case 'ABORTED':
                return (
                    'The review was stopped before it finished, so there is no result. '
                    + `Nothing was changed. Run ${runId} in the Inflect workspace has the detail.`
                );
            default:
                // An unknown terminal status is not a success, and saying so
                // beats inventing a description of it.
                return (
                    'The review ended in a state this integration does not recognise, so there is no '
                    + `result to report. Run ${runId} in the Inflect workspace has the detail.`
                );
        }
    }
    if (outcome.parked) {
        // This is what stands in place of mapping the state to
        // `input-required` (owner decision on #3863): the words can name WHO
        // must act, where that state code would have told Joule the CALLER
        // must, which is false — the approval is given by a person inside the
        // Inflect workspace and no caller can supply it.
        return (
            'The review is waiting for a person in the Inflect workspace to approve it before it can '
            + `finish. Nobody outside that workspace can give that approval. Ask again for task ${runId} `
            + 'once it has been approved.'
        );
    }
    return (
        'The review is still running. Ask again for task '
        + `${runId} to get the result.`
    );
}
