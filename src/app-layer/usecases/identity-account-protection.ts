/**
 * Mark a directory account as never-offboard, or release it.
 *
 * THE RAIL THIS FEEDS ALREADY EXISTED. `disableAccount` has refused a protected
 * account since #2036 — the refusal, its reason and its outcome are all in place
 * and tested. What it never had was a producer: `DisableAccountInput.isProtected`
 * was set by nothing, anywhere, so the rail was a guard bound to nothing.
 *
 * WHY AN OPERATOR FLAG ON THE ACCOUNT rather than a list in the connection's
 * config, which is what the original plan specified. Two alternatives were put
 * up and rejected on their failure modes:
 *
 *   - Deriving protection from `isAdmin` fails OPEN across an entire directory
 *     on one swallowed Graph 403. A rail that silently stops protecting is worse
 *     than no rail, because nobody is watching for its absence.
 *   - A PROPOSE-style approval queue duplicates a rung the ladder already has,
 *     and this rail has to work at AUTOMATIC — the mode where, by definition,
 *     nothing else stands in front of the write.
 *
 * WHAT IT DOES NOT DO. It does not decide WHICH accounts belong on the list.
 * Nothing in the schema identifies a break-glass credential, and any rule
 * invented here would be fiction — the narrowing fact being that a pure service
 * account with no Employee row can never be a candidate at all, since links are
 * created only by exact email match. The real target is narrower and nastier: an
 * address that used to be a person's, kept as the emergency credential, whose
 * link is legitimate and re-verified nightly.
 */
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { badRequest, notFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { RequestContext } from '../types';

/** Bound on the free-text reason. A note for the next operator, not a document. */
export const MAX_PROTECTION_REASON = 500;

export interface AccountProtectionState {
    readonly accountId: string;
    readonly isProtected: boolean;
    readonly protectedAt: Date | null;
    readonly protectedByUserId: string | null;
    readonly protectionReason: string | null;
}

/**
 * Set or clear the flag on one account.
 *
 * OWNER-only at the route via `requirePermission('admin.tenant_lifecycle')`. The
 * check is NOT repeated here as a second, weaker gate — that is how a route ends
 * up looking protected while granting more than it said, and this repo has
 * corrected that pattern once already.
 */
export async function setAccountProtection(
    ctx: RequestContext,
    accountId: string,
    input: { readonly isProtected: boolean; readonly reason?: string | null },
    now: Date = new Date(),
): Promise<AccountProtectionState> {
    // Sanitised at the WRITE path, per Epic C.5: the reason is operator-supplied
    // free text that a roster page, a pass report and any future SDK consumer all
    // read back verbatim. Escaping at render time alone leaves the stored row
    // dangerous to everything that is not an escaper.
    const cleanedReason = input.reason == null ? null : sanitizePlainText(input.reason).trim();
    if (cleanedReason !== null && cleanedReason.length > MAX_PROTECTION_REASON) {
        throw badRequest(`Protection reason must be ${MAX_PROTECTION_REASON} characters or fewer.`);
    }
    // A reason is REQUIRED to protect and meaningless to release. The whole value
    // of the list a year from now is that each entry says why it is there; an
    // unexplained never-offboard flag is indistinguishable from a mistake.
    if (input.isProtected && !cleanedReason) {
        throw badRequest('A reason is required when protecting an account.');
    }

    return runInTenantContext(ctx, async (db) => {
        // Tenant-scoped by the RLS transaction AND by the predicate — defence in
        // depth, and it makes a cross-tenant id read as "not found" rather than
        // as a silent no-op that reports success.
        const existing = await db.connectedIdentityAccount.findFirst({
            where: { id: accountId, tenantId: ctx.tenantId },
            select: { id: true, isProtected: true },
        });
        if (!existing) throw notFound('Directory account not found.');

        const updated = await db.connectedIdentityAccount.update({
            where: { id: existing.id },
            data: {
                isProtected: input.isProtected,
                // Cleared on release rather than left behind. A stale
                // "protected by X on the 3rd" beside an unprotected account is a
                // sentence that reads as true and is not.
                protectedAt: input.isProtected ? now : null,
                protectedByUserId: input.isProtected ? ctx.userId : null,
                protectionReason: input.isProtected ? cleanedReason : null,
            },
            select: {
                id: true,
                isProtected: true,
                protectedAt: true,
                protectedByUserId: true,
                protectionReason: true,
            },
        });

        await logEvent(db, ctx, {
            action: 'IDENTITY_ACCOUNT_PROTECTION_CHANGED',
            entityType: 'ConnectedIdentityAccount',
            entityId: existing.id,
            details: input.isProtected
                ? 'Directory account marked never-offboard'
                : 'Directory account released from never-offboard',
            // `access`, not `configuration`. Releasing an account hands the
            // product standing authority to disable it in the customer's own
            // directory; an access-review reader is the audience for that.
            detailsJson: {
                category: 'access',
                // Protecting REVOKES the product's authority over this account;
                // releasing GRANTS it. Same orientation as the write-mode ladder.
                operation: input.isProtected ? 'revoke' : 'grant',
                summary: input.isProtected
                    ? 'Directory account marked never-offboard'
                    : 'Directory account released from never-offboard',
            },
            // The ACCOUNT ROW id, never the directory identifier. This row is
            // hash-chained and permanent, and #2060 established the rule for the
            // whole subsystem: an opaque, tenant-scoped handle leaves this module,
            // and the objectGUID does not.
            metadata: { accountId: existing.id, from: existing.isProtected, to: input.isProtected },
        });

        logger.info('directory account protection changed', {
            component: 'identity-account-protection',
            tenantId: ctx.tenantId,
            accountId: existing.id,
            from: existing.isProtected,
            to: input.isProtected,
        });

        return {
            accountId: updated.id,
            isProtected: updated.isProtected,
            protectedAt: updated.protectedAt,
            protectedByUserId: updated.protectedByUserId,
            protectionReason: updated.protectionReason,
        };
    });
}
