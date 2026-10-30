/**
 * Turn a sandbox lifecycle decision into one hash-chained audit row — 5.1 (#3971).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THROUGH `logEvent`, NEVER `AuditLog` DIRECTLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #3971 states both halves: bridge the decisions "into the hash-chained
 * `AuditLog` through `logEvent`" and "never write `AuditLog` directly". So this
 * module calls `logEvent`, which routes to `appendAuditEntry` and the chain.
 * Writing the table directly would produce rows outside the hash chain, which
 * is the one thing that makes the log evidence rather than a list.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STRUCTURED, BECAUSE THE FREE TEXT IS DROPPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The audit stream drops free-text details, so carry the facts in structured
 * `detailsJson`." Every fact a reviewer would need — the sandbox id, the
 * refusal reason, the gateway's deletion outcome and whether it settled — goes
 * in `detailsJson` under `category: 'custom'`. The `details` string is a human
 * sentence and is treated as expendable: nothing here is recoverable from it
 * alone.
 *
 * The deletion outcome is carried VERBATIM rather than reduced to a boolean.
 * `DELETION_OUTCOME_ACCEPTED` means admitted, not performed, and
 * `DELETION_OUTCOME_UNSPECIFIED` is the proto3 zero with no assurance at all —
 * so a row saying "deleted" where the gateway only said "accepted" would claim
 * a confirmation nobody made. `settled` is the separate fact of whether we went
 * on to confirm it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXACTLY ONE ROW PER DECISION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The acceptance is "each bridged decision produces exactly one hash-chained
 * row". That is the executor's structure, not this module's care: creation sits
 * outside the try so a failed create cannot also emit a delete, the delete
 * emits from the single `finally`, and this function performs one `logEvent`
 * per call with no branch that writes twice or none. A test asserts the count
 * for each arm rather than trusting the reading.
 *
 * @module app-layer/integrations/openshell-audit-bridge
 */

import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import type { SandboxDecision } from '@/lib/agentic/openshell/sandbox-decisions';

/** The audit `entity` every sandbox decision is filed under. */
export const SANDBOX_AUDIT_ENTITY = 'OpenShellSandbox';

/**
 * Put on EVERY row, pointing at the list of decisions the vendor cannot show.
 *
 * Exported so the test asserts equality against this constant rather than
 * matching a literal inside the row — a text match on a value is both weaker
 * and lands in `assertion-needle-uniqueness`'s un-analysable census.
 */
export const VENDOR_LOG_COVERAGE_NOTE =
    'none — see UNOBSERVABLE_DECISIONS (#3932, 0.1g)';

/**
 * The audit `action` per decision kind.
 *
 * A `Record` over the union rather than a `switch`, so adding a decision kind
 * fails to COMPILE until it has an action. A `switch` with a `default` would
 * accept a new kind and file it under something plausible, which is how a
 * decision ends up recorded as the wrong act.
 */
export const SANDBOX_DECISION_ACTIONS: Record<SandboxDecision['kind'], string> = {
    'sandbox-created': 'OPENSHELL_SANDBOX_CREATED',
    'execution-refused': 'OPENSHELL_EXECUTION_REFUSED',
    'sandbox-deleted': 'OPENSHELL_SANDBOX_DELETED',
};

/** Human sentence per kind. Expendable — every fact also lives in `detailsJson`. */
function sentence(decision: SandboxDecision): string {
    switch (decision.kind) {
        case 'sandbox-created':
            return `OpenShell sandbox ${decision.sandboxId} created for a bounded tool execution`;
        case 'execution-refused':
            return `OpenShell execution refused before the tool ran (${decision.reason})`;
        case 'sandbox-deleted':
            return decision.settled
                ? `OpenShell sandbox ${decision.sandboxId} deletion settled (${decision.outcome})`
                : `OpenShell sandbox ${decision.sandboxId} deletion DID NOT settle (${decision.outcome}) — it may have leaked`;
    }
}

/** The machine-readable facts. `category: 'custom'` is the schema's open arm. */
function details(decision: SandboxDecision): Record<string, unknown> {
    const base = {
        category: 'custom' as const,
        decision: decision.kind,
        // Recorded on every row: a reviewer reading one row must not have to
        // know that the vendor logs nothing, and this is the pointer to the
        // list that says so.
        vendorLogCoverage: VENDOR_LOG_COVERAGE_NOTE,
    };
    switch (decision.kind) {
        case 'sandbox-created':
            return { ...base, sandboxId: decision.sandboxId };
        case 'execution-refused':
            return {
                ...base,
                reason: decision.reason,
                // Absent when creation failed, and the difference matters: a
                // refusal with no sandbox leaked nothing, one with a sandbox id
                // had a sandbox that then had to be deleted.
                sandboxId: decision.sandboxId ?? null,
                toolRan: false,
            };
        case 'sandbox-deleted':
            return {
                ...base,
                sandboxId: decision.sandboxId,
                outcome: decision.outcome,
                settled: decision.settled,
            };
    }
}

/**
 * Record one decision. One call, one row.
 *
 * Throws whatever `logEvent` throws: this is the recording path, and swallowing
 * here would turn a missing row into silence. The executor is what isolates the
 * failure so a tool result is never lost to it — see its `onDecision` note.
 */
export async function recordSandboxDecision(
    db: PrismaTx,
    ctx: RequestContext,
    decision: SandboxDecision,
): Promise<void> {
    await logEvent(db, ctx, {
        action: SANDBOX_DECISION_ACTIONS[decision.kind],
        entityType: SANDBOX_AUDIT_ENTITY,
        // The sandbox id where there is one; the refusal with no sandbox is
        // filed under the request, which is the only identifier it has.
        entityId:
            'sandboxId' in decision && decision.sandboxId
                ? decision.sandboxId
                : `refused:${ctx.requestId}`,
        details: sentence(decision),
        detailsJson: details(decision),
    });
}

/**
 * Build the executor hook. Curries the context so `executor.ts` stays free of
 * both the audit writer and the request context.
 */
export function sandboxDecisionRecorder(
    db: PrismaTx,
    ctx: RequestContext,
): (decision: SandboxDecision) => Promise<void> {
    return (decision) => recordSandboxDecision(db, ctx, decision);
}
