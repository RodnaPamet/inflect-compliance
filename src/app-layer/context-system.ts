/**
 * Context builders for work with NO signed-in user — jobs, sweeps, webhooks.
 *
 * Split out of `context.ts` for a load-bearing reason, not tidiness.
 * `context.ts` imports `getSessionOrThrow` from `@/lib/auth`, which imports
 * `@/auth`, which builds the NextAuth provider array at module scope. That
 * chain is fine in a Next request but fatal in the BullMQ worker, a plain Node
 * process where `next/headers` does not resolve and
 * `next-auth/providers/google` interops to a namespace rather than a callable:
 *
 *     ERR_MODULE_NOT_FOUND  file:///app/node_modules/next/headers   (at boot)
 *     TypeError: Google is not a function                    (at job execution)
 *
 * Both were the same edge. Every usecase imports `context.ts` for
 * `getTenantCtx`, so ANY job reaching a context builder dragged the whole
 * NextAuth tree in with it — and eight registered jobs did, four of them only
 * transitively through a usecase, with nothing in their own file to say so.
 *
 * So the rule this module exists to hold: **nothing here may import
 * `@/lib/auth`, `@/auth`, or anything else that reaches them.** The
 * request-facing builders (`getTenantCtx`, `getLegacyCtx`, `getOrgCtx`) stay in
 * `context.ts` where the session import belongs — they were the 404-importer
 * side, and moving them would have been a repo-wide rewrite for no benefit.
 *
 * The three builders are NOT interchangeable and must not be collapsed:
 *
 *   buildSystemContext        the actor IS the machine. No real User row.
 *   buildDelegatedJobContext  a named user is accountable, and some FKs are
 *                             NOT NULL (`Task.createdByUserId`), so a
 *                             synthetic principal fails at RUNTIME on the
 *                             constraint rather than at compile time.
 *   resolveMemberContext      act WITH a named user's real authority —
 *                             resolves their membership so a demoted or
 *                             removed principal loses it. Returns null as a
 *                             REFUSAL; falling back to a system context there
 *                             re-opens the escalation it exists to close.
 */
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import prisma from '@/lib/prisma';
import { RequestContext } from './types';

/**
 * The `userId` written on rows a background job creates.
 *
 * Every job previously spelled this inline as the literal `'system'`,
 * which is not a real `User.id` — so an audit row naming it resolves to
 * nobody, and a reviewer reading the trail cannot tell a platform sweep
 * from a person. The value is unchanged (rows already carry it, and
 * rewriting history is not on the table); what changes is that it now
 * travels with `actorType: 'JOB'`, which makes the row self-describing.
 */
export const SYSTEM_PRINCIPAL = 'system';

/**
 * Build the RequestContext a background job runs under.
 *
 * The thirteen jobs and sweeps that needed one each hand-rolled it, and
 * every copy was identical except for the `requestId` prefix. Identical
 * copies drift: the point of one builder is that a future change to how
 * machine activity is represented — a narrower permission set, a real
 * service principal, a different actor type — happens once.
 *
 * **On the ADMIN role.** These are platform operations, not user
 * requests: an evidence-expiry sweep must see every tenant row whoever
 * owns it, and there is no signed-in person whose authority could stand
 * in. So the role stays ADMIN, exactly as before — this function changes
 * NO authority. What it changes is honesty: the audit row now says `JOB`,
 * so machine writes are filterable and a reviewer is not misled into
 * reading a sweep as a human decision.
 *
 * This is deliberately NOT the right tool when a real person is on the
 * hook for the work. If a job acts because a named user owns the policy,
 * the task, or the report, that user's OWN membership should be resolved
 * and their real role used — see `resolveMemberContext`. Reaching for a
 * system context there would launder a READER's request into an ADMIN
 * one, which is the escalation this pair of helpers exists to separate.
 */
export function buildSystemContext(input: {
    tenantId: string;
    /** Stable, greppable job identity — e.g. `sla-monitor`. */
    job: string;
    /** Optional discriminator (a run id, a cloud name) appended to requestId. */
    discriminator?: string;
    tenantSlug?: string;
    /**
     * Override the whole request id. Only for a job that already has a
     * durable run identifier worth keeping in the trail (the control-test
     * runner's `jobRunId`) — otherwise let it be derived, so every job's
     * id has the same greppable shape.
     */
    requestId?: string;
    /**
     * Override the principal. `report-delivery` predates this builder
     * with its own `system:report-delivery` id, which is already written
     * on existing rows; changing it would orphan them.
     */
    principal?: string;
    /**
     * The COARSE permission flags. Defaults to full write/admin/audit —
     * what six of the callers had. Pass explicitly for the two that had
     * something narrower: `snapshot` reads only, and the control-test
     * runner writes but is neither admin nor auditor. Defaulting those
     * two into the full set would silently WIDEN a job's authority,
     * which is the opposite of the point.
     */
    permissions?: RequestContext['permissions'];
}): RequestContext {
    const suffix = input.discriminator ? `-${input.discriminator}` : '';
    return {
        requestId: input.requestId ?? `${input.job}-${input.tenantId}${suffix}`,
        userId: input.principal ?? SYSTEM_PRINCIPAL,
        actorType: 'JOB',
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        role: 'ADMIN',
        permissions: input.permissions ?? {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: false,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Context for a job that must write a row the SCHEMA requires a real user
 * on, while still recording that a job did the writing.
 *
 * `Task.createdByUserId` is `String` — NOT NULL — with a foreign key to
 * `User`. So a task simply cannot be created by `SYSTEM_PRINCIPAL`: the
 * insert dies on `Task_createdByUserId_fkey`. That constraint is the
 * reason these two jobs borrowed a real member's id in the first place,
 * and it is not something a context helper can wish away.
 *
 * What this fixes is the half that IS fixable today: the row now carries
 * `actorType: 'JOB'`, so the trail reads "a job did this, attributed to
 * <user>" instead of "<user> did this". A reviewer can filter machine
 * activity out; nobody is misled into treating a nightly sweep as a
 * deliberate act by the person named.
 *
 * **The ADMIN role stays, and that is a known remaining gap.** Resolving
 * the owner's real role instead (see `resolveMemberContext`) would mean a
 * READER-owned policy silently gets no review reminder — compliance work
 * disappearing quietly, which is worse than the escalation. Closing it
 * properly needs a real per-tenant SYSTEM `User` row so the FK can be
 * satisfied without borrowing anyone; that is a migration and belongs in
 * its own change. Until then this is the honest halfway point, and it is
 * documented rather than disguised.
 */
export function buildDelegatedJobContext(input: {
    tenantId: string;
    job: string;
    /** A REAL `User.id` — required by the foreign key on the row being written. */
    onBehalfOf: string;
    tenantSlug?: string;
    /** Override the derived request id (the control-test runner keeps its jobRunId). */
    requestId?: string;
    /** Coarse flags; defaults to full. Pass explicitly to keep a narrower set. */
    permissions?: RequestContext['permissions'];
}): RequestContext {
    return {
        requestId: input.requestId ?? `${input.job}-${input.tenantId}`,
        userId: input.onBehalfOf,
        actorType: 'JOB',
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        role: 'ADMIN',
        permissions: input.permissions ?? {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: false,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Resolve the RequestContext for a job acting ON BEHALF OF a named user.
 *
 * Some background work has a real accountable person: the policy owner a
 * review reminder is raised for, the author of a control-test plan, the
 * requester of a scheduled report. Those jobs used to keep that user's
 * `userId` — good, the audit row names the right person — while pinning
 * `role: 'ADMIN'`, which is not. One of them said so outright: *"ADMIN
 * permissions clear `assertCanWriteTasks`"*. A READER who owns a policy
 * therefore had an ADMIN-authority write committed under their name.
 *
 * This resolves the membership instead, so:
 *   • a demoted or removed principal loses the authority they had;
 *   • a custom role that withholds a flag keeps withholding it here;
 *   • an INVITED / DEACTIVATED / REMOVED membership resolves to `null`.
 *
 * Returning `null` is a REFUSAL, and the caller must treat it as one.
 * Falling back to a system context on `null` would re-open the same door
 * from the other side — the write would still happen, just anonymously.
 * The right response is to skip that principal's item and say so.
 *
 * Mirrors `resolveActorCtx` in `automation/action-executor.ts`, which
 * closed the identical hole for automation rules, and reuses the same
 * `computePermissions` so the two cannot drift.
 */
export async function resolveMemberContext(input: {
    tenantId: string;
    userId: string;
    job: string;
    discriminator?: string;
}): Promise<RequestContext | null> {
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
        include: { customRole: true, tenant: { select: { slug: true } } },
    });
    if (!membership || membership.status !== 'ACTIVE') return null;

    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    const suffix = input.discriminator ? `-${input.discriminator}` : '';
    return {
        requestId: `${input.job}-${input.tenantId}${suffix}`,
        userId: input.userId,
        tenantId: input.tenantId,
        tenantSlug: membership.tenant?.slug,
        role: effectiveRole,
        permissions: computePermissions(effectiveRole),
        appPermissions: membership.customRole
            ? parsePermissionsJson(
                  membership.customRole.permissionsJson,
                  membership.customRole.baseRole,
              )
            : getPermissionsForRole(membership.role),
    };
}