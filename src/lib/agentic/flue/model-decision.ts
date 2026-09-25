import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * THE ART 12 RECORD FOR A FLUE MODEL CALL — and the key Art 14 stamps it by.
 *
 * ── WHY THIS IS NOT IN `execute.ts` ─────────────────────────────────────────
 *
 * It was, and nothing about it needs the ESM half. `execute.ts` imports
 * `@flue/runtime` statically, so no CJS suite can load it — which meant the
 * only tests this recorder could ever have were SOURCE tests, and a source
 * test cannot answer the question that actually matters here: does the value
 * the writer puts in `sessionRef` match the value the stamper queries by. That
 * question needs both sides RUN, against a real row. Moving the function to a
 * module whose imports are all ordinary app-layer ones is what makes that
 * possible; it moves no logic and adds no indirection.
 *
 * ── WHAT IS DIGESTED, AND WHY THAT IS NOT THE FEEDBACK KEY ──────────────────
 *
 * `logAiDecision` hashes `sanitizedInput` and stores the digest, never the
 * content. The message dispatched to the agent is what that digest is taken
 * over, so `/agents/decisions?digest=` lands on the decisions taken over this
 * run's prompt.
 *
 * That digest is NOT how a human outcome reaches this row, and the audit that
 * asked for this paragraph found out the hard way. The three call sites of
 * `recordDecisionOutcomeForDigest` all pass `AgentProposal.guardInputDigest` —
 * a digest over `{ kind, payload, rationale }`, the PROPOSAL's content. This
 * row's digest is over the run PROMPT. Two `sha256:` strings of identical
 * shape, computed over different content, which never match: the stamp
 * reported `count: 0`, raised nothing, and every `agentic-run:*` row sat at
 * PENDING for ever while the loop looked closed.
 *
 * Forcing them together would have been worse than the gap. Approving a
 * proposal is a review of the proposal; it is not a review of the model call
 * that produced it, and writing one onto the other's record is a false entry
 * in a register whose whole value is that its entries are true.
 *
 * ── SO THE KEY IS THE RUN ───────────────────────────────────────────────────
 *
 * `sessionRef` is documented on the column as "the feedback join key" and is
 * NULL on this path. The run id goes in it, because the run is the thing a
 * human actually reviews: a guard-flagged run parks at AWAITING_APPROVAL and a
 * person resumes it or aborts it, and both of those are outcomes on everything
 * the run decided. `resumeWorkflowRun` / `abortWorkflowRun` stamp by that id.
 *
 * An identity, deliberately, and not a second digest. A digest join is only as
 * good as two independent computations agreeing for ever, which is precisely
 * what failed here; the run id is one value, written once and read once.
 *
 * A run with checkpoints writes one row per SEGMENT — each dispatch is its own
 * model call over its own message, so its own digest — and they share this key,
 * so one human decision stamps all of them. That is the intended reading: the
 * person resuming at step 7 is accepting what the run has done so far.
 *
 * ── WHAT IS NOT CLAIMED ─────────────────────────────────────────────────────
 *
 * `guardVerdict` is left NULL, deliberately, and that is the honest value: no
 * guard runs on model OUTPUT yet (the plan's 4a, still open). Writing the worst
 * verdict seen across the run's TOOL calls would put a verdict about other
 * content in a column that reads as a verdict about this one.
 *
 * Failure to record does NOT fail the run. The call happened; refusing to
 * settle a completed run because its record could not be written would lose the
 * work as well as the record. It is logged loudly instead — the same posture
 * `appendAuditEntry` takes at every other sink in this subsystem.
 */
export async function recordModelDecision(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    message: string,
    /**
     * The settled text for THIS row, already extracted by the caller.
     *
     * A plain summary rather than the reply object, deliberately: `execute.ts`
     * reads `reply.text` exactly once and hands the value down, so the single
     * read there is the whole supply of model output into this subsystem and
     * `flue-model-output-has-one-destination` can count it. Taking the reply
     * here would give the recorder its own read of the same text and turn one
     * supply into two, which is the shape that guard exists to refuse.
     *
     * NULL on every row but the last: a response settles when the model stops
     * calling tools, so the text belongs to that turn alone.
     */
    outputSummary: string | null,
    usage: { tokensIn: number; tokensOut: number },
    modelSpecifier: string,
    /**
     * This CALL's own wall clock, when the caller observed it per turn.
     *
     * Optional because the value exists only on the event stream: a `turn`
     * event carries the duration of one model call, and nothing on the
     * response aggregate does. `null` rather than a made-up number when the
     * caller could not observe one — a latency column that sometimes holds a
     * dispatch total and sometimes a call total would be worse than empty.
     */
    latencyMs: number | null = null,
): Promise<void> {
    // `<provider-id>/<model-id>` — split rather than stored whole, because the
    // row has a column for each and a reader filtering by provider should not
    // have to parse.
    const slash = modelSpecifier.indexOf('/');
    const provider = slash > 0 ? modelSpecifier.slice(0, slash) : modelSpecifier;
    const model = slash > 0 ? modelSpecifier.slice(slash + 1) : null;

    try {
        await runInTenantContext(ctx, async (db) => {
            await logAiDecision(db, ctx, {
                // Namespaced by the workflow, so a tenant running three
                // agentic workflows can tell their decisions apart without
                // joining back to the run.
                feature: `agentic-run:${def.key}`,
                provider,
                model,
                sanitizedInput: message,
                // THE ART 14 JOIN. See the docstring: the run is the reviewable
                // event, so the run id is what `recordDecisionOutcome` matches
                // when a human resumes or aborts.
                sessionRef: runId,
                // Bounded and sanitised by `logAiDecision` itself, into the
                // one column the encryption manifest carves out for exactly
                // this: "bounded, sanitised AI-output summary — never raw
                // content".
                outputSummary,
                latencyMs,
                tokensIn: usage.tokensIn || null,
                tokensOut: usage.tokensOut || null,
                // The registered agent's EU AI Act system. A Flue run is now
                // refused unless an ACTIVE `RegisteredAgent` vouches for it,
                // and that row carries a non-null `aiSystemId` — so this is
                // the link that makes the record findable from the system it
                // belongs to.
                aiSystemId: ctx.agentId ? await aiSystemIdFor(db, ctx) : null,
            });
        });
    } catch (err) {
        logger.error('flue-driver: could not record the Art 12 decision row', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            workflow: def.key,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * The registered agent's AI-system id — the Art 12 subject this run acts as.
 *
 * Exported for `tool-decision.ts`, which records the same subject for a call
 * served by somebody else's server. Two derivations of "which AI system is this"
 * would be two answers to a question an auditor asks once.
 */
export async function aiSystemIdFor(db: PrismaTx, ctx: RequestContext): Promise<string | null> {
    const agent = await db.registeredAgent.findFirst({
        where: { id: ctx.agentId, tenantId: ctx.tenantId },
        select: { aiSystemId: true },
    });
    return agent?.aiSystemId ?? null;
}
