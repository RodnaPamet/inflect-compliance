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
 * The four builders are NOT interchangeable and must not be collapsed:
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
 *   resolveInitiatorContext   the same, for a job that does what one member
 *                             ASKED for (an evidence import, a SharePoint
 *                             sync; a queued workflow run reads its
 *                             `initiatorAuthority`). Keeps the caller's
 *                             request id and sets no `tenantSlug`.
 *
 * And one that is the initiator's context narrowed by a credential:
 *
 *   resolveKeyInitiatorContext  for a job a request queued with an API KEY.
 *                             The key's authority now AND the member's, never
 *                             more than either. Refuses with a named reason.
 */
import type { Role } from '@prisma/client';
import { computePermissions, type Permissions } from '@/lib/tenant-context';
import {
    getPermissionsForRole,
    parsePermissionsJson,
    permissionsForMembership,
    type PermissionSet,
} from '@/lib/permissions';
import prisma from '@/lib/prisma';
import { resolveApiKeyForJob, type ApiKeyJobRefusal } from '@/lib/auth/api-key-auth';
import {
    intersectPermissionSets,
    intersectPermissions,
    lowerRole,
} from '@/lib/agentic/agent-authority';
import { RequestContext } from './types';

/**
 * The `userId` written on rows a background job creates.
 *
 * Every job previously spelled this inline as the literal `'system'`,
 * which is not a real `User.id` — so an audit row naming it resolves to
 * nobody, and a reviewer reading the trail cannot tell a platform sweep
 * from a person. It now travels with `actorType: 'JOB'`, which is what
 * makes the row self-describing.
 *
 * AN EARLIER VERSION OF THIS COMMENT SAID "rows already carry it". They do
 * not, and they never could: `AuditLog.userId` is a foreign key to
 * `User.id`, no `User` row has this id, and every such insert was rejected.
 * Production held ZERO rows with `userId = 'system'` while dropping roughly
 * 71 audit events a day — `JOB`-typed rows stopped entirely on 2026-09-12.
 * The sentinel is now mapped to NULL at the audit write seam
 * (`auditUserIdOrNull` in `lib/audit/audit-writer.ts`), which is where the
 * column is, rather than at each of the thirteen context builders.
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

/**
 * The authority a job carries for the member who STARTED it: exactly the
 * role, coarse flags and granular set a request from that member gets.
 *
 * A request's rule (`resolveTenantContext`): the role is the custom role's
 * base when the membership has one, the coarse flags are `computePermissions`
 * of that role, and the granular set is `permissionsForMembership` — the custom
 * role's JSON parsed over its base. Only the link is read, never the custom
 * role's `isActive`: a request applies a soft-deleted role a membership is
 * still linked to, and so does this. (`deleteCustomRole` clears the links in
 * the same write, so such a link takes legacy data or a race.)
 * `initiator-context.test.ts` holds this equal to `resolveTenantContext`.
 *
 * So a custom role restricts the job exactly as it restricted the request that
 * queued it, and a role changed while the job sat in the queue applies when it
 * runs. These jobs read `getPermissionsForRole(membership.role)` until #4362,
 * so a custom role that withheld `evidence.upload` or `controls.edit` was
 * ignored by the work it had queued. Their coarse flags were a projection of
 * that granular set, which gave a built-in EDITOR, READER or AI_ADMIN a
 * `canAudit` its own request does not hold; they are a request's now (owner
 * decision, 2026-10-26).
 */
export function initiatorAuthority(membership: {
    role: Role;
    customRole: { baseRole: Role; permissionsJson: unknown } | null;
}): { role: Role; permissions: Permissions; appPermissions: PermissionSet } {
    const role = membership.customRole?.baseRole ?? membership.role;
    return {
        role,
        permissions: computePermissions(role),
        appPermissions: permissionsForMembership(membership),
    };
}

/**
 * Resolve the context for a job that does what one named member asked for:
 * the initiator of an evidence import, the actor of a SharePoint sync.
 *
 * Returns `null` when that member has no ACTIVE membership in the tenant. That
 * is a REFUSAL, exactly as for `resolveMemberContext`: the caller stops, and
 * never falls back to a system context.
 *
 * Differs from `resolveMemberContext` only in what these jobs always carried:
 * the caller's own `requestId`, and no `tenantSlug`.
 */
export async function resolveInitiatorContext(input: {
    tenantId: string;
    userId: string;
    requestId: string;
}): Promise<RequestContext | null> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { userId: input.userId, tenantId: input.tenantId, status: 'ACTIVE' },
        select: {
            role: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
    });
    if (!membership) return null;
    return {
        requestId: input.requestId,
        userId: input.userId,
        tenantId: input.tenantId,
        ...initiatorAuthority(membership),
    };
}

/**
 * Why a job a key started may not run (`resolveKeyInitiatorContext`): a reason
 * a request with the key would be refused (`revoked`, `expired`, `not_found`,
 * `tenant_deleted`, `principal_unresolved`), the key belonging to another
 * tenant (`other_tenant`) or to another user than the job names
 * (`other_user`), or that user having no ACTIVE membership
 * (`initiator_not_a_member`).
 */
export type KeyInitiatorRefusal = ApiKeyJobRefusal | 'other_user' | 'initiator_not_a_member';

/**
 * The context for a job that a request made with an API KEY queued (#4369).
 *
 * The request was checked against the key: its scopes, its tenant, its
 * liveness. A job rebuilt from the initiating user alone
 * (`resolveInitiatorContext`) would run with that user's whole membership — so
 * a key that may upload evidence but not edit controls would have its import
 * link records to a control anyway, and a key revoked while the job was
 * queued would still have the job run. So the key is read again, by id, through
 * the tail a request runs (`resolveApiKeyForJob`), and the job holds:
 *
 *     key now  ∧  the initiator's membership now
 *
 * — role the lower of the two, coarse flags and granular set field by field
 * (`lowerRole`, `intersectPermissions`, `intersectPermissionSets`, the
 * conjunction an agent-bound key is narrowed by). Never more than either.
 *
 * The membership term is the job's own (`resolveInitiatorContext`, the same
 * lookup a session-started job makes), and it is applied to EVERY key, not only
 * an agent-bound one. A request made with a key that is bound to no agent is
 * authorised by the key's scopes alone; this job is narrower than that request
 * when the key's creator holds less than the key. That is not a narrowing this
 * change introduces: the job applied the membership before, and dropping it
 * for such a key would let the job do what the member, today, may not.
 *
 * The key's IP is not a term: a key carries no IP allowlist, and the request's
 * address is recorded only as the key's last use, which this re-read is not.
 *
 * Returns a refusal rather than `null`, because there are several and an
 * operator needs to know which: the caller stops, does no work, and names it.
 */
export async function resolveKeyInitiatorContext(input: {
    tenantId: string;
    userId: string;
    apiKeyId: string;
    requestId: string;
}): Promise<{ ok: true; ctx: RequestContext } | { ok: false; reason: KeyInitiatorRefusal }> {
    const key = await resolveApiKeyForJob({ apiKeyId: input.apiKeyId, tenantId: input.tenantId });
    if (!key.valid) return { ok: false, reason: key.reason };
    // The key speaks for the user who created it, and the route names that
    // user as the initiator. A payload naming somebody else is not this key's.
    if (key.ctx.userId !== input.userId) return { ok: false, reason: 'other_user' };

    const member = await resolveInitiatorContext({
        tenantId: input.tenantId,
        userId: input.userId,
        requestId: input.requestId,
    });
    if (!member) return { ok: false, reason: 'initiator_not_a_member' };

    return {
        ok: true,
        ctx: {
            requestId: input.requestId,
            userId: input.userId,
            tenantId: input.tenantId,
            role: lowerRole(member.role, key.ctx.role),
            permissions: intersectPermissions(member.permissions, key.ctx.permissions),
            appPermissions: intersectPermissionSets(member.appPermissions, key.ctx.appPermissions),
            // Carried as a request carries them, so anything downstream that
            // asks "was this a key, and which?" gets the same answer.
            apiKeyId: key.ctx.apiKeyId,
            apiKeyScopes: key.ctx.apiKeyScopes,
            ...(key.ctx.agentId ? { agentId: key.ctx.agentId } : {}),
            apiKeyMaxAutonomy: key.ctx.apiKeyMaxAutonomy ?? null,
        },
    };
}
