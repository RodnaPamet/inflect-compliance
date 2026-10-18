/**
 * A MEMBERSHIP'S LINE OF DEFENCE — the one writer of
 * `TenantMembership.lineOfDefence` (#3675, step 3b; decision 3 of the agentic
 * IAM roadmap).
 *
 * The value is FIRST, SECOND, THIRD or NULL ("not declared"). The auditor
 * independence check reads it — an auditor agent's owner must be SECOND — and
 * so does the workpaper review stamp, which only a THIRD-line member may set.
 * A check that reads a value is only as good as the control over who writes
 * it, so the writer is narrow on every axis:
 *
 *   • THE KEY: the route carries a literal
 *     `requirePermission('admin.owner_management')`, which among the built-in
 *     roles only OWNER holds — ADMIN is denied it explicitly
 *     (`getPermissionsForRole`), and so is AI_ADMIN. No API key carries it:
 *     `*` is ADMIN's set and no scope maps to it. Re-asserted here so a second
 *     caller of this function cannot reach it with less.
 *   • THE BUILT-IN ROLE: the caller's `TenantMembership.role` must be OWNER. A
 *     custom role can carry `owner_management` when an OWNER authors it
 *     (`assertGrantWithinOwnAuthority`), and decision 3 has an OWNER set the
 *     value — not whoever an OWNER once delegated a key to.
 *   • A PERSON: a context speaking for an API key or an agent is refused.
 *   • NEVER ONE'S OWN MEMBERSHIP: a line its holder declared is a claim, not a
 *     control. A tenant with one OWNER therefore cannot declare that OWNER's
 *     line; it adds a second OWNER, or another member owns the auditor agent.
 *
 * Every CHANGE writes a hash-chained `MEMBER_LINE_OF_DEFENCE_CHANGED` audit row
 * with the line before and after. Setting the value it already has changes
 * nothing and writes nothing.
 *
 * A change can break an auditor agent's independence — its owner moved off
 * SECOND — so the change is followed, in the same transaction, by
 * `reconcileAuditorIndependenceInTx`, which raises a finding against every
 * ACTIVE auditor that member owns. The change itself is not refused: the OWNER
 * is correcting a declaration, and a declaration that cannot be corrected
 * because an auditor depends on it would be a declaration kept false.
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import type { LineOfDefenceValue } from '@/lib/agentic/auditor-independence';
import { logEvent } from '../events/audit';
import { SetLineOfDefenceSchema } from '../schemas/membership-line-of-defence.schemas';
import type { RequestContext } from '../types';
import { lockAuditorIndependence, reconcileAuditorIndependenceInTx } from './auditor-independence';

/** The gate, before anything is read. See the module docstring. */
function assertCanSetLineOfDefence(ctx: RequestContext): void {
    if (ctx.appPermissions?.admin?.owner_management !== true) {
        throw forbidden(
            "Only an OWNER can set a member's line of defence. It decides who may own the auditor " +
                'agent and who may review its workpapers.',
        );
    }
    if (ctx.role !== 'OWNER') {
        throw forbidden(
            "A member's line of defence is set by an OWNER. A custom role carrying the owner " +
                'management permission does not make its holder one.',
        );
    }
    if (ctx.apiKeyId !== undefined || ctx.agentId !== undefined || ctx.actorType === 'JOB') {
        throw forbidden("A member's line of defence is set by a person, never by a credential.");
    }
}

export async function setMembershipLineOfDefence(
    ctx: RequestContext,
    membershipId: string,
    input: unknown,
) {
    assertCanSetLineOfDefence(ctx);
    const parsed = SetLineOfDefenceSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('lineOfDefence must be FIRST, SECOND, THIRD or null', parsed.error.issues);
    }
    const next = parsed.data.lineOfDefence;

    return runInTenantContext(ctx, async (db) => {
        // First, before any row is read: the line decides independence, and a
        // reconcile that ran beside an activation must see it.
        await lockAuditorIndependence(db, ctx);

        const membership = await db.tenantMembership.findFirst({
            where: { id: membershipId, tenantId: ctx.tenantId },
            select: { id: true, userId: true, lineOfDefence: true },
        });
        if (!membership) throw notFound('Membership not found.');
        if (membership.userId === ctx.userId) {
            throw forbidden(
                'You cannot set the line of defence of your own membership. Another OWNER sets it: ' +
                    'a line its holder declared would be a claim, not a control.',
            );
        }

        const previous = (membership.lineOfDefence ?? null) as LineOfDefenceValue | null;
        if (previous === next) {
            return {
                membershipId: membership.id,
                userId: membership.userId,
                lineOfDefence: next,
                previousLineOfDefence: previous,
                changed: false,
                independenceFindingIds: [] as string[],
            };
        }

        await db.tenantMembership.updateMany({
            where: { id: membership.id, tenantId: ctx.tenantId },
            data: { lineOfDefence: next },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_LINE_OF_DEFENCE_CHANGED',
            entityType: 'TenantMembership',
            entityId: membership.id,
            details: `Line of defence changed: ${previous ?? 'UNDECLARED'} → ${next ?? 'UNDECLARED'}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantMembership',
                operation: 'updated',
                changedFields: ['lineOfDefence'],
                before: { lineOfDefence: previous },
                after: { lineOfDefence: next },
                targetUserId: membership.userId,
            },
        });

        const reconciled = await reconcileAuditorIndependenceInTx(db, ctx, {
            trigger: 'LINE_OF_DEFENCE_CHANGE',
            ownerUserIds: [membership.userId],
        });

        return {
            membershipId: membership.id,
            userId: membership.userId,
            lineOfDefence: next,
            previousLineOfDefence: previous,
            changed: true,
            independenceFindingIds: [...reconciled.opened, ...reconciled.reopened],
        };
    });
}
