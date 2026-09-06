/**
 * Agent-run reaper — one wedged run must not look like a live one, and one
 * wedged AGENT must not stop the sweep reaching the others (OWASP ASI08).
 *
 * ## What is actually wedged
 *
 * `executeFrom` runs a workflow's steps SYNCHRONOUSLY inside the request or job
 * that started it, and it enforces `ENGINE_CAPS.WALL_CLOCK_MS` itself — at
 * every step, before the step runs. So a `RUNNING` row older than that cap
 * cannot be a run that is merely slow: either the executor would have failed it
 * at its next step, or there is no executor any more. A pod evicted mid-run, a
 * worker OOM-killed, a deploy that rolled the container — each leaves a row
 * that says `RUNNING` and never moves again.
 *
 * That is worse than an untidy row. Nothing else settles it, so:
 *   - `/agent-runs` shows the agent as working when it is not;
 *   - the per-run action budget the policy card reserved against it is never
 *     released, so the agent's ceiling is quietly lower than the card says;
 *   - an operator asking "did anything happen?" gets the same page whether the
 *     run is in flight or the worker died an hour ago — the ambiguity this repo
 *     has been bitten by before.
 *
 * ## Why it enumerates with `drainPages` and not `take: N`
 *
 * A cap would sweep a PREFIX and report a clean pass. At the cap the two facts
 * — "500 wedged runs" and "at least 500 wedged runs, the rest untouched" — are
 * indistinguishable in the completion log, and the tail is other tenants'
 * agents, which is never acceptable to drop silently. `drainPages` walks the
 * whole set by cursor; the id-only select keeps a full walk cheap.
 *
 * ## Two nested fan-outs, both isolated, both counted
 *
 * The outer fan-out is over AGENTS, the inner over that agent's wedged runs.
 * One agent whose rows are broken must not stop the agents behind it in the
 * list, and one un-reapable run must not stop its siblings — that propagation
 * is the cascade. Both use `isolateEach`, so every caught failure is recorded,
 * counted, and returned: `agentsFailed` / `runsFailed` sit in the job result
 * beside `runsReaped`, and a sweep that isolated something cannot be read as a
 * clean one.
 *
 * A FATAL failure is different and stops the sweep — see `isAgenticFatal`. The
 * outcome then carries `halted` plus the count of agents never attempted, so a
 * halt is announced rather than trimmed.
 *
 * ## What it does NOT touch
 *
 * `AWAITING_APPROVAL` and `PAUSED` runs are left alone however old they are:
 * those are runs waiting for a human, and a checkpoint can legitimately sit for
 * weeks. Reaping them would destroy work a person was about to approve.
 */
import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { withTenantDb } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import {
    recordAgenticFanOutHalt,
    recordAgenticMemberFailure,
} from '@/lib/observability/metrics';
import { isolateEach, type IsolatedFailure } from '@/lib/agentic/failure-isolation';
import { ENGINE_CAPS } from '@/lib/agentic/workflow-types';
import { logEvent } from '../events/audit';
import { buildSystemContext } from '../context-system';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import type { JobRunResult } from './types';

/** Names both metric series and every log line this job writes. */
const COMPONENT = 'agent-run-reaper';

/**
 * Slack beyond `WALL_CLOCK_MS` before a `RUNNING` row is called wedged.
 *
 * The cap is checked BEFORE each step, so a run can legitimately be a little
 * past it while its final step finishes. Ten minutes is far longer than any
 * single MCP tool call and far shorter than the hour a wedged row would
 * otherwise sit there.
 */
export const REAP_GRACE_MS = 10 * 60 * 1000;

/** Written to `WorkflowRun.errorMessage`. Fixed text — never carries content. */
export const REAP_REASON =
    'reaped: RUNNING past the engine wall-clock cap with no live executor';

/** A wedged run, as the enumeration selects it. Ids and a timestamp, no content. */
interface StalledRun {
    id: string;
    tenantId: string;
    agentId: string | null;
    startedAt: Date;
}

export interface AgentRunReaperOutcome {
    /** Agent groups the sweep reached. Less than `agentsFound` after a halt. */
    agentsScanned: number;
    /** Agent groups the enumeration produced. */
    agentsFound: number;
    /** Wedged runs the enumeration produced, across every agent. */
    runsFound: number;
    /** Runs settled to FAILED by this sweep. */
    runsReaped: number;
    /** Agents whose whole group threw. The sweep continued past each. */
    agentsFailed: number;
    /** Individual runs that threw. Their siblings were still reaped. */
    runsFailed: number;
    /** Agent groups never attempted because a fatal stopped the sweep. */
    agentsUnattempted: number;
    /** The fatal that stopped the sweep, or null. */
    halted: IsolatedFailure | null;
}

/**
 * Reap wedged agent runs.
 *
 * `tenantId` narrows the sweep to one tenant (an operator re-run after an
 * incident); absent, it is the cross-tenant scheduled pass. `now` is injectable
 * so a test can place the cutoff without sleeping.
 */
export async function runAgentRunReaperJob(options?: {
    tenantId?: string;
    now?: Date;
    /**
     * Rows per round-trip. Bounds MEMORY per query, never the result set —
     * `drainPages` keeps walking until a page comes back short. Overridable so
     * a test can force the walk across a page boundary with a handful of rows,
     * which is the exact behaviour a `take:` cap would get wrong.
     */
    pageSize?: number;
}): Promise<{ result: JobRunResult; outcome: AgentRunReaperOutcome }> {
    return runJob(COMPONENT, async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const now = options?.now ?? new Date();
        const cutoff = new Date(now.getTime() - ENGINE_CAPS.WALL_CLOCK_MS - REAP_GRACE_MS);
        const tenantId = options?.tenantId;
        const pageSize = options?.pageSize ?? DRAIN_PAGE_SIZE;

        // THE WHOLE SET, by cursor. A `take:` here would sweep a prefix and
        // report it as a finished pass — see the header.
        const stalled = await drainPages<StalledRun>((cursor) =>
            prisma.workflowRun.findMany({
                where: {
                    status: 'RUNNING',
                    startedAt: { lt: cutoff },
                    ...(tenantId ? { tenantId } : {}),
                },
                select: { id: true, tenantId: true, agentId: true, startedAt: true },
                orderBy: { id: 'asc' },
                take: pageSize,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
            pageSize,
        );

        const groups = groupByAgent(stalled);
        let runsReaped = 0;
        let runsFailed = 0;

        // OUTER fan-out — one member per agent. A group that throws is isolated
        // so the agents behind it are still swept.
        const outcome = await isolateEach(
            groups,
            (group) => group.key,
            async (group) => {
                // INNER fan-out — one member per wedged run of this agent.
                const inner = await isolateEach(
                    group.runs,
                    (run) => run.id,
                    (run) => reapOneRun(run, now),
                    (failure) => {
                        recordAgenticMemberFailure({ component: COMPONENT, kind: failure.kind });
                        // The component is spelled out rather than passed as
                        // `COMPONENT`: `local/no-raw-prompt-logging` judges the
                        // names it can see in the source, and an identifier at a
                        // value position is a hole in its census. `COMPONENT`
                        // still names the metric series and the job.
                        logger.error('agent-run reaper: run failed, siblings continue', {
                            component: 'agent-run-reaper',
                            tenantId: group.tenantId,
                            runId: failure.key,
                            failureKind: failure.kind,
                            failureDigest: failure.digest,
                        });
                    },
                );
                runsReaped += inner.results.filter(Boolean).length;
                runsFailed += inner.failed;
                // A FATAL inside one agent's runs must not be swallowed into
                // that agent's result — rethrowing lets the outer fan-out see
                // it as fatal too and stop the whole sweep, which is what a
                // fatal means.
                if (inner.halted) {
                    throw new FatalGroupError(inner.halted);
                }
                return inner.succeeded;
            },
            (failure) => {
                if (failure.fatal) {
                    recordAgenticFanOutHalt({ component: COMPONENT, kind: failure.kind });
                    logger.error('agent-run reaper: HALTED, remaining agents unattempted', {
                        component: 'agent-run-reaper',
                        agentKey: failure.key,
                        failureKind: failure.kind,
                        failureDigest: failure.digest,
                    });
                    return;
                }
                recordAgenticMemberFailure({ component: COMPONENT, kind: failure.kind });
                logger.error('agent-run reaper: agent failed, other agents continue', {
                    component: 'agent-run-reaper',
                    agentKey: failure.key,
                    failureKind: failure.kind,
                    failureDigest: failure.digest,
                });
            },
        );

        const summary: AgentRunReaperOutcome = {
            agentsScanned: outcome.attempted,
            agentsFound: groups.length,
            runsFound: stalled.length,
            runsReaped,
            agentsFailed: outcome.failed,
            runsFailed,
            agentsUnattempted: outcome.unattempted,
            halted: outcome.halted,
        };

        logger.info('agent-run reaper complete', {
            component: 'agent-run-reaper',
            agentsFound: summary.agentsFound,
            agentsScanned: summary.agentsScanned,
            runsFound: summary.runsFound,
            runsReaped: summary.runsReaped,
            agentsFailed: summary.agentsFailed,
            runsFailed: summary.runsFailed,
            agentsUnattempted: summary.agentsUnattempted,
        });

        // SUCCESS IS NOT "IT RETURNED". A sweep that isolated every member it
        // touched did no work and must not report a clean pass — the same rule
        // `fanOut` applies to a dispatcher where nothing was dispatched. A halt
        // is a failure for the same reason: members went unattempted.
        const everyMemberFailed = outcome.attempted > 0 && outcome.succeeded === 0;
        const success = outcome.halted === null && !everyMemberFailed;

        const result: JobRunResult = {
            jobName: COMPONENT,
            jobRunId: randomUUID(),
            success,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: stalled.length,
            itemsActioned: runsReaped,
            itemsSkipped: runsFailed,
            ...(success
                ? {}
                : {
                      errorMessage: outcome.halted
                          ? `halted on ${outcome.halted.kind}; ${outcome.unattempted} agent(s) unattempted`
                          : `every one of ${outcome.attempted} agent(s) failed`,
                  }),
            details: {
                agentsFound: summary.agentsFound,
                agentsScanned: summary.agentsScanned,
                runsFound: summary.runsFound,
                runsReaped: summary.runsReaped,
                agentsFailed: summary.agentsFailed,
                runsFailed: summary.runsFailed,
                agentsUnattempted: summary.agentsUnattempted,
            },
        };
        return { result, outcome: summary };
    });
}

/**
 * Carries an inner fan-out's fatal up to the outer one.
 *
 * It re-exposes the brand (`agenticFatal`) and the original `kind` so the outer
 * `isolateEach` classifies it as fatal too and reports the same code. Wrapping
 * rather than rethrowing the original keeps the group's key out of the message.
 */
class FatalGroupError extends Error {
    readonly agenticFatal = true as const;
    readonly code: string;
    constructor(inner: IsolatedFailure) {
        super(`agent group halted: ${inner.kind}`);
        this.name = 'FatalGroupError';
        this.code = inner.kind;
    }
}

/** One agent's wedged runs. `agentId` is null for pre-register runs. */
interface AgentGroup {
    key: string;
    tenantId: string;
    agentId: string | null;
    runs: StalledRun[];
}

/**
 * Group the wedged runs by (tenant, agent).
 *
 * The key includes the tenant because `agentId` is only unique within one, and
 * a sweep that merged two tenants' agents under one key would let one tenant's
 * failure isolate away another tenant's work.
 */
export function groupByAgent(runs: readonly StalledRun[]): AgentGroup[] {
    const byKey = new Map<string, AgentGroup>();
    for (const run of runs) {
        const key = `${run.tenantId}::${run.agentId ?? 'unregistered'}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.runs.push(run);
        } else {
            byKey.set(key, { key, tenantId: run.tenantId, agentId: run.agentId, runs: [run] });
        }
    }
    return [...byKey.values()];
}

/**
 * Settle one wedged run to FAILED.
 *
 * The update is CONDITIONAL on the row still being `RUNNING`, so a run that
 * came back to life between the enumeration and here is left alone — the
 * `count === 0` answer is a legitimate no-op, not a failure. Returning the
 * boolean rather than throwing keeps that distinction in the counts: a run the
 * sweep chose not to touch is not a run the sweep failed on.
 */
async function reapOneRun(run: StalledRun, now: Date): Promise<boolean> {
    const ctx = buildSystemContext({ tenantId: run.tenantId, job: COMPONENT, discriminator: run.id });
    return withTenantDb(run.tenantId, async (db) => {
        const claimed = await db.workflowRun.updateMany({
            where: { id: run.id, tenantId: run.tenantId, status: 'RUNNING' },
            data: { status: 'FAILED', completedAt: now, errorMessage: REAP_REASON },
        });
        if (claimed.count === 0) return false;

        await logEvent(db, ctx, {
            action: 'WORKFLOW_RUN_REAPED',
            entityType: 'WorkflowRun',
            entityId: run.id,
            // Ids, a code and an age. No step, no tool name, no context — this
            // row is plaintext and permanent.
            detailsJson: {
                category: 'access',
                agentId: run.agentId,
                reasonCode: 'WALL_CLOCK_NO_EXECUTOR',
                // The timestamp, not a computed age: the age is derivable from
                // it and the row's own `at`, and an inline subtraction is two
                // calls `local/no-raw-prompt-logging` cannot open — a hole in
                // its census bought for nothing.
                stalledSince: run.startedAt,
            },
        });
        return true;
    });
}
