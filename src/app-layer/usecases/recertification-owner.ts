/**
 * Who this product acts as when it raises a recertification nobody asked for.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * #2879's finding 58 reads: "nothing recomputes access after a move and the
 * compensating control is manual-only — no job ever creates an access-review
 * campaign." Both halves are true, and the second is not an oversight. It falls
 * out of an accountability decision this codebase already made and states.
 *
 * `Task.createdByUserId` is NOT NULL, and `context-system.ts` says what that
 * costs a background job in as many words: a synthetic principal *"fails at
 * RUNTIME on the constraint rather than at compile time"*. The connected-review
 * flow adds its own requirement — `assertCanAdmin` plus a named
 * `reviewerUserId`. So a scheduled pass could not raise either artefact without
 * a REAL user to be accountable, and the product had no way to name one:
 * `Tenant` carries no owner and no job in `src/` picked an administrator to act
 * as. The gap was in the naming, not in the willingness.
 *
 * ═══ A NAME IS NOT A GRANT ═══
 *
 * The configured id is run through `resolveMemberContext`, which reads the
 * principal's REAL membership and returns null for anything that is not
 * `ACTIVE`. So a nominated user who is later demoted or removed loses the
 * ability, rather than keeping an ADMIN-shaped context nobody re-checked.
 *
 * That is not a hypothetical. `buildDelegatedJobContext`'s docblock records the
 * failure it was written for: jobs kept a user's `userId` — good, the audit row
 * names the right person — while pinning `role: 'ADMIN'`, so *"a READER who
 * owns a policy therefore had an ADMIN-authority write committed under their
 * name."* Resolving the membership is what keeps this from repeating.
 *
 * ═══ EVERY REFUSAL IS NAMED ═══
 *
 * Three outcomes, not a nullable, because they are three different things for
 * an operator to do something about: nobody was nominated, the nominee no
 * longer holds the tenant, or it is ready. Collapsing them would leave a tenant
 * unable to tell "we never configured this" from "the person we configured has
 * left", which are a settings task and an offboarding consequence respectively.
 */
import { resolveMemberContext } from '../context-system';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '../context-system';
import type { RequestContext } from '../types';

export type RecertificationOwner =
    /** No user is nominated. Nothing is raised, and the caller must say so. */
    | { readonly kind: 'unset' }
    /**
     * A user IS nominated, and is no longer an active member of this tenant.
     *
     * Distinct from `unset` on purpose: this one means the tenant's automated
     * recertification stopped working on the day that person was deactivated,
     * which is exactly the kind of silent decay the finding is about.
     */
    | { readonly kind: 'unresolvable'; readonly userId: string }
    | { readonly kind: 'ready'; readonly userId: string; readonly ctx: RequestContext };

/**
 * Resolve the accountable principal for one tenant.
 *
 * `job` names the caller in the resulting `requestId`, so a row written on this
 * context says which pass raised it.
 */
export async function resolveRecertificationOwner(
    tenantId: string,
    job: string,
): Promise<RecertificationOwner> {
    // A SYSTEM context is enough to READ the setting — it is the WRITE that
    // needs a person. Reading it as the nominee would be circular.
    const settingsCtx = buildSystemContext({ tenantId, job });
    const row = await runInTenantContext(settingsCtx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId },
            select: { recertificationOwnerUserId: true },
        }),
    );

    const userId = row?.recertificationOwnerUserId ?? null;
    if (!userId) return { kind: 'unset' };

    const ctx = await resolveMemberContext({ tenantId, userId, job });
    // NULL IS A REFUSAL, NOT A MISS. `resolveMemberContext` returns null for a
    // membership that is absent or not ACTIVE, and falling back to a system or
    // delegated context here would re-open the escalation it exists to close.
    if (!ctx) return { kind: 'unresolvable', userId };

    return { kind: 'ready', userId, ctx };
}
