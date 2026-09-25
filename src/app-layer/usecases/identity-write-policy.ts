/**
 * JML identity-write authority: what a tenant has allowed this product to do to
 * its identity directory, per direction.
 *
 * ═══ WHY A LADDER AND NOT A BOOLEAN ═══
 *
 * Every other integration in this product READS. This is the first that will
 * write to a system we do not own, and the two mistakes are not symmetric:
 * a wrongful disable locks an employee out of their job until someone notices;
 * a wrongful create spends money on a licence and leaves an unowned account
 * behind. So the directions are configured separately, and each moves through
 * DISABLED → DRY_RUN → AUTOMATIC rather than flipping on.
 *
 * There was a fourth rung, PROPOSE, between DRY_RUN and AUTOMATIC. It refused
 * every candidate (its approval queue was never built) AND it was the only
 * transition the seven-day dwell did not gate, so it was the step around the
 * only real delay on the ladder rather than a step on it. Removing it is what
 * makes DRY_RUN → AUTOMATIC a single, dwell-gated move — see
 * `@/lib/identity/write-ladder` for the full argument, and `coerceStoredMode`
 * for what a row still holding the old value now reads as.
 *
 * The ladder is not ceremony. The status normalisation that triggers all of this
 * has never been run against a real Workday tenant (see the operator decision
 * recorded alongside this work), and a mapping bug is invisible until it acts on
 * a real person. DRY_RUN is where that surfaces — computed intentions, compared
 * against what HR and IT actually did, with nothing written.
 *
 * @module usecases/identity-write-policy
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';

import {
    LADDER,
    DIRECTION_IMPLEMENTED,
    coerceStoredMode,
    type IdentityWriteMode,
    type IdentityDirection,
    PASS_AUTOMATION_SUFFIX,
} from '@/lib/identity/write-ladder';

// Re-exported so the dozen existing importers keep their import path. The
// definition moved to a server-free module because the admin client needs the
// same ladder and cannot import a usecase.
export type { IdentityWriteMode, IdentityDirection };

/** Widening order. Index is authority: higher means the product may do more. */

/**
 * How long a direction must sit in DRY_RUN before it may widen further.
 *
 * Seven days rather than a run count, because the point is to observe a real
 * termination-and-hire CYCLE against what HR actually did — and a tenant with a
 * quiet week has not observed anything by running the job seven times.
 */
export const DRY_RUN_MIN_DAYS = 7;

interface DirectionState {
    mode: IdentityWriteMode;
    dryRunSince: Date | null;
}

/**
 * Passes the window must contain before a direction may leave DRY_RUN.
 *
 * ONE, and the number is deliberately a floor rather than a sample size.
 *
 * The gate's original reasoning stands and is kept: a termination-and-hire
 * cycle takes calendar time, so calendar time is the right proxy for "has
 * enough happened yet", and counting runs would not improve it — a tenant with
 * a quiet week has observed nothing by running seven times.
 *
 * What calendar time cannot see is whether the machinery works AT ALL. Seven
 * days with zero executions is not a quiet week; it is a dispatcher that never
 * fired, a connection that never resolved, or a tenant that has no directory
 * attached — and the operator is about to widen the rung that lets this pass
 * write to a real directory. One executed pass is the difference between "we
 * waited" and "we waited and the thing ran".
 */
export const DRY_RUN_MIN_PASSES = 1;

const FIELDS = {
    leaver: { mode: 'identityLeaverMode', since: 'identityLeaverDryRunSince' },
    joiner: { mode: 'identityJoinerMode', since: 'identityJoinerDryRunSince' },
} as const;

/**
 * Read both directions. A tenant with no settings row has never configured
 * anything, which is DISABLED — the absence is a real answer, not a missing one,
 * so callers never have to distinguish undefined from off.
 *
 * ═══ THE ONLY PLACE A STORED MODE BECOMES A RUNG ═══
 *
 * Every consumer of the ladder — the leaver pass's clamp check, the writer
 * factory's dry-run arm, the disable usecase's mode gate, the admin GET, the
 * dwell arithmetic — reads its mode from here. So `coerceStoredMode` is applied
 * HERE and nowhere downstream: the retired PROPOSE value is translated before
 * anything compares, ranks or acts on it.
 *
 * That placement is load-bearing rather than tidy. `isAboveClamp` sorts a mode
 * it does not recognise to -1, which reads as BELOW the clamp and therefore
 * permitted to run; a stored PROPOSE reaching one single comparison unconverted
 * would be a tenant handed a live directory writer. The failure direction is
 * permissive, so the conversion has to happen before the first comparison, not
 * at each one.
 */
export async function getIdentityWritePolicy(
    ctx: RequestContext,
): Promise<Record<IdentityDirection, DirectionState>> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: {
                identityLeaverMode: true,
                identityJoinerMode: true,
                identityLeaverDryRunSince: true,
                identityJoinerDryRunSince: true,
            },
        });
        const leaverMode = coerceStoredMode(row?.identityLeaverMode);
        const joinerMode = coerceStoredMode(row?.identityJoinerMode);
        const leaverSince = row?.identityLeaverDryRunSince ?? null;
        const joinerSince = row?.identityJoinerDryRunSince ?? null;

        return {
            leaver: { mode: leaverMode, dryRunSince: leaverSince },
            joiner: { mode: joinerMode, dryRunSince: joinerSince },
        };
    });
}

/**
 * Why a requested transition is refused, or null if it is allowed.
 *
 * Exported and pure so the reason can be asserted directly, and so the UI can
 * explain the refusal before the operator submits it rather than after.
 */
export function describeRefusal(
    direction: IdentityDirection,
    current: DirectionState,
    next: IdentityWriteMode,
    now: Date,
    /**
     * Passes that EXECUTED since the window opened — #2843 finding 31.
     *
     * An ARGUMENT rather than a field on `DirectionState`, and the shape is
     * the point. The count is only meaningful when somebody is WIDENING a
     * mode, which happens on one route; `getIdentityWritePolicy` is read by
     * every pass on every run, and putting a query behind it would have made
     * a hot read pay for a rare question — and did, until the blast radius
     * said so: 35 test files mock that read's db without the model.
     *
     * `undefined` means "not supplied", and the check is skipped. Callers that
     * are not widening a mode have nothing to prove.
     */
    passesInWindow?: number,
): string | null {
    if (current.mode === next) return null;

    const from = LADDER.indexOf(current.mode);
    const to = LADDER.indexOf(next);

    // NARROWING IS ALWAYS ALLOWED, including straight to DISABLED. Someone
    // turning this off is reacting to something; a ladder that slowed them down
    // on the way out would be actively harmful.
    if (to < from) return null;

    // A DIRECTION WITH NO RUNTIME BEHIND IT CANNOT BE WIDENED AT ALL.
    //
    // `DIRECTION_IMPLEMENTED` is the same answer the route reports to the UI as
    // `honoured.<direction>.implemented`; it used to be a literal in that block
    // and nothing on the write path consulted it, so the ladder happily climbed
    // a direction the warning underneath it called nonexistent.
    //
    // The harm is state accumulation, not a live write. #2687 gave the joiner a
    // dispatcher, so the old wording here — "nothing DISPATCHES a joiner pass
    // today" — is no longer the reason; what a widened joiner would accumulate is
    // a tenant sitting at AUTOMATIC while every nightly plan refuses
    // `NO_DEPARTMENT_MAP`, with the ladder's whole point already spent by the day
    // the map exists. The seven days bought nothing, because the dwell below
    // fires only when LEAVING DRY_RUN, so once past that rung there is no further
    // delay at all.
    //
    // The clamp that rung would meet EXISTS — `JOINER_MAX_MODE` (DRY_RUN) in
    // `identity-joiner-pass`, which the admin route reports verbatim (#2638) —
    // and so does the trigger (#2687). The entitlement map has a SCHEMA and a
    // READER (#2713 — `IdentityDepartmentGroupRule` for the rules,
    // `identityDefaultGroupId` + `identityDefaultGroupName` for the fallback)
    // and a WRITER as of #2839 (`identity-entitlement-map`), so "a configured
    // tenant" is a state a tenant can now reach and an operator can clear the
    // refusal. What is still missing is the create
    // VERB (#2714): the pass can say which group it WOULD add the person to and
    // cannot add them. That is why `DIRECTION_IMPLEMENTED.joiner` is still
    // false; see the docblock on it.
    //
    // Placed BELOW the narrowing check on purpose. A tenant already sitting above
    // DISABLED — set before this gate existed, or after the joiner ships and is
    // later withdrawn — must still be able to come back down.
    if (!DIRECTION_IMPLEMENTED[direction]) {
        // THE SENTENCE IS RENDERED, so it has to stay true. It used to say
        // "nothing schedules or triggers a <direction> pass", which #2687 made
        // false the day it scheduled one — a refusal whose stated reason an
        // operator can disprove by looking at the pass report is worse than a
        // vaguer one, because it invites them to conclude the gate is stale.
        // What is true of an unimplemented direction in general, and of the
        // joiner in particular, is that the pass cannot ACT on the mode: it
        // can now DECIDE a group (#2713 gave the map a home), but there is
        // no create verb behind that decision (#2714).
        return `The ${direction} direction has no implementation behind it — a ${direction} pass cannot act on the mode it reads, so a rung above DISABLED would be recorded and would do nothing. It cannot be widened until the ${direction} runtime ships.`;
    }

    // Widening by more than one rung skips the step whose entire purpose is to
    // catch the mistake the next rung would then make for real.
    if (to - from > 1) {
        return `Cannot go from ${current.mode} to ${next} in one step. Widen one level at a time (${LADDER.slice(from, to + 1).join(' → ')}), so each level is observed before the next is granted.`;
    }

    // ═══ THE DWELL. SINCE #2241 IT GATES THE ONLY WIDEN THAT GRANTS AUTHORITY. ═══
    //
    // Leaving DRY_RUN requires having actually spent time in it. That sentence
    // has not changed; what changed is what it now covers.
    //
    // While PROPOSE existed the ladder read DISABLED → DRY_RUN → PROPOSE →
    // AUTOMATIC, this check fired only on `DRY_RUN → PROPOSE`, and NOTHING gated
    // `PROPOSE → AUTOMATIC`. Since the one-rung rule made PROPOSE compulsory on
    // the way up, the mandatory rung was also the ungated one: seven days bought
    // a move to a rung that refused every candidate, and the move that actually
    // granted unattended directory writes was free. Deleting PROPOSE puts the
    // dwell in front of that move. No gate was added; the detour was removed.
    //
    // A tenant coerced down from a stored PROPOSE arrives here with a null
    // `dryRunSince` — the write path nulls it on every move out of DRY_RUN — and
    // is refused by the branch below until it re-selects DRY_RUN and spends the
    // days. That is the intended answer for a rung nobody should have been able
    // to reach without them.
    if (current.mode === 'DRY_RUN') {
        if (!current.dryRunSince) {
            return 'Dry-run has no recorded start. Re-select DRY_RUN to start the observation window.';
        }
        // EVIDENCE as well as elapsed time (#2843 finding 31). Checked before
        // the day count so an operator who has waited the week and run nothing
        // is told the useful thing rather than being sent away to wait again.
        if (passesInWindow !== undefined && passesInWindow < DRY_RUN_MIN_PASSES) {
            return (
                `Dry-run has recorded ${passesInWindow} completed ${direction} ` +
                `passes since the window opened, and at least ${DRY_RUN_MIN_PASSES} is required. ` +
                'The window measures elapsed days, but a week with no pass at all is a ' +
                'dispatcher that never fired or a directory that never resolved — not a quiet ' +
                'week. Check the pass report for this direction before widening the mode.'
            );
        }
        const days = (now.getTime() - current.dryRunSince.getTime()) / 86_400_000;
        if (days < DRY_RUN_MIN_DAYS) {
            const left = Math.ceil(DRY_RUN_MIN_DAYS - days);
            // "so there is TIME FOR" rather than "to observe" — #2843 finding 31.
            //
            // This gate measures elapsed days and nothing else; it never reads
            // `IntegrationExecution` and cannot tell whether a single pass ran.
            // That is deliberate and tested (`is measured in days, not runs`):
            // a termination-and-hire cycle takes calendar time, so calendar
            // time is the proxy. But the sentence said the POINT IS TO OBSERVE,
            // which reads as a claim that observation happened — and an
            // operator treating a passed gate as evidence of a watched cycle is
            // believing something nobody measured.
            return `Dry-run has been active for ${Math.floor(days)} of ${DRY_RUN_MIN_DAYS} required days. ${left} more before this direction can widen — the window exists so there is time for a real termination-and-hire cycle to happen and be compared against what HR and IT actually did. It counts days, not passes.`;
        }
    }

    return null;
}

/**
 * Set one direction's mode.
 *
 * OWNER-only at the route via `requirePermission('admin.tenant_lifecycle')`.
 * The check is NOT repeated here as an `assertCanAdmin` — a second, weaker gate
 * inside the usecase is how a route ends up looking protected while granting
 * more than the route said (the pattern this repo already corrected once, where
 * a hand-rolled `canAdmin` check threw a 403 that wrote no AUTHZ_DENIED row).
 */
/**
 * Passes that EXECUTED for one direction since a timestamp.
 *
 * `status: { not: 'ERROR' }` because a pass that errored observed nothing.
 * Everything else — PASSED, PARTIAL, NOT_APPLICABLE — RAN, and a run that
 * found nobody is still the machinery working end to end, which is the fact
 * the dwell gate cannot otherwise see.
 */
async function countExecutedPasses(
    ctx: RequestContext,
    direction: IdentityDirection,
    since: Date,
): Promise<number> {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.count({
            where: {
                tenantId: ctx.tenantId,
                automationKey: { endsWith: PASS_AUTOMATION_SUFFIX[direction] },
                executedAt: { gte: since },
                status: { not: 'ERROR' },
            },
        }),
    );
}

export async function setIdentityWriteMode(
    ctx: RequestContext,
    direction: IdentityDirection,
    next: IdentityWriteMode,
    now: Date = new Date(),
): Promise<DirectionState> {
    if (!LADDER.includes(next)) throw badRequest(`Unknown identity write mode: ${next}`);

    const policy = await getIdentityWritePolicy(ctx);
    const current = policy[direction];

    // Counted HERE, on the one path that widens a mode, and only when the
    // question can arise: leaving DRY_RUN with a window open. Every other
    // transition has nothing to prove, and `getIdentityWritePolicy` stays the
    // cheap read every pass makes.
    const leavingDryRun = current.mode === 'DRY_RUN' && next !== 'DRY_RUN';
    const passesInWindow =
        leavingDryRun && current.dryRunSince
            ? await countExecutedPasses(ctx, direction, current.dryRunSince)
            : undefined;

    const refusal = describeRefusal(direction, current, next, now, passesInWindow);
    if (refusal) throw forbidden(refusal);

    const f = FIELDS[direction];
    // Entering DRY_RUN (re)starts the clock; leaving it clears the stamp so a
    // later return to DRY_RUN measures the NEW window rather than an old one.
    const since = next === 'DRY_RUN' ? now : null;

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, [f.mode]: next, [f.since]: since },
            update: { [f.mode]: next, [f.since]: since },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'IDENTITY_WRITE_MODE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Identity ${direction} write mode: ${current.mode} → ${next}`,
            // `access`, not `configuration`. Widening this grants the product
            // authority to disable or create accounts in the customer's
            // directory — an access-review reader is the audience for it.
            detailsJson: {
                category: 'access',
                operation: next === 'DISABLED' ? 'revoke' : 'grant',
                summary: `Identity ${direction} write mode: ${current.mode} → ${next}`,
            },
            metadata: { direction, from: current.mode, to: next },
        }),
    );

    logger.info('identity write mode changed', {
        component: 'identity-write-policy',
        tenantId: ctx.tenantId,
        direction,
        from: current.mode,
        to: next,
    });

    return { mode: next, dryRunSince: since };
}
