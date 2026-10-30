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
 *                             (`resolveMemberContextWithReason` is the same
 *                             resolution with the refusal named.)
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
import type { MembershipStatus, Role } from '@prisma/client';
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
import {
    TENANT_SYSTEM_USER_NAME,
    tenantSystemUserEmail,
    tenantSystemUserEmailHash,
    tenantSystemUserId,
} from '@/lib/tenant-system-user';
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
 * reason the first callers borrowed a real member's id, and it is not
 * something a context helper can wish away.
 *
 * THE FK ARGUMENT DOES NOT COVER EVERY CALLER. It was written for two, and
 * #4388 classified nine. Where the id is a person who ASKED for the work, the
 * ADMIN grant below is not the FK's doing and nothing justifies it: a context
 * built here is never re-checked, so a requester demoted or removed while the
 * job waited would still act with full ADMIN, attributed to them. Such a job
 * resolves the requester's real membership when it runs instead (#4400).
 *
 * What this fixes is the half that IS fixable today: the row now carries
 * `actorType: 'JOB'`, so the trail reads "a job did this, attributed to
 * <user>" instead of "<user> did this". A reviewer can filter machine
 * activity out; nobody is misled into treating a nightly sweep as a
 * deliberate act by the person named.
 *
 * `appPermissions` defaults to ADMIN's granular set and can be narrowed.
 * It could NOT before, which made a caller's coarse narrowing misleading:
 * `assertCanUploadEvidence` reads only `appPermissions.evidence.upload`, so
 * a context with `canAdmin: false` still passed every purely-granular
 * assert. Narrow BOTH or the narrowing is decorative (#4388).
 *
 * **The ADMIN role stays, and that is a known remaining gap.** Resolving
 * the owner's real role instead (see `resolveMemberContext`) would mean a
 * READER-owned policy silently gets no review reminder — compliance work
 * disappearing quietly, which is worse than the escalation.
 *
 * **Where the id is borrowed ONLY for the foreign key, use
 * `buildTenantSystemJobContext` instead** (#4400): it writes as the
 * tenant's SYSTEM user, so the row names no person. The policy review
 * reminder, the evidence retention notifications and the agent owner-orphan
 * pass's transfer task have moved.
 *
 * **Neither identity pass calls this any more** (#4400). A leaver or joiner
 * pass a person asked for acts with that person's real membership when it
 * runs, and only while it still holds the key the route asserted; otherwise it
 * acts with the job's own authority, exactly as the scheduled pass does, and
 * names nobody (`resolvePassActor`, `usecases/identity-pass-requester.ts`).
 * That closes #4400's list of borrowing callers. Four jobs that act for a
 * named member still use this (the control-test runner, agentic evidence
 * emission, the integration passport sweep and the agent kill-switch drill),
 * each for its own reason in #4388's classification.
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
    /**
     * Granular set; defaults to ADMIN's. Narrow it alongside `permissions` —
     * the asserts that read only this one are not gated by the coarse flags.
     */
    appPermissions?: PermissionSet;
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
        appPermissions: input.appPermissions ?? getPermissionsForRole('ADMIN'),
    };
}

/**
 * Make sure the tenant's SYSTEM user exists, and return its id (#4400).
 *
 * Created lazily, the first time a job needs it, rather than at tenant
 * creation: that covers every tenant-creation path, including ones written
 * later, with no backfill. Idempotent and race-free, because `ON CONFLICT DO
 * NOTHING` covers both the id and the unique `emailHash`.
 *
 * Raw SQL on purpose. `prisma.user.create` goes through the PII middleware,
 * which would derive `emailHash` from the email as an HMAC, the one value
 * this row's hash must never be. The email and name are stored as
 * plaintext: the PII read path passes through a value with no `v1:`/`v2:`
 * envelope, and neither is personal data.
 *
 * No foreign key to `Tenant`. Production never hard-deletes a tenant; a test
 * that does leaves an inert row behind, rather than a cascade into the rows
 * this user authored. The row's shape, and its inability to sign in or hold
 * standing anywhere, are CHECK constraints (migration
 * `20261029200000_tenant_system_user`).
 */
export async function ensureTenantSystemUser(tenantId: string): Promise<string> {
    const id = tenantSystemUserId(tenantId);
    await prisma.$executeRaw`
        INSERT INTO "User" ("id", "emailEncrypted", "emailHash", "nameEncrypted", "emailVerified", "updatedAt")
        VALUES (${id}, ${tenantSystemUserEmail(tenantId)}, ${tenantSystemUserEmailHash(tenantId)},
                ${TENANT_SYSTEM_USER_NAME}, now(), now())
        ON CONFLICT DO NOTHING`;
    return id;
}

/**
 * Context for a job that writes as the tenant's SYSTEM user (#4400).
 *
 * The replacement for `buildDelegatedJobContext` wherever a member was
 * borrowed only because a row's `User` foreign key is NOT NULL. The row now
 * names no person, the audit trail reads `actorType: 'JOB'` with the system
 * user's id, and the authority is the job's own, exactly what
 * `buildSystemContext` grants.
 *
 * Not for work a named person is accountable for. That still resolves their
 * membership (`resolveMemberContext`).
 */
export async function buildTenantSystemJobContext(input: {
    tenantId: string;
    job: string;
    tenantSlug?: string;
    discriminator?: string;
    /** Keep the calling pass's request id, so its rows and the task's correlate. */
    requestId?: string;
}): Promise<RequestContext> {
    return buildSystemContext({ ...input, principal: await ensureTenantSystemUser(input.tenantId) });
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
 * One shape of work is not that door, and it is narrow: work the job ALREADY
 * does on its own authority, on a schedule, whatever anybody asks, where a
 * person's request changes only WHEN it runs. The identity leaver and joiner
 * passes are that (#4400): a refused requester's pass still runs as the
 * scheduled pass would, names nobody, and records the refusal
 * (`resolvePassActor`). It does
 * not license a fallback anywhere a refusal would stop work the job would
 * otherwise never do.
 *
 * Mirrors `resolveActorCtx` in `automation/action-executor.ts`, which
 * closed the identical hole for automation rules, and reuses the same
 * `computePermissions` so the two cannot drift.
 *
 * A caller that must SAY why it was refused reads the same resolution through
 * `resolveMemberContextWithReason`; this is that function with the reason
 * dropped, so the two cannot disagree about who is refused.
 */
export async function resolveMemberContext(input: {
    tenantId: string;
    userId: string;
    job: string;
    discriminator?: string;
}): Promise<RequestContext | null> {
    const resolved = await resolveMemberContextWithReason(input);
    return resolved.ok ? resolved.ctx : null;
}

/**
 * `resolveMemberContext`'s answer, with the refusal named.
 *
 * `NOT_A_MEMBER` is a membership row that does not exist, which is what
 * removing somebody from a tenant leaves (`removeTenantMember` deletes the
 * row). `NOT_ACTIVE` is a row whose status is anything but ACTIVE, carried so
 * the record can say which.
 */
export type MemberContextResolution =
    | { ok: true; ctx: RequestContext }
    | { ok: false; reason: 'NOT_A_MEMBER' }
    | { ok: false; reason: 'NOT_ACTIVE'; status: MembershipStatus };

/**
 * `resolveMemberContext` for a caller that records WHY a principal was refused
 * (#4400: a manually requested identity pass whose requester has since left
 * or been deactivated runs anyway, on the job's own authority, and its record
 * names the reason). One query, one resolution; a refusal is still a refusal,
 * and this function never falls back to anything.
 */
export async function resolveMemberContextWithReason(input: {
    tenantId: string;
    userId: string;
    job: string;
    discriminator?: string;
}): Promise<MemberContextResolution> {
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
        include: { customRole: true, tenant: { select: { slug: true } } },
    });
    if (!membership) return { ok: false, reason: 'NOT_A_MEMBER' };
    if (membership.status !== 'ACTIVE') {
        return { ok: false, reason: 'NOT_ACTIVE', status: membership.status };
    }

    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    const suffix = input.discriminator ? `-${input.discriminator}` : '';
    return {
        ok: true,
        ctx: {
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
        },
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
 * How many memberships a borrowed-actor pick will consider before giving up.
 *
 * THIS CAP IS WHY THE SHAREPOINT DELTA-SYNC DISPATCHER DOES NOT USE THIS
 * FUNCTION, and the reason is recorded here because the convergence looks
 * obviously right from this side (#4398, measured 2026-10-29).
 *
 * That dispatcher picks an actor for EVERY enabled connection in one pass. Its
 * membership query is deliberately shaped against two things this function
 * cannot avoid:
 *
 *   * it is hoisted OUT of the per-connection loop — one query for every
 *     active OWNER/ADMIN of every tenant in scope, because a pick per
 *     connection is an N+1;
 *   * it is UNCAPPED, and its own comment records why: a global `take: 5000`
 *     once dropped every membership of a tenant that sorted late, and the
 *     tenant was then logged as having no eligible admin when it had several.
 *
 * A per-tenant `take` of 50 is a smaller version of exactly that failure — a
 * qualifying admin sorting 51st reads as NO_QUALIFYING_ACTOR — in a file that
 * has already paid for it once. So the duplication between
 * `DELTA_SYNC_UNROUTABLE` and `BORROW_FAILURE` is deliberate: the two jobs ask
 * the same question about different populations, and only the single-tenant
 * one can afford a bounded pick.
 */
export const BORROWED_ACTOR_CANDIDATE_CAP = 50;

/** Why a borrowed-actor pick came up empty. One definition for every such job. */
export const BORROW_FAILURE = {
    /** The tenant has no ACTIVE member matching the requested roles. */
    NO_ACTIVE_MEMBER: 'NO_ACTIVE_MEMBER',
    /** It has members, and not one of their RESOLVED authorities allows the work. */
    NO_QUALIFYING_ACTOR: 'NO_QUALIFYING_ACTOR',
} as const;

export type BorrowFailure = (typeof BORROW_FAILURE)[keyof typeof BORROW_FAILURE];

export type BorrowedActor = {
    userId: string;
    role: Role;
    permissions: Permissions;
    appPermissions: PermissionSet;
};

export type BorrowedActorOutcome =
    | { actor: BorrowedActor; reason: null }
    | { actor: null; reason: BorrowFailure };

/**
 * Pick the member a job BORROWS, by what their authority actually resolves to.
 *
 * Some jobs act for nobody in particular — a nightly sweep, a cron summary — and
 * borrow a member so RLS and the read policies have an actor. They used to take
 * the oldest ACTIVE OWNER/ADMIN and call `getPermissionsForRole(membership.role)`,
 * which drops a custom role entirely: a workspace whose only admins carry a
 * custom role got the BUILT-IN role's authority, which is not the authority any
 * request of theirs would have (#4388, owner decision 2026-10-26).
 *
 * Two things follow, and the second is why this is a pick rather than a lookup:
 *
 *   * authority comes from `initiatorAuthority`, the same resolution a request
 *     uses — custom role included, and the coarse flags computed from the role
 *     rather than hand-projected from granular ones;
 *   * the member chosen is the first IN ORDER whose resolved authority actually
 *     ALLOWS the job's work. Picking the oldest admin and discovering at the
 *     usecase's `assertCan*` that they cannot do it turns a routing decision
 *     into a thrown refusal, which is what the delta-sync dispatcher avoids by
 *     asking `mayRunDeltaSync` before it queues.
 *
 * `allows` is the job's OWN definition of its requirement and must be the key
 * its usecase asserts — one definition, so the pick can never choose a member
 * the work would then refuse.
 *
 * Never returns a bare `null`: the two ways a pick can come up empty are
 * different operational facts and a caller that cannot tell them apart reports
 * the wrong one. `NO_ACTIVE_MEMBER` means the tenant has nobody to borrow;
 * `NO_QUALIFYING_ACTOR` means it has members and not one of them may do this
 * work. Both are REFUSALS the caller reports under that name, never a fallback
 * to a system context: a job that silently escalated past every member's
 * authority is the failure this exists to prevent.
 */
export async function borrowedJobActor(input: {
    tenantId: string;
    /** Restrict to these roles, or omit to consider every ACTIVE member. */
    roles?: Role[];
    /** `createdAt` for "the oldest", `role` for "the most senior" (enum order). */
    orderBy: 'createdAt' | 'role';
    allows: (authority: { permissions: Permissions; appPermissions: PermissionSet }) => boolean;
}): Promise<BorrowedActorOutcome> {
    const candidates = await prisma.tenantMembership.findMany({
        where: {
            tenantId: input.tenantId,
            status: 'ACTIVE',
            ...(input.roles ? { role: { in: input.roles } } : {}),
        },
        // `customRole` is the whole point: without it selected, the resolution
        // below cannot see the role that governs this member.
        select: {
            userId: true,
            role: true,
            customRole: { select: { baseRole: true, permissionsJson: true } },
        },
        orderBy: input.orderBy === 'role' ? { role: 'asc' } : { createdAt: 'asc' },
        take: BORROWED_ACTOR_CANDIDATE_CAP,
    });

    for (const membership of candidates) {
        const authority = initiatorAuthority(membership);
        if (input.allows(authority)) {
            return { actor: { userId: membership.userId, ...authority }, reason: null };
        }
    }
    // An empty candidate list and a list nobody in which qualifies are not the
    // same fact: the first is an empty tenant, the second is a permissions
    // configuration that has locked a job out of a workspace that relies on it.
    return {
        actor: null,
        reason: candidates.length === 0 ? BORROW_FAILURE.NO_ACTIVE_MEMBER : BORROW_FAILURE.NO_QUALIFYING_ACTOR,
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
