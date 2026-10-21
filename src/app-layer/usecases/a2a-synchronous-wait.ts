/**
 * THE BOUNDED WAIT a host consumer's `message/send` performs (#3863).
 *
 * Inflect's runs are asynchronous jobs; Joule reads its answer out of the call's
 * own result and does not come back for it. This bridges the two by waiting —
 * briefly, and for host consumers only.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BOUND, AND THE ASSUMPTION IT RESTS ON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The issue asked for Joule's request timeout from SAP's toolkit, or for the
 * assumption to be documented. **It is not in the toolkit**, so this is the
 * assumption, with the evidence that shaped it. Searched
 * `SAP-samples/joule-a2a-agent-toolkit` for every mention of a timeout:
 *
 *   references/langgraph-a2a-agent.md:129,411   `timeout=30`
 *   scripts/scaffold.py:137                     `timeout=30`
 *   skills/joule-cli/SKILL.md:195               15 minutes — but that is DEPLOY
 *   skills/cf-cli/SKILL.md:208                  `timeout: 120` — CF app startup
 *
 * The `timeout=30` figures are the agent's OWN outbound HTTP calls in SAP's
 * scaffold, not Joule's timeout when it calls us. They are nonetheless the only
 * request-scale number SAP's own code uses, so thirty seconds is taken as the
 * order of magnitude.
 *
 * Ten seconds therefore, which sits well inside it. The headroom is the point
 * rather than caution for its own sake: a wait that runs close to the caller's
 * limit turns a would-be `working` response into a TIMEOUT at the caller, which
 * is strictly worse — Joule then has no task id to follow up with, where
 * `working` hands it one. Overshooting loses information; undershooting only
 * costs a follow-up turn.
 *
 * A source constant, so changing it is a reviewed diff, and one place to change
 * if SAP ever publishes the real figure.
 */
import type { WorkflowRunStatus } from '@prisma/client';
import { runInTenantContext } from '@/lib/db-context';

import type { RequestContext } from '../types';

/** How long a host consumer's call waits for its run. See the header. */
export const A2A_HOST_SYNCHRONOUS_WAIT_MS = 10_000;

/** How often the run's status is re-read inside that window. */
export const A2A_HOST_WAIT_POLL_MS = 400;

/**
 * WHAT A RUN'S STATUS MEANS TO A CALLER WAITING ON IT — for every status there
 * is, in ONE exhaustive table rather than two allowlists.
 *
 * ── WHY THE SHAPE CHANGED (#3869) ───────────────────────────────────────────
 *
 * This was `TERMINAL = new Set(['COMPLETED', 'FAILED', 'ABORTED'])` beside a
 * `PARKED_ON_A_PERSON` set, under a docstring that ENUMERATED the enum. Adding
 * a status to `WorkflowRunStatus` falsified that docstring and, worse, the two
 * sets failed in OPPOSITE directions:
 *
 *   `run-concurrency.ts` allowlists the LIVE statuses, so a new TERMINAL one
 *   falls outside it and is handled correctly by construction. Safe.
 *
 *   this file allowlisted the TERMINAL ones, so a new terminal status was
 *   simply absent — `awaitRunSettled` would poll the entire ten-second window
 *   and return `settled: false` for a run that had already finished, and the
 *   host consumer would be told `working` about something that was over.
 *
 * `Record<WorkflowRunStatus, …>` makes that unrepresentable: a value added to
 * the enum without a disposition here is a COMPILE error — mutation-proved by
 * deleting the `EMPTY_CATALOGUE` line, which yields TS2741 rather than a silent
 * pass. It is the property `SIGNAL_STRENGTH` holds for reconcile signals, for
 * the same reason: a classification that CAN be forgotten eventually is.
 *
 * `EMPTY_CATALOGUE` is what found this. The fix is not specific to it.
 */
type RunDisposition =
    /** Will not change without something outside this request happening. */
    | 'TERMINAL'
    /** Has stopped waiting on US and started waiting on a PERSON. */
    | 'PARKED_ON_A_PERSON'
    /** Still ours to wait for. */
    | 'IN_FLIGHT';

const DISPOSITION: Readonly<Record<WorkflowRunStatus, RunDisposition>> = {
    RUNNING: 'IN_FLIGHT',
    // PARKED is told apart from TERMINAL deliberately. Continuing to poll for
    // ten seconds because a human might approve inside them is futile, and it
    // spends the whole budget to learn nothing — so the wait returns at once
    // and the caller's text part explains who must act. This is the behaviour
    // that replaces mapping the state to `input-required`, which would have
    // named the wrong actor (owner decision on #3863).
    AWAITING_APPROVAL: 'PARKED_ON_A_PERSON',
    PAUSED: 'PARKED_ON_A_PERSON',
    COMPLETED: 'TERMINAL',
    ABORTED: 'TERMINAL',
    FAILED: 'TERMINAL',
    // A run that reached no tools is OVER, and is not a success. Terminal for
    // the same reason FAILED is: there is nothing further to wait for, and what
    // the caller should get is the refusal rather than ten seconds of silence
    // followed by one.
    EMPTY_CATALOGUE: 'TERMINAL',
};

/**
 * The disposition of whatever status was read off the row.
 *
 * AN UNRECOGNISED STATUS IS IN-FLIGHT, never terminal, and the direction is the
 * decision: calling a status we do not know "settled" sends the caller on to
 * read an answer that may not exist, while calling it in-flight costs one wait
 * window and reports honestly. Note this is defensive only — in a rolling
 * deploy an unknown value never arrives here as a string, because Prisma fails
 * the whole read of a row carrying an enum value its client lacks. That is why
 * the status is added one deploy before anything writes it.
 */
function dispositionOf(status: string): RunDisposition {
    return DISPOSITION[status as WorkflowRunStatus] ?? 'IN_FLIGHT';
}

export type RunWaitOutcome = {
    /** The status as last read. */
    readonly status: string;
    /** Did it reach a terminal status inside the window? */
    readonly settled: boolean;
    /** Did it stop because a person now has to act, rather than on the clock? */
    readonly parked: boolean;
};

export interface RunWaitSeam {
    /** Injected so a test can drive the clock rather than spend it. */
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly budgetMs?: number;
    readonly pollMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for `runId` to settle, up to the bound.
 *
 * Reads the status UNCACHED each time, for the same reason admission re-reads a
 * consumer's status: a decision made from a value that went stale inside the
 * window would be a decision about the past.
 *
 * Returns the last status it saw whatever happens, so the caller never has to
 * distinguish "no answer" from "no reading".
 */
export async function awaitRunSettled(
    ctx: RequestContext,
    runId: string,
    seam: RunWaitSeam = {},
): Promise<RunWaitOutcome> {
    const now = seam.now ?? (() => Date.now());
    const sleep = seam.sleep ?? realSleep;
    const budget = seam.budgetMs ?? A2A_HOST_SYNCHRONOUS_WAIT_MS;
    const poll = seam.pollMs ?? A2A_HOST_WAIT_POLL_MS;

    const deadline = now() + budget;
    let status = 'RUNNING';
    // A BOUNDED POLL, not an N+1, and the marker sits on the loop opener below
    // because that is where the guard reads it from.
    //
    // An N+1 is one query per item in a collection, and its fix is to hoist the
    // read into one `findMany` with an `in:` filter. There is no collection
    // here: it is ONE row re-read over TIME, because the status is the one thing
    // that changes outside this request. Hoisting it would read once and then
    // wait on a snapshot, which is the bug rather than the fix.
    //
    // Bounded by arithmetic rather than by hope: budget / poll interval, so
    // 10_000 / 400 = at most 25 reads of a single row by primary key, and it
    // returns on the first terminal or parked status. A run that settles
    // immediately costs one read.
    for (;;) { // guardrail-allow: n+1 — one read per POLL of one row, bounded by budget/pollMs
        const row = await runInTenantContext(ctx, (db) =>
            db.workflowRun.findFirst({
                where: { id: runId, tenantId: ctx.tenantId },
                select: { status: true },
            }),
        );
        // A run that cannot be read is not a settled one. Reporting its last
        // known status rather than throwing keeps the response path intact.
        status = row?.status ?? status;
        const disposition = dispositionOf(status);
        if (disposition === 'TERMINAL') return { status, settled: true, parked: false };
        if (disposition === 'PARKED_ON_A_PERSON') return { status, settled: false, parked: true };
        // CHECKED AFTER THE READ, not before: a run that settles during the
        // last sleep is still reported as settled, and the loop always makes at
        // least one read even with a zero budget — so a caller passing 0 gets
        // the current status rather than an invented default.
        if (now() >= deadline) return { status, settled: false, parked: false };
        await sleep(Math.min(poll, Math.max(0, deadline - now())));
    }
}
