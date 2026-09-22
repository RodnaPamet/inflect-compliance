/**
 * The joiner's HRIS write-back seam — #2716, and the honest half of it.
 *
 * WHAT THIS DOES: runs the write-back GATE for a created account and reports,
 * by name, whether the address could reach the system of record. Before it,
 * `createDirectoryAccount` reported `PARTIAL_NO_HRIS_WRITEBACK` with the same
 * sentence every time — "no HRIS write-back is wired" — which is true and says
 * nothing about THIS tenant. Now the refusal carries the reason: the mode is
 * above the ceiling, the connection has not opted in, there is no HRIS handle,
 * or the credential cannot write.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: write to an HRIS. That is Phase 2 of
 * `docs/jml-hris-write-back-design.md` — "conditional write with read-back,
 * journal capture-before-write, hash-chained audit, breaker with the
 * complete-roster denominator" — and it is the larger half of the work. This
 * file does not grow one, for three reasons that are all still true:
 *
 *   1. `HRIS_WRITEBACK_MAX_MODE` is `DRY_RUN`. The gate refuses every rung
 *      above it, so a write here would be unreachable code wearing the costume
 *      of a capability.
 *   2. The design's open question 1 is UNRESOLVED: "Does BambooHR expose an
 *      employee-update API at the same gateway base, with the same Basic
 *      auth? Not verifiable from this repo; there is no call site to show."
 *      Decision 1 rests entirely on it.
 *   3. The design's rule for a contributor: new HRIS behaviour is shown to
 *      work against the OrangeHRM instance, and "when it needs to be shown to
 *      work for BambooHR specifically, it cannot be, and that limitation
 *      belongs in the PR body rather than in a fixture that implies
 *      otherwise."
 *
 * So the product still has never written a byte to any HRIS, and a reviewer
 * can check that the same way as before: grep the providers tree for a
 * mutating method.
 *
 * WHAT MAKES THE FAILURE RECOVERABLE. `PARTIAL_NO_HRIS_WRITEBACK` is the only
 * one of the three partial states that is safely retryable, and retryable
 * needs somewhere for the derived identity to live. `PreHire.intendedAddress`
 * (#2715) is that place: the address is recorded against the pre-hire BEFORE
 * the write-back is attempted, so a later retry has a subject even if the
 * process that created the account is long gone.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import {
    gateWriteBackPreflight,
    HRIS_WRITEBACK_MAX_MODE,
} from '@/app-layer/integrations/providers/hris/write-back';
import type { IdentityWriteMode } from './identity-write-policy';

export interface JoinerWriteBackInput {
    /** The HRIS provider key for this tenant's connection. */
    readonly provider: string;
    /** The connection's stored config, which carries `writeBackEnabled`. */
    readonly config: Record<string, unknown>;
    readonly mode: IdentityWriteMode;
    /** The pre-hire this account was created for, if the joiner had one. */
    readonly preHireId: string | null;
    /** The address the directory actually issued. */
    readonly address: string;
}

export type JoinerWriteBackOutcome =
    /**
     * The gate refused, and `detail` says why in the tenant's own terms. The
     * caller reports PARTIAL_NO_HRIS_WRITEBACK carrying this.
     */
    | { readonly kind: 'REFUSED'; readonly outcome: string; readonly detail: string }
    /**
     * The gate did NOT refuse — every permission is in place — and the write
     * still did not happen, because the write does not exist. Distinct from
     * REFUSED on purpose: "you are not allowed" and "we cannot yet" are
     * different facts about a tenant, and only one of them is something they
     * can act on.
     */
    | { readonly kind: 'NOT_IMPLEMENTED'; readonly detail: string };

/**
 * Record the address against the pre-hire, then run the gate.
 *
 * ORDER MATTERS. The address is persisted FIRST, so a crash between here and
 * the gate leaves the derived identity recoverable rather than lost. This is
 * the same argument `beginWrite` makes for capturing prior state before
 * touching a provider, applied to the one partial state that is retryable.
 */
export async function attemptJoinerWriteBack(
    ctx: RequestContext,
    input: JoinerWriteBackInput,
): Promise<JoinerWriteBackOutcome> {
    if (input.preHireId) {
        await runInTenantContext(ctx, (db) =>
            db.preHire.updateMany({
                // `updateMany` with an explicit tenantId, not `update` by id:
                // RLS is the backstop, the predicate is the control.
                where: { id: input.preHireId!, tenantId: ctx.tenantId },
                data: { intendedAddress: input.address },
            }),
        );
    }

    const refusal = gateWriteBackPreflight({
        provider: input.provider,
        config: input.config,
        mode: input.mode,
    });
    if (refusal) {
        return {
            kind: 'REFUSED',
            outcome: refusal.outcome,
            detail: refusal.detail,
        };
    }

    return {
        kind: 'NOT_IMPLEMENTED',
        detail:
            `Every write-back permission is in place for ${input.provider} and the address ` +
            `has been recorded against the pre-hire, but the write itself is Phase 2 of ` +
            `docs/jml-hris-write-back-design.md and does not exist. The ceiling is ` +
            `${HRIS_WRITEBACK_MAX_MODE}; the product has never written to an HRIS. Retrying ` +
            `this write-back alone is safe and does not re-run the create.`,
    };
}
