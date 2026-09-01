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
 * DISABLED → DRY_RUN → PROPOSE → AUTOMATIC rather than flipping on.
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
    type IdentityWriteMode,
    type IdentityDirection,
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

const FIELDS = {
    leaver: { mode: 'identityLeaverMode', since: 'identityLeaverDryRunSince' },
    joiner: { mode: 'identityJoinerMode', since: 'identityJoinerDryRunSince' },
} as const;

/**
 * Read both directions. A tenant with no settings row has never configured
 * anything, which is DISABLED — the absence is a real answer, not a missing one,
 * so callers never have to distinguish undefined from off.
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
        return {
            leaver: {
                mode: (row?.identityLeaverMode ?? 'DISABLED') as IdentityWriteMode,
                dryRunSince: row?.identityLeaverDryRunSince ?? null,
            },
            joiner: {
                mode: (row?.identityJoinerMode ?? 'DISABLED') as IdentityWriteMode,
                dryRunSince: row?.identityJoinerDryRunSince ?? null,
            },
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
    // The harm is state accumulation, not a live write: nothing acts on
    // `identityJoinerMode` today, so a tenant that reached AUTOMATIC would simply
    // BE at AUTOMATIC on the day a joiner runtime, or a future JOINER_MAX_MODE
    // clamp, first looked — with the ladder's whole point already spent. The
    // seven days bought nothing, because the dwell below fires only when LEAVING
    // DRY_RUN, so once past that rung there is no further delay at all.
    //
    // Placed BELOW the narrowing check on purpose. A tenant already sitting above
    // DISABLED — set before this gate existed, or after the joiner ships and is
    // later withdrawn — must still be able to come back down.
    if (!DIRECTION_IMPLEMENTED[direction]) {
        return `The ${direction} direction has no implementation behind it — no job or directory writer reads this setting — so a rung above DISABLED would be recorded and would do nothing. It cannot be widened until the ${direction} runtime ships.`;
    }

    // Widening by more than one rung skips the step whose entire purpose is to
    // catch the mistake the next rung would then make for real.
    if (to - from > 1) {
        return `Cannot go from ${current.mode} to ${next} in one step. Widen one level at a time (${LADDER.slice(from, to + 1).join(' → ')}), so each level is observed before the next is granted.`;
    }

    // Leaving DRY_RUN requires having actually spent time in it.
    if (current.mode === 'DRY_RUN') {
        if (!current.dryRunSince) {
            return 'Dry-run has no recorded start. Re-select DRY_RUN to start the observation window.';
        }
        const days = (now.getTime() - current.dryRunSince.getTime()) / 86_400_000;
        if (days < DRY_RUN_MIN_DAYS) {
            const left = Math.ceil(DRY_RUN_MIN_DAYS - days);
            return `Dry-run has been active for ${Math.floor(days)} of ${DRY_RUN_MIN_DAYS} required days. ${left} more before this direction can widen — the point is to observe a real termination-and-hire cycle against what HR and IT actually did.`;
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
export async function setIdentityWriteMode(
    ctx: RequestContext,
    direction: IdentityDirection,
    next: IdentityWriteMode,
    now: Date = new Date(),
): Promise<DirectionState> {
    if (!LADDER.includes(next)) throw badRequest(`Unknown identity write mode: ${next}`);

    const policy = await getIdentityWritePolicy(ctx);
    const current = policy[direction];

    const refusal = describeRefusal(direction, current, next, now);
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
