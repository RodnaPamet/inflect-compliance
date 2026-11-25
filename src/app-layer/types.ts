import type { Role, OrgRole } from '@prisma/client';
import type { PermissionSet, OrgPermissionSet } from '@/lib/permissions';
import type { ActorType } from '@/lib/audit/types';

export interface RequestContext {
    /** Unique request identifier for log correlation */
    requestId: string;

    /** The authenticated user ID */
    userId: string;

    /**
     * What KIND of actor this context represents. Absent means `'USER'`,
     * which is what every HTTP-borne context is.
     *
     * Background jobs and platform sweeps have no signed-in user. They
     * used to satisfy `userId: string` with the literal `'system'` and
     * their audit rows were then written as `actorType: 'USER'` — so the
     * trail claimed a person did something no person did, and there was
     * no way to filter machine activity out of a review.
     *
     * `logEvent` forwards this to `appendAuditEntry`, which defaults an
     * absent value to `'USER'`. Set `'JOB'` for scheduled work and `'SYSTEM'`
     * for middleware-driven writes; leave it unset for anything a signed-in
     * user asked for. `verifyApiKey` sets `'API_KEY'` on every context it
     * builds, so a key's writes never read as its creator's (#5786).
     */
    actorType?: ActorType;

    /** The resolved tenant ID */
    tenantId: string;

    /** The resolved tenant slug (if available from route) */
    tenantSlug?: string;

    /** The effective role of the user within this tenant */
    role: Role;

    /**
     * The role on the caller's OWN membership row, before any custom role.
     * `role` above is a custom role's base when the membership carries one;
     * this is what the edge's admin gate reads (`checkAdminAccess`), so the
     * admin page gate reads it too (#4581 B). Set on the session paths of
     * `getTenantCtx` / `getLegacyCtx`; absent for an API key, which has no
     * membership. It is not an authority for anything else.
     */
    membershipRole?: Role;

    /** Effective permissions derived from the role */
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };

    /** Granular UI permission set — custom role–aware when customRoleId is present */
    appPermissions: PermissionSet;

    /** Present when the request was authenticated via API key (M2M) */
    apiKeyId?: string;

    /** Scopes granted to the API key (e.g. ["controls:read", "evidence:write"]) */
    apiKeyScopes?: string[];

    /**
     * The registered agent this request speaks for, resolved from the API key's
     * `agentId` binding. Absent means the caller is not an agent — an ordinary
     * integration key, or a signed-in human.
     *
     * ABSENCE IS NOT PERMISSION. `/api/mcp` refuses an absent value when the
     * tenant has `requireRegisteredAgent` on, and the agentic write seams record
     * it as `null` rather than guessing, so an unattributed row stays visibly
     * unattributed. Nothing may read this as "some agent".
     */
    agentId?: string;

    /**
     * The `INVOKE_AGENT` recursion depth of the run this context belongs to
     * (#5716), or absent for every context no automation rule invoked.
     *
     * `MAX_AGENT_INVOKE_DEPTH` is read off the job payload by
     * `agent-invoke-dispatch`, and nothing wrote the number it reads: a run did
     * not record its depth and the automation events its effects caused carried
     * none, so every invoke arrived at depth 1 and `depth_exceeded` could not
     * trip through a real cycle. This is the carrier — the bus stamps it onto
     * every event emitted under this context, and `invokeAgent` enqueues one
     * higher.
     *
     * ABSENT IS DEPTH ZERO, deliberately: an event no agent run caused is the
     * common case and must keep behaving exactly as before.
     */
    agentInvokeDepth?: number;

    /**
     * `TenantApiKey.maxAutonomyLevel` — the highest rung on the 0-6 agent
     * ladder this CREDENTIAL may drive its agent to.
     *
     * ABSENT MEANS NO KEY-LEVEL NARROWING, not "deny" and not "unlimited": the
     * effective ceiling is the minimum of this and the agent's own registered
     * `autonomyLevel`, so an absent term still leaves the agent's own bound in
     * force. See `src/lib/agentic/autonomy-ceiling.ts`, which states this
     * beside the OPPOSITE convention for an unscored `riskTier` — the two nulls
     * mean different things and reading either like the other is the hazard.
     */
    apiKeyMaxAutonomy?: number | null;

    /**
     * `TenantApiKey.requiresTokenExchange` (#5004): this credential may reach
     * `/api/mcp` only through an audience-scoped token exchanged for it, never
     * presented directly. Read by `completeMcpAuthentication` and, because a
     * run's tool calls carry no audience, by `startWorkflowRun`; absent on a
     * session context and on a key that does not require it.
     */
    apiKeyRequiresTokenExchange?: boolean;

    /**
     * Set when this context belongs to a RUN AN A2A PEER STARTED (#3679): the
     * peer, and the verified inbound message that started it.
     *
     * Set by the inbound A2A endpoint alone, written onto the run's write-once
     * `WorkflowRun.inboundPeerId` / `inboundMessageId` at creation, and
     * restored from those columns by `executeFrom` for every segment — a
     * start, a person's resume and a queued Flue segment alike. Two owner rules read it: such a run never dispatches an
     * external write above `PROPOSE_ONLY` (threat-model R17,
     * `clampForInboundA2a`), and never sends an outbound A2A task (R14). It
     * grants nothing; it only ever narrows.
     */
    a2aInbound?: A2aInboundOrigin;

    /**
     * Set on the context a READ-ONLY run's tools execute on (#5365): a run whose
     * definition declares `readOnly` — a Test run of an agent profile, an Ask
     * run, a Flue workflow with no PROPOSE step.
     *
     * Set by `offerToolSet` alone, on the invocation its `run` closures are
     * bound to, because that is the one seam every engine's tool calls pass
     * through and it already receives the definition's `readOnly`. The offer
     * withholds every write-classified external tool and every A2A send from
     * such a run; this is the BACKSTOP behind that: the external write
     * dispatch and the A2A send refuse with nothing sent and no row written
     * when it is set. It grants nothing; it only ever narrows.
     */
    readOnlyRun?: true;

    /**
     * The attempt token of the run lease THIS execution holds (#5854 finding
     * 2), set by `executeQueuedWorkflowRun` once its claim succeeded and
     * absent on every other context: a request, an inline static run, a job.
     *
     * It is a FENCE. While it is set, `updateRun` and `recordStep` write only
     * while the run row still names this token, and `isRunAborted` reads a run
     * held by somebody else as stopped, so a worker that lost the run (another
     * worker claimed it after the lease lapsed, or the SIGTERM drain paused
     * it) stops at its next check and writes nothing more. It grants nothing;
     * it only ever narrows. Absent, every one of those behaves exactly as it
     * did before the lease existed.
     */
    runLeaseToken?: string;
    /**
     * WHERE THE QUEUED SEGMENT THIS EXECUTION BELONGS TO BEGAN in the run's
     * ledger (#5854, owner decision 2026-11-25), set by
     * `executeQueuedWorkflowRun` from the segment anchor for an engine whose
     * recovery is `SESSION` (Managed Agents), and absent on every other
     * context. A first attempt reads its own `fromSeq` here, so it finds
     * nothing of its own in the ledger; a retry or a lease takeover reads the
     * first attempt's, and the engine reconnects to the session that segment
     * recorded there. It grants nothing: it only says which steps are this
     * segment's.
     *
     * A person's resume of a PAUSED run (the owner's second decision of
     * 2026-11-25) reads the PAUSED segment's start here, not its own: its
     * segment continues the paused one, and reconnects to the session the
     * paused segment left open.
     */
    runSegmentFromSeq?: number;
    /**
     * This execution's segment continues a PAUSED segment (a person's resume),
     * rather than being a first attempt or a retry of its own, and whether the
     * resume came in time for the paused session (`IN_TIME`) or after the
     * window in which a resume may reconnect to it (`TOO_LATE`: the engine
     * refuses the run by name and settles the session). Set beside
     * `runSegmentFromSeq`, only then. It grants nothing.
     */
    runSegmentContinuesPause?: 'IN_TIME' | 'TOO_LATE';
}

/**
 * Which third-party principal started a run, when one did (#3861).
 *
 * A UNION rather than a widened object, so a caller cannot build a half-origin:
 * `{ kind: 'PEER' }` without a `peerId` does not compile. The two arms are
 * deliberately not interchangeable in the type, and deliberately identical in
 * effect — every consumer of this field tests only whether it is SET:
 *
 *   · `external-tools.ts` → `clampForInboundA2a(mode, Boolean(ctx.a2aInbound))`
 *   · `a2a-outbound.ts`   → `if (ctx.a2aInbound) return []`, and again at the call
 *
 * That is why admitting a second principal does not weaken R17 or R14: the
 * narrowings were never keyed on which principal it was. Anything added here
 * that branches on `kind` to decide HOW MUCH to narrow would break that
 * property, and is the thing to refuse in review.
 */
export type A2aInboundOrigin =
    | { readonly kind: 'PEER'; readonly peerId: string; readonly messageId: string }
    | { readonly kind: 'HOST_CONSUMER'; readonly hostConsumerId: string; readonly messageId: string };

export interface PaginatedResult<T> {
    data: T[];
    metadata: {
        total: number;
        page: number;
        limit: number;
        hasMore: boolean;
    };
}

/**
 * Hub-and-spoke organization request context (Epic O-2).
 *
 * Resolved by `getOrgCtx({ orgSlug }, req)` for routes under
 * `/api/org/[orgSlug]/*`. Distinct from `RequestContext` (which is
 * tenant-scoped) — a single request resolves to ONE of the two,
 * never both. Drill-down from portfolio → tenant detail re-resolves
 * as `RequestContext` via the auto-provisioned AUDITOR membership,
 * where the existing per-tenant permission system takes over.
 *
 * `permissions` is derived from `orgRole` via `getOrgPermissions(...)`
 * at resolution time so callers can read flags directly without an
 * extra helper call. This mirrors how `RequestContext.permissions` /
 * `appPermissions` are pre-derived.
 */
export interface OrgContext {
    /** Unique request identifier for log correlation */
    requestId: string;

    /** The authenticated user ID */
    userId: string;

    /** The resolved organization ID */
    organizationId: string;

    /** The resolved organization slug (from the route) */
    orgSlug: string;

    /** The user's role within this organization */
    orgRole: OrgRole;

    /** Pre-derived org permission flags */
    permissions: OrgPermissionSet;
}
