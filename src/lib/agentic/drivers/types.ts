/**
 * The contract a run driver satisfies.
 *
 * A driver decides HOW a run's steps are chosen and executed. It does not
 * decide what is permitted: the register, the policy card, the autonomy
 * ceiling, the kill switch and the credential gate all sit behind
 * `runReadTool`, and every driver reaches tools through it. That separation is
 * the whole reason this seam exists — an engine we did not write can plan, and
 * still cannot widen its own authority.
 */
import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

/** What a driver reports back about the segment it executed. */
export interface RunDriverOutcome {
    status: string;
    /** Steps this segment failed on and continued past. */
    stepFailures: number;
}

/**
 * Execute a run from `fromSeq` onwards.
 *
 * `runStartMs` is the RUN's own start, not this segment's — the wall-clock cap
 * spans resumes, and handing a resumed segment a fresh clock is the defect
 * `resumeWorkflowRun` already carries a comment about.
 */
export type RunDriver = (
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
) => Promise<RunDriverOutcome>;
