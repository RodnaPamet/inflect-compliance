import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { appendAuditEntry } from '@/lib/audit';
import type { RunCapHalt } from '@/lib/agentic/run-caps';
import { recordAgentRunCapHalt } from '@/lib/observability/metrics';

/**
 * HOW A RUN ROW IS SETTLED — shared by every driver.
 *
 * Extracted from `static-driver.ts` for the same reason `recordStep` was: a
 * second engine is coming, and "how a run reaches a terminal state" is not a
 * property of one engine. A driver that settled runs its own way would not
 * merely duplicate this — it would decide, separately, whether a stopped run
 * gets a `WORKFLOW_RUN_FAILED` audit row, and the two answers would drift.
 *
 * The import specifier is `@/lib/db/rls-middleware` rather than the
 * `@/lib/db-context` re-export, deliberately: several unit suites partially
 * mock that module as `{ runInTenantContext }`, and reaching the same function
 * through a different module makes those mocks miss. That cost a green suite
 * once already, on a change that moved no logic.
 */
export async function updateRun(
    ctx: RequestContext,
    runId: string,
    data: Record<string, unknown>,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.workflowRun.update({ where: { id: runId }, data: data as never }),
    );
}

/**
 * Settle a run FAILED with a message an operator reads.
 *
 * The audit row is `.catch`-swallowed on purpose and the run update is not:
 * the row is the thing that stops the run, and an audit backend having a bad
 * minute must not leave a run RUNNING forever. The reverse — updating the
 * trail but not the row — is the state that cannot be recovered from.
 */
export async function failRun(
    ctx: RequestContext,
    runId: string,
    message: string,
): Promise<string> {
    await updateRun(ctx, runId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: message,
    });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        action: 'WORKFLOW_RUN_FAILED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', reason: message },
    }).catch(() => undefined);
    return 'FAILED';
}

/**
 * Mark a run HALTED AT A CAP, and record WHICH cap and how much work is left.
 *
 * Separate from `failRun` on purpose, and the separation is the requirement
 * rather than tidiness. `failRun` says a step went wrong; this says nothing
 * went wrong at all — the run was working exactly as designed and was stopped
 * because it reached a ceiling somebody set. Those are different operator
 * actions (debug the workflow vs. decide whether the ceiling is right), and an
 * `errorMessage` that reads like a tool error sends people to the first one.
 *
 * `stepsNotRun` is the part that makes this a halt rather than a trim. Without
 * it a halted run is indistinguishable from a completed one to anything reading
 * the row: same `FAILED` status a broken step leaves, same absent tail. With
 * it, the remaining work is a recorded number in a hash-chained row that is
 * never deleted — visibly not-done rather than quietly gone.
 *
 * The run stays `FAILED` rather than gaining a `HALTED` status of its own.
 * Adding an enum value is safe to WRITE under a rolling deploy and unsafe to
 * READ: a container still running the old build would fail to deserialise a
 * status its client does not know, taking the whole run list down for the
 * duration of the rollout. The cap is carried by the audit action, the details
 * and the message instead — all three of which an old build reads as strings.
 */
export async function haltRunAtCap(
    ctx: RequestContext,
    runId: string,
    halt: RunCapHalt,
    stepsNotRun: number,
): Promise<string> {
    await updateRun(ctx, runId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: halt.message,
    });
    recordAgentRunCapHalt({ cap: halt.kind, source: halt.source });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        // A distinct action, not a `WORKFLOW_RUN_FAILED` with a special
        // message. An operator filtering the trail for cap halts must not have
        // to grep prose to find them.
        action: 'WORKFLOW_RUN_CAP_HALTED',
        requestId: ctx.requestId,
        // Every field named at the sink, none spread. All six are structural
        // facts about the ceiling — a cap kind, two integers, a source, and how
        // much work stopped. None of them is content, and none of them can
        // become content when the halt type grows a field.
        detailsJson: {
            category: 'access',
            cap: halt.kind,
            capSource: halt.source,
            limit: halt.limit,
            used: halt.used,
            refused: halt.refused,
            stepsNotRun,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);
    return 'FAILED';
}
