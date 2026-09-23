/**
 * Execute an enqueued agent run — the worker half of the agentic engine.
 *
 * ── WHY THIS MODULE IS THIN ─────────────────────────────────────────────────
 *
 * Everything that decides anything lives in `executeQueuedWorkflowRun`: which
 * principal the run executes as, whether that principal may still act, where
 * to resume from, and which engine is permitted. This file is the adapter
 * between a BullMQ payload and that usecase, and keeping it that way is what
 * lets the decisions be tested without a queue.
 *
 * ── WHY IT DOES NOT THROW ON A REFUSED RUN ──────────────────────────────────
 *
 * A run that was already settled, or whose principal lost access, is not a job
 * that failed — it is a job that correctly declined to do anything. Throwing
 * would put it through the retry policy three times to reach the same answer,
 * and `removeOnFail` would then keep it as evidence of a problem that does not
 * exist. The usecase reports a `skipped` reason; this logs it and returns.
 *
 * A genuine infrastructure failure DOES throw, and should: that is the case
 * BullMQ's retry exists for, and the usecase resumes from the ledger rather
 * than restarting.
 */
import { executeQueuedWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { logger } from '@/lib/observability/logger';

import type { AgentRunExecutePayload } from './types';

export interface AgentRunExecuteResult {
    /** Set when the run was correctly declined; absent when it executed. */
    skipped?: string;
    /** The terminal status, when it executed. */
    status?: string;
    stepFailures?: number;
}

export async function runAgentRunExecute(
    payload: AgentRunExecutePayload,
): Promise<AgentRunExecuteResult> {
    const { tenantId, runId } = payload;
    const outcome = await executeQueuedWorkflowRun(tenantId, runId);

    if ('skipped' in outcome) {
        // INFO, not warn. Every one of these is a correct refusal — an
        // already-settled run, a missing definition, a revoked principal — and
        // a warn would train an operator to ignore the channel that also
        // carries the real ones.
        logger.info('agent-run-execute: nothing to do', {
            component: 'agentic',
            tenantId,
            runId,
            reason: outcome.skipped,
        });
        return { skipped: outcome.skipped };
    }

    logger.info('agent-run-execute: run settled', {
        component: 'agentic',
        tenantId,
        runId,
        status: outcome.status,
        stepFailures: outcome.stepFailures,
    });
    return { status: outcome.status, stepFailures: outcome.stepFailures };
}
