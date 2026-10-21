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
import { runInTenantContext } from '@/lib/db-context';

import type { RequestContext } from '../types';

/** How long a host consumer's call waits for its run. See the header. */
export const A2A_HOST_SYNCHRONOUS_WAIT_MS = 10_000;

/** How often the run's status is re-read inside that window. */
export const A2A_HOST_WAIT_POLL_MS = 400;

/**
 * A run that will not change without something outside this request happening.
 *
 * Derived from `WorkflowRunStatus`, which is `RUNNING | AWAITING_APPROVAL |
 * PAUSED | COMPLETED | ABORTED | FAILED`. The three terminal ones settle.
 */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'ABORTED']);

/**
 * A run that has stopped waiting on US and started waiting on a PERSON.
 *
 * Told apart from terminal deliberately. Continuing to poll for ten seconds
 * because a human might approve inside them is futile, and it spends the whole
 * budget to learn nothing — so the wait returns at once and the caller's text
 * part explains who must act. This is the behaviour that replaces mapping the
 * state to `input-required`, which would have named the wrong actor (owner
 * decision on #3863).
 */
const PARKED_ON_A_PERSON = new Set(['AWAITING_APPROVAL', 'PAUSED']);

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
        if (TERMINAL.has(status)) return { status, settled: true, parked: false };
        if (PARKED_ON_A_PERSON.has(status)) return { status, settled: false, parked: true };
        // CHECKED AFTER THE READ, not before: a run that settles during the
        // last sleep is still reported as settled, and the loop always makes at
        // least one read even with a zero budget — so a caller passing 0 gets
        // the current status rather than an invented default.
        if (now() >= deadline) return { status, settled: false, parked: false };
        await sleep(Math.min(poll, Math.max(0, deadline - now())));
    }
}
