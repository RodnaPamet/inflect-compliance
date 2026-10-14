/**
 * The ordered step feed for one agent run (#3472, plan point 08).
 *
 * The PROJECTION lives in `lib/agentic/run-step-projection.ts` and is
 * re-exported here, because this module reaches Prisma and the run page must
 * not: Prisma drags in `jobs/queue` -> `bullmq` -> an ESM-only `msgpackr`, and
 * a jsdom test that renders the page failed to load at all when the page
 * imported this file. What belongs here is the QUERY — bounded, cursor-exact,
 * tenant-scoped — and nothing else.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead } from '@/app-layer/policies/common';
import { notFound } from '@/lib/errors/types';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import {
    projectRunSteps,
    isLiveRunStatus,
    type RunStepFeedRow,
} from '@/lib/agentic/run-step-projection';

export {
    projectRunSteps,
    decisionDigestOf,
    isLiveRunStatus,
} from '@/lib/agentic/run-step-projection';
export type {
    RunStepFeedRow,
    ProjectableStep,
    ProjectableProposal,
} from '@/lib/agentic/run-step-projection';

/**
 * A page of steps is BOUNDED. "Never stream unbounded history" is the point:
 * a run that looped for an hour has a ledger a canvas must not try to hold,
 * and an SSE tail that re-sent everything on reconnect would re-send it per
 * reconnect.
 *
 * 200 is the cap, not the default: the static engine's workflows declare at
 * most a dozen steps, so one page covers every run the shipped definitions can
 * produce, and only a Flue run that reasoned for a long time pages at all.
 */
export const MAX_STEP_FEED_TAKE = 200;
export const DEFAULT_STEP_FEED_TAKE = 100;

export interface RunStepFeed {
    runId: string;
    status: string;
    /** The run's own counter. A client compares it against `steps` to page. */
    stepCount: number;
    /** `true` while the run can still produce steps — the tail should stay open. */
    live: boolean;
    /** The highest `seq` in THIS page, or `sinceSeq` when the page is empty. */
    cursor: number;
    /** `true` when a further page exists at `cursor`. */
    hasMore: boolean;
    steps: RunStepFeedRow[];
}

/**
 * One bounded page of a run's ordered steps, after `sinceSeq`.
 *
 * `sinceSeq` is EXCLUSIVE and defaults to -1 so the first call starts at
 * `seq: 0` — a run's first step. Passing the previous page's `cursor` back
 * gives the next page, and because the ledger is append-only and ordered, that
 * is exact rather than approximate: no step can be inserted behind the cursor,
 * so nothing is missed and nothing is re-sent.
 */
export async function getRunStepFeed(
    ctx: RequestContext,
    runId: string,
    opts: { sinceSeq?: number; take?: number } = {},
): Promise<RunStepFeed> {
    assertCanRead(ctx);
    const sinceSeq = Number.isFinite(opts.sinceSeq) ? Number(opts.sinceSeq) : -1;
    // Clamped, not trusted. `take` arrives from a query string, and a caller
    // asking for 10_000 would be asking the browser to hold the whole ledger.
    const take = Math.min(
        Math.max(1, Number.isFinite(opts.take) ? Number(opts.take) : DEFAULT_STEP_FEED_TAKE),
        MAX_STEP_FEED_TAKE,
    );

    const result = await runInTenantContext(ctx, async (db) => {
        const run = await db.workflowRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            select: { id: true, status: true, stepCount: true, workflowKey: true },
        });
        if (!run) return null;

        // `take + 1` so `hasMore` is MEASURED rather than inferred from
        // `stepCount`. The counter is written by the executor and a client
        // comparing against it would be guessing during the window between a
        // step's insert and the run row's update.
        const steps = await db.workflowStep.findMany({
            where: { runId, tenantId: ctx.tenantId, seq: { gt: sinceSeq } },
            orderBy: { seq: 'asc' },
            take: take + 1,
            select: {
                id: true, seq: true, kind: true, status: true, toolCalled: true,
                inputJson: true, outputJson: true, guardVerdict: true,
                guardRuleIds: true, costTokens: true, at: true, actorUserId: true,
            },
        });

        // Proposals for THIS page's steps only, so a long run does not fetch
        // every proposal it ever queued to render a window of twelve.
        const page = steps.slice(0, take);
        const proposals = page.length
            ? await db.agentProposal.findMany({
                  where: {
                      runId,
                      tenantId: ctx.tenantId,
                      stepSeq: { gte: page[0].seq, lte: page[page.length - 1].seq },
                  },
                  orderBy: { stepSeq: 'asc' },
                  select: {
                      id: true, kind: true, status: true,
                      guardVerdict: true, stepSeq: true,
                  },
              })
            : [];
        return { run, page, hasMore: steps.length > take, proposals };
    });

    if (!result) throw notFound('Workflow run not found');
    const { run, page, hasMore, proposals } = result;
    const def = getWorkflowDefinition(run.workflowKey);
    return {
        runId: run.id,
        status: run.status,
        stepCount: run.stepCount,
        live: isLiveRunStatus(run.status),
        cursor: page.length ? page[page.length - 1].seq : sinceSeq,
        hasMore,
        steps: projectRunSteps(def?.steps, page, proposals),
    };
}
