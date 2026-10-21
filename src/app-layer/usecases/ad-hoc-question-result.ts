/**
 * WHAT CAME BACK FROM A QUESTION A PERSON ASKED (#3869).
 *
 * The retrieval half of M2: the answer, the calls the model made in order with
 * what happened to each, the model that ran, the tokens it cost, and whether
 * the run was offered no tools at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO MAY READ IT (owner decision, 2026-10-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The requester reads their own; an inventory reader reads any. Existing
 * agent-run routes are gated on `['admin.view', 'admin.agent_registry_view']`,
 * which a READER or EDITOR does not hold — so under that precedent alone the
 * person who asked could not read their own answer, and the feature would be
 * admin-only.
 *
 * The requester predicate is narrowed STRUCTURALLY rather than trusting one
 * column:
 *
 *   startedByUserId = ctx.userId     the asker
 *   workflowKey     = 'ad-hoc-question'   this feature only
 *   parentExecutionId IS NULL        not started by an automation rule
 *
 * All three matter, and the third is the load-bearing one.
 * `WorkflowRun.startedByUserId` is documented as ATTRIBUTION, not authority:
 * on an automation-started run it holds the RULE'S OWNER, who never asked
 * anything. Matching on that column alone would let a rule owner read every
 * run their rules started as though they had asked the question. Requiring a
 * NULL parent execution restricts the match to runs a person started directly,
 * which is the only case where that column IS the asker.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REFUSAL REASONS ARE RETURNED AS CODES, NEVER AS THE EXCEPTION TEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A failed tool call records `outputJson.error` — the caught exception's
 * `message`. Returning that to a client is an information-disclosure decision
 * dressed as a formatting one: exception text carries internal module paths,
 * identifiers and occasionally whole query shapes.
 *
 * The funnel's own refusals are already a vocabulary: `forbidden()` is called
 * with `<code>: <prose>`, as in
 * `flue_requires_registered_agent: a Flue run must be started by…`. So the
 * CODE is taken and the prose is dropped. Anything not matching the code shape
 * yields `REFUSED` rather than being passed through — an unrecognised message
 * is exactly the one most likely to be an unplanned leak, so the default
 * discards rather than forwards.
 *
 * The raw text is not lost: it stays on the step row, where an operator with
 * the inventory key reads it through the run-detail surface.
 */
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { settledRunAnswerText } from './a2a-run-answer';
import { EMPTY_TOOLSET_MESSAGE } from '@/lib/agentic/flue/empty-toolset-message';
import type { RequestContext } from '../types';

/** The workflow this reader serves, and the only one its requester gate admits. */
export const AD_HOC_QUESTION_WORKFLOW_KEY = 'ad-hoc-question';

/** What happened to one call the model made. */
export interface AdHocToolCall {
    /** Order as executed. The feed is `seq asc`, never arrival order. */
    readonly seq: number;
    readonly tool: string | null;
    /** `DONE`, `FAILED`, `SKIPPED` — the step's own status. */
    readonly outcome: string;
    /**
     * The funnel's refusal CODE, or `REFUSED` when the message did not carry
     * one. Null for a call that succeeded. Never the exception prose.
     */
    readonly refusal: string | null;
    /** Present when the AI Guard blocked or flagged the call. */
    readonly guardVerdict: string | null;
}

export interface AdHocQuestionResult {
    readonly runId: string;
    readonly status: string;
    /** Null while the run is in flight, or when it settled without one. */
    readonly answer: string | null;
    /** The model that RAN, not the one the agent declares. */
    readonly model: string | null;
    readonly costTokens: number;
    /**
     * Was the run offered NO tools — a failure, not a success.
     *
     * Read two ways on purpose. `EMPTY_CATALOGUE` is the status deploy 2 of
     * #3869 writes; `EMPTY_TOOLSET_MESSAGE` on `errorMessage` is what the
     * condition has recorded all along and is what every run before that
     * deploy carries. Reading only the status would report `false` for every
     * historical run that actually had the problem.
     */
    readonly catalogueWasEmpty: boolean;
    readonly toolCalls: readonly AdHocToolCall[];
}

/** `<code>: prose` is the funnel's refusal shape; anything else is not a code. */
const REFUSAL_CODE = /^([a-z][a-z0-9_]*)\s*:/;

function refusalCodeOf(outputJson: string | null): string | null {
    if (!outputJson) return null;
    let error: unknown;
    try {
        error = (JSON.parse(outputJson) as { error?: unknown }).error;
    } catch {
        // Unparseable output is not evidence of a refusal, and guessing from
        // the raw bytes is how the prose gets forwarded after all.
        return 'REFUSED';
    }
    if (typeof error !== 'string' || error === '') return null;
    const m = REFUSAL_CODE.exec(error);
    // DISCARD, never forward. An unrecognised message is the one most likely
    // to be an unplanned leak.
    return m ? m[1] : 'REFUSED';
}

export async function readAdHocQuestionResult(
    ctx: RequestContext,
    runId: string,
): Promise<AdHocQuestionResult> {
    // Takes the PERMISSION SET, not the context: the predicate is about what
    // the caller holds, and handing it a context would let a future edit widen
    // it on something else about the caller.
    const inventoryReader = mayReadAgentInventory(ctx.appPermissions.admin);

    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({
            where: {
                id: runId,
                tenantId: ctx.tenantId,
                // The requester gate, in the WHERE rather than after the read:
                // a row this caller may not see is not fetched, so there is no
                // decrypted answer in memory to leak through a later edit.
                ...(inventoryReader
                    ? {}
                    : {
                          startedByUserId: ctx.userId,
                          workflowKey: AD_HOC_QUESTION_WORKFLOW_KEY,
                          parentExecutionId: null,
                      }),
            },
            select: {
                id: true,
                status: true,
                costTokens: true,
                errorMessage: true,
                workflowKey: true,
            },
        }),
    );

    if (!run) {
        // One shape for "no such run" and "not yours", deliberately: telling
        // them apart would let a caller enumerate which run ids exist.
        throw forbidden(
            'RUN_NOT_READABLE: no such question run, or it was not started by you. ' +
                'Reading another person\'s run needs the agent-inventory key.',
        );
    }

    const [answer, steps, decision] = await Promise.all([
        settledRunAnswerText(ctx, run.id),
        runInTenantContext(ctx, (db) =>
            db.workflowStep.findMany({
                where: { runId: run.id, tenantId: ctx.tenantId, kind: 'TOOL_CALL' },
                orderBy: { seq: 'asc' },
                select: { seq: true, toolCalled: true, status: true, outputJson: true, guardVerdict: true },
                // Bounded, like every repository read here. A run that somehow
                // made more calls than this is reported truncated rather than
                // held in one unbounded array.
                take: 200,
            }),
        ),
        // The model that RAN. `RegisteredAgent.modelRef` is what the agent
        // DECLARES, which is a different fact and the wrong one to report
        // about a past run.
        runInTenantContext(ctx, (db) =>
            db.aiDecisionLog.findFirst({
                where: { tenantId: ctx.tenantId, sessionRef: run.id },
                orderBy: { createdAt: 'desc' },
                select: { model: true },
            }),
        ),
    ]);

    return {
        runId: run.id,
        status: run.status,
        answer,
        model: decision?.model ?? null,
        costTokens: run.costTokens,
        catalogueWasEmpty: run.status === 'EMPTY_CATALOGUE' || run.errorMessage === EMPTY_TOOLSET_MESSAGE,
        toolCalls: steps.map((s) => ({
            seq: s.seq,
            tool: s.toolCalled,
            outcome: s.status,
            refusal: s.status === 'FAILED' ? refusalCodeOf(s.outputJson) : null,
            guardVerdict: s.guardVerdict ?? null,
        })),
    };
}
