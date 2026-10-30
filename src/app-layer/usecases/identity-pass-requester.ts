/**
 * Who an identity pass acts as, decided when it RUNS (#4400).
 *
 * A leaver pass has two ways to start: the 05:00 dispatch, and the "Run now"
 * route an OWNER presses. The route asserts `admin.tenant_lifecycle` and puts
 * the caller's id in the job payload. Until #4400 the pass then built
 * `buildDelegatedJobContext` from that id: an ADMIN-shaped context attributed
 * to the requester, never re-checked. The check happened at ENQUEUE only, so a
 * pass queued by somebody since demoted or removed still ran with full ADMIN,
 * under their name.
 *
 * ═══ WHAT HAPPENS NOW ═══
 *
 * The requester's membership is resolved as a request would resolve it
 * (`resolveMemberContextWithReason`, the resolution `resolveMemberContext`
 * makes). If it is ACTIVE and still holds the key the route asserted, the
 * pass acts with THAT authority: their real role, their custom role, their
 * name on the journal. Nothing here fabricates ADMIN.
 *
 * Otherwise the pass still runs, with the job's own authority, exactly as the
 * scheduled pass does (`buildSystemContext`), and nothing it writes as an actor
 * names the refused person. The execution row says what happened: a manual
 * request by that user id, refused at run time, and why.
 *
 * ═══ WHY A REFUSAL FALLS BACK RATHER THAN STOPPING ═══
 *
 * `resolveMemberContext` says a refusal must never fall back to a system
 * context, because the write would still happen, just anonymously. That rule
 * is about work a refusal would STOP. This is not that work. The pass runs
 * every morning on the job's own authority whatever anybody asks; a request
 * changes only WHEN it runs. A refused requester therefore gets nothing the
 * schedule would not do anyway, and refusing the pass would leave a departed
 * employee's accounts enabled until 05:00 — which this subsystem treats as
 * worse. Owner decision, 2026-10-30.
 *
 * ═══ WHY `buildSystemContext` AND NOT THE TENANT SYSTEM USER ═══
 *
 * `buildTenantSystemJobContext` exists for a job that must write a NOT NULL
 * `User` foreign key (`Task.createdByUserId`). Nothing on the pass's path does:
 * `IntegrationExecution` carries no user column, `IdentityWriteJournal.actorUserId`
 * has no foreign key, the directory-write audit row is written with
 * `userId: null`, and the audit extension maps `SYSTEM_PRINCIPAL` to NULL. So
 * the fallback is the scheduled pass's own context, and a refused manual pass
 * is indistinguishable from the 05:00 one in everything it writes as an actor.
 * The tenant system user would have added a third actor value to the journal,
 * created a `User` row nothing needs, and read as `manual` to any check that
 * compares a context's user id with `SYSTEM_PRINCIPAL`.
 *
 * ═══ `triggeredBy` IS READ OFF THE REQUEST, NOT THE CONTEXT ═══
 *
 * The pass used to derive it from `ctx.userId !== SYSTEM_PRINCIPAL`. With the
 * fallback, a manual request can run under a system context, and that check
 * would record it as `scheduled`. So it travels on `PassTrigger`, decided here
 * once, from whether anybody asked.
 *
 * Worker-safe: imports `context-system` and `permission-key`, never anything
 * that reaches `@/lib/auth`.
 *
 * @module usecases/identity-pass-requester
 */
import type { MembershipStatus } from '@prisma/client';

import { buildSystemContext, resolveMemberContextWithReason } from '../context-system';
import type { RequestContext } from '../types';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-key';
import { logger } from '@/lib/observability/logger';
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';

/**
 * The key the "Run now" routes assert, asked again when the pass runs.
 *
 * The routes spell it literally inside `requirePermission(...)`, which is the
 * form the permission guardrail reads, so the two are held equal by
 * `tests/unit/identity-pass-requester.test.ts` against the route-permission map
 * rather than by a shared import.
 */
export const PASS_REQUEST_PERMISSION: PermissionKey = 'admin.tenant_lifecycle';

/**
 * Why a requester's authority was refused at run time.
 *
 *   REQUESTER_NOT_A_MEMBER      no membership row: removed from the tenant
 *                               (`removeTenantMember` deletes the row).
 *   REQUESTER_NOT_ACTIVE        a row whose status is not ACTIVE
 *                               (deactivated, invited, removed); the status
 *                               is recorded beside it.
 *   REQUESTER_LACKS_PERMISSION  an active member who no longer holds
 *                               `PASS_REQUEST_PERMISSION`: demoted, or a
 *                               custom role that withholds it.
 *   REQUESTER_UNRESOLVED        the membership could not be read. The pass is
 *                               contracted never to throw, and authority that
 *                               cannot be confirmed is not authority.
 */
export type PassRequesterRefusal =
    | 'REQUESTER_NOT_A_MEMBER'
    | 'REQUESTER_NOT_ACTIVE'
    | 'REQUESTER_LACKS_PERMISSION'
    | 'REQUESTER_UNRESOLVED';

/** How a pass was started, and whose authority it carries. Decided once. */
export type PassTrigger =
    | { readonly triggeredBy: 'scheduled' }
    | {
          readonly triggeredBy: 'manual';
          readonly requestedByUserId: string;
          /** The requester's own membership, which still holds the key. */
          readonly authority: 'REQUESTER';
      }
    | {
          readonly triggeredBy: 'manual';
          readonly requestedByUserId: string;
          /** The job's own, because the requester's was refused. */
          readonly authority: 'JOB';
          readonly refusal: PassRequesterRefusal;
          /** Set only with `REQUESTER_NOT_ACTIVE`. */
          readonly membershipStatus?: MembershipStatus;
      };

export interface PassActor {
    readonly ctx: RequestContext;
    readonly trigger: PassTrigger;
}

/**
 * Resolve the context a pass runs under. Never throws.
 *
 * A blank `requestedByUserId` is nobody: `''` is a string, and reading it as a
 * person would record a manual run that no person asked for.
 */
export async function resolvePassActor(input: {
    tenantId: string;
    /** `identity-leaver-pass` / `identity-joiner-pass`, for the request id. */
    job: string;
    requestedByUserId?: string;
}): Promise<PassActor> {
    const jobCtx = (): RequestContext => buildSystemContext({ tenantId: input.tenantId, job: input.job });
    const requester = input.requestedByUserId;
    if (!requester) return { ctx: jobCtx(), trigger: { triggeredBy: 'scheduled' } };

    const refused = (
        refusal: PassRequesterRefusal,
        membershipStatus?: MembershipStatus,
    ): PassActor => {
        // A log line as well as the row, because two refusals of the pass
        // itself (the ladder's) write no row at all, and the refusal of a
        // person's authority must not vanish with them. Counts and enums only:
        // this line is neither encrypted nor tenant-scoped.
        logger.warn('identity pass requester refused at run time; running on the job’s own authority', {
            component: 'identity-pass-requester',
            tenantId: input.tenantId,
            job: input.job,
            refusal,
            ...(membershipStatus ? { membershipStatus } : {}),
        });
        return {
            ctx: jobCtx(),
            trigger: {
                triggeredBy: 'manual',
                requestedByUserId: requester,
                authority: 'JOB',
                refusal,
                ...(membershipStatus ? { membershipStatus } : {}),
            },
        };
    };

    let resolved: Awaited<ReturnType<typeof resolveMemberContextWithReason>>;
    try {
        resolved = await resolveMemberContextWithReason({
            tenantId: input.tenantId,
            userId: requester,
            job: input.job,
        });
    } catch (err) {
        logger.error('identity pass requester could not be resolved', {
            component: 'identity-pass-requester',
            tenantId: input.tenantId,
            job: input.job,
            error: redactDirectoryIdentifiers(err instanceof Error ? err.message : String(err), undefined),
        });
        return refused('REQUESTER_UNRESOLVED');
    }

    if (!resolved.ok) {
        return resolved.reason === 'NOT_A_MEMBER'
            ? refused('REQUESTER_NOT_A_MEMBER')
            : refused('REQUESTER_NOT_ACTIVE', resolved.status);
    }
    if (!hasPermission(resolved.ctx.appPermissions, PASS_REQUEST_PERMISSION)) {
        return refused('REQUESTER_LACKS_PERMISSION');
    }
    return {
        // `actorType: 'JOB'`: a job did this, for this person. The audit trail
        // must not read a queued pass as a request they made by hand.
        ctx: { ...resolved.ctx, actorType: 'JOB' },
        trigger: { triggeredBy: 'manual', requestedByUserId: requester, authority: 'REQUESTER' },
    };
}

/**
 * The block a pass's execution row carries about its request, or `undefined`
 * for a scheduled pass, whose row is unchanged.
 *
 * The requester's id is here in both manual cases. That is the record of who
 * ASKED, which the route's `IDENTITY_*_PASS_REQUESTED` audit row already holds;
 * it is not attribution of what the pass did. `authority` says whose authority
 * the pass carried, and a refusal says why it was not theirs.
 */
export function passRequestRecord(trigger: PassTrigger): Record<string, string> | undefined {
    if (trigger.triggeredBy === 'scheduled') return undefined;
    if (trigger.authority === 'REQUESTER') {
        return { requestedByUserId: trigger.requestedByUserId, authority: 'REQUESTER' };
    }
    return {
        requestedByUserId: trigger.requestedByUserId,
        authority: 'JOB',
        refusal: trigger.refusal,
        ...(trigger.membershipStatus ? { membershipStatus: trigger.membershipStatus } : {}),
    };
}
