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

import { LADDER, type IdentityWriteMode } from '@/lib/identity/write-ladder';

// Re-exported so the dozen existing importers keep their import path. The
// definition moved to a server-free module because the admin client needs the
// same ladder and cannot import a usecase.
export type { IdentityWriteMode };
export type IdentityDirection = 'leaver' | 'joiner';

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

    const refusal = describeRefusal(current, next, now);
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
