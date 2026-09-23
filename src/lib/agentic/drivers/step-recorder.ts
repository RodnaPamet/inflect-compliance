import type { WorkflowStepKind } from '@prisma/client';

import type { RequestContext } from '@/app-layer/types';
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';
// The SAME specifier the static driver used before the move, not the
// `@/lib/db-context` re-export. Three unit suites partially mock
// `@/lib/db/rls-middleware` as `{ runInTenantContext }`; importing the same
// function through a different module makes the mock miss, and the recorder
// then reaches real Prisma — which is how "the label reaches the step record"
// started failing on a change that moved no logic at all.
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { appendAuditEntry } from '@/lib/audit';
import type { ContentProvenance } from '@/lib/agentic/content-provenance';

/**
 * THE ONE PLACE A `WorkflowStep` IS WRITTEN.
 *
 * ── WHY IT MOVED OUT OF THE STATIC DRIVER ───────────────────────────────────
 *
 * It was private to `static-driver.ts` while one driver existed, and that was
 * right: there was exactly one `db.workflowStep.create` in the repo. A second
 * driver changes the arithmetic, not the principle — the step ledger is the
 * run's system of record, so "how many places write it" should stay one
 * whether there are two engines or five.
 *
 * The alternative is a second `create` in the Flue driver, and the cost of
 * that is not duplication: it is that the audit row beside the insert would be
 * written twice, differently. `recordStep` does two things — the row and its
 * hash-chained `WORKFLOW_STEP` entry — and a driver that copied only the first
 * would leave steps that happened with no durable record that they did.
 * `tests/guards/workflow-step-single-write-seam.test.ts` pins it.
 *
 * ── THE KIND IS THE FULL ENUM NOW, AND THAT IS NOT A WIDENING OF AUTHORITY ──
 *
 * The parameter was `'READ' | 'PROPOSE' | 'HUMAN_CHECKPOINT' | 'SYNTHESIS'` —
 * the four shapes a DEFINITION can declare, which is all the static driver can
 * meet. `MODEL_CALL` and `TOOL_CALL` are the other two `WorkflowStepKind`
 * values: kinds a driver RECORDS about what it DID, which no hand-written step
 * array can ask for.
 *
 * Accepting the full enum here does not let the static driver record them —
 * it passes literals, and `tests/unit/workflow-step-kind-coverage.test.ts`
 * asserts it claims no capability for those two. It lets the driver that
 * genuinely makes model and tool calls record what it made, which is the whole
 * reason those enum values exist and have had no writer since the migration
 * that added them.
 */
export interface StepRecord {
    toolCalled?: string;
    input?: unknown;
    output?: unknown;
    status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
    label: string;
    actorUserId?: string;
    /**
     * What the step's output is made of. Set on the steps that CALL A TOOL;
     * absent on a checkpoint or a synthesis, which read no external content.
     *
     * A label and nothing else — one of three enum values. It carries no
     * excerpt, no field name and no length, so it is safe in the plaintext,
     * hash-chained, never-deleted audit row where this puts it.
     */
    provenance?: ContentProvenance;
    /**
     * What the guard said about this step, when a guard ran.
     *
     * ABSENT means no guard ran, which is NOT the same as `CLEAN`. A
     * checkpoint or a synthesis reaches no tenant content and is never
     * scanned; only a tool call is. Recording `CLEAN` for an unscanned step
     * would tell a reviewer the guard looked and was satisfied, on a step it
     * never examined.
     */
    guardVerdict?: AgentGuardVerdict;
    /** Stable rule ids that fired. Safe to persist — they carry no content. */
    guardRuleIds?: readonly string[];
    /**
     * Tokens this step spent, when the step is a model call and the runtime
     * reported usage.
     *
     * Recorded in the AUDIT ROW only — `WorkflowStep` has no token column, and
     * adding one is a schema change this does not make. `WorkflowRun.costTokens`
     * remains the enforced total; this is the per-step breakdown an incident
     * review wants and the cap does not read.
     */
    tokens?: number;
}

export async function recordStep(
    ctx: RequestContext,
    runId: string,
    seq: number,
    kind: WorkflowStepKind,
    rec: StepRecord,
    contextSeq?: number,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.workflowStep.create({
            data: {
                runId, tenantId: ctx.tenantId, seq, kind,
                contextSeq: contextSeq ?? null,
                toolCalled: rec.toolCalled ?? null,
                inputJson: rec.input !== undefined ? JSON.stringify(rec.input) : null,
                outputJson: rec.output !== undefined ? JSON.stringify(rec.output) : null,
                status: rec.status,
                actorUserId: rec.actorUserId ?? null,
                // ── PER-STEP EVIDENCE ───────────────────────────────────────
                //
                // `undefined` rather than `null` for the verdict: absent means
                // no guard ran, and Prisma leaves the column NULL either way,
                // but writing `?? null` here would read as "we decided it was
                // nothing" rather than "nothing scanned this".
                guardVerdict: rec.guardVerdict,
                // The array column's empty state already says "no rules
                // fired", so there is no nullable third state to carry.
                guardRuleIds: rec.guardRuleIds ? [...rec.guardRuleIds] : [],
                // The per-step breakdown. `WorkflowRun.costTokens` stays the
                // enforced total and the cap still reads it — this is the
                // detail an incident review wants and a run total cannot give.
                costTokens: rec.tokens,
            },
        }),
    );
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowStep',
        entityId: `${runId}:${seq}`,
        action: 'WORKFLOW_STEP',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            kind,
            label: rec.label,
            tool: rec.toolCalled ?? null,
            status: rec.status,
            // WHAT THIS STEP READ, not just which tool it called. The two are
            // not the same question: `get_compliance_posture` returns platform
            // arithmetic, every other read tool returns tenant free text, and a
            // run that only ever touched the first has no injection surface at
            // all. Recorded here because the audit trail is the durable record
            // of what a run did. (`WorkflowStep` still has no PROVENANCE
            // column — the guard verdict and the token count below now have
            // theirs, and this one deliberately did not get one with them:
            // provenance is a property of the CONTENT a step read, which the
            // proposal row already carries where it is reviewable.)
            //
            // `null` on the steps that call no tool. That is "not applicable",
            // and it is distinguishable from the untrusted label because the
            // untrusted label is spelled out.
            provenance: rec.provenance ?? null,
            // …and what it SPENT, on the kinds that spend. `null` rather than
            // 0 where the question does not apply: a read step that cost
            // nothing and a model call whose usage the runtime did not report
            // are different facts, and zero would merge them.
            tokens: rec.tokens ?? null,
            // …and WHAT THE GUARD SAID, in the trail as well as the column.
            //
            // Both, not either. The column is queryable and can be corrected
            // by a later migration; the audit row is hash-chained and cannot.
            // An assessor asking "was this step scanned, and what did it find"
            // is asking a question the immutable half should answer.
            //
            // `null` means no guard ran — distinct from `CLEAN`, which means
            // it ran and found nothing.
            guardVerdict: rec.guardVerdict ?? null,
            guardRuleIds: rec.guardRuleIds ? [...rec.guardRuleIds] : [],
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, runId },
    }).catch(() => undefined);
}
