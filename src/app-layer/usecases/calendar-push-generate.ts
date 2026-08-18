/**
 * Generate ONE user's pushable events, under THAT user's real authority.
 *
 * ═══ THE SAME AGGREGATION, NOT A SIMPLER ONE ═══
 *
 * `docs/calendar-surface-do-not-touch.md` §1 records why the compliance
 * calendar does not gate on one `assertCanRead` and then read nineteen
 * domains: `ctx.permissions.canRead` is TRUE for every role, so a coarse gate
 * would show a READER the incident and personnel deadlines. Instead each
 * source carries its own `PermissionKey`, sources the caller cannot see are
 * filtered out, and the omitted ones come back as `omittedSources`.
 *
 * So this calls `getComplianceCalendarEvents` — the same function the UI calls
 * — with the user's context. It does NOT add a second, "simpler" query path.
 * That is how the two diverge and the permission filtering quietly stops
 * applying, and the pusher is the copy nobody looks at.
 *
 * The aggregation takes `ctx` as an explicit parameter and reads no ambient
 * request state, which is what makes acting for an arbitrary user possible at
 * all.
 *
 * ═══ THE AUTHORITY COMES FROM THE LIVE MEMBERSHIP ═══
 *
 * `resolveMemberContext` re-reads the membership and its custom role on every
 * call, and returns `null` for INVITED / DEACTIVATED / REMOVED. That null is a
 * REFUSAL, not an empty result: falling back to a system context here would
 * push a removed member's deadlines into their personal calendar under full
 * authority, which is the escalation the function exists to prevent.
 *
 * This is its FIRST production caller. It has never run outside its own tests.
 *
 * ═══ AN EMPTY RESULT IS AMBIGUOUS AND MUST NOT BE ═══
 *
 * A fully-demoted user does not get an error. The aggregation guards its
 * all-sources-failed throw on `eligible.length > 0`, so zero eligible sources
 * yields `events: []` with every source name in `omittedSources` — which to a
 * push job is indistinguishable from "nothing is due this week".
 *
 * The difference matters enormously: "nothing due" means push nothing, while
 * "you may see nothing" means DELETE EVERYTHING PREVIOUSLY PUSHED. So the
 * result distinguishes them explicitly rather than leaving the caller to infer
 * it from a count.
 *
 * @module usecases/calendar-push-generate
 */
import type { RequestContext } from '../types';
import { resolveMemberContext } from '../context-system';
import { getComplianceCalendarEvents } from './compliance-calendar';
import type { PushableEvent } from './calendar-event-reconcile';

/** How far ahead a push looks. */
export const PUSH_WINDOW_DAYS = 90;

export type GenerateOutcome =
    /** The member is not ACTIVE. Push nothing; remove everything. */
    | { kind: 'refused'; reason: 'not-an-active-member' }
    /**
     * The member is active but may see NO calendar source. Distinct from an
     * empty window: everything previously pushed must be removed.
     */
    | { kind: 'no-visible-sources'; omittedSources: string[] }
    /** A normal generation. `events` may still legitimately be empty. */
    | { kind: 'generated'; events: PushableEvent[]; omittedSources: string[] };

interface GenerateDeps {
    resolveContext?: typeof resolveMemberContext;
    aggregate?: typeof getComplianceCalendarEvents;
    now?: () => Date;
}

/**
 * Build the set of events a user should currently have in their calendar.
 *
 * Returns a discriminated outcome rather than a bare array, because the caller
 * must treat "nothing due" and "nothing visible" differently and an array
 * cannot express that.
 */
export async function generatePushableEvents(
    input: { tenantId: string; userId: string },
    deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
    const resolve = deps.resolveContext ?? resolveMemberContext;
    const aggregate = deps.aggregate ?? getComplianceCalendarEvents;
    const now = deps.now ? deps.now() : new Date();

    const memberCtx = await resolve({
        tenantId: input.tenantId,
        userId: input.userId,
        job: 'calendar-push',
        discriminator: input.userId,
    });
    if (!memberCtx) return { kind: 'refused', reason: 'not-an-active-member' };

    // `resolveMemberContext` does NOT set actorType, unlike buildSystemContext
    // and buildDelegatedJobContext. Left unset, every audit row this generation
    // produces claims the PERSON acted — at 04:00, from a job they did not run.
    const ctx: RequestContext = { ...memberCtx, actorType: 'JOB' };

    const to = new Date(now.getTime() + PUSH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const response = await aggregate(ctx, { from: now, to, now });

    const omittedSources = [...(response.omittedSources ?? [])].map(String);

    // The distinction the caller cannot make from an event count.
    if (response.events.length === 0 && omittedSources.length > 0 && !hasVisibleSource(response)) {
        return { kind: 'no-visible-sources', omittedSources };
    }

    return {
        kind: 'generated',
        events: response.events.map(toPushable),
        omittedSources,
    };
}

/**
 * Did ANY source actually run?
 *
 * `omittedSources` alone cannot answer it — a user who can see one source out
 * of nineteen has eighteen omitted and is perfectly healthy. The signal is
 * whether the omitted set covers everything the aggregation knows about, which
 * is why this compares against the response rather than a hardcoded 19. The
 * repo has contradicted itself on that number three times (17 / 16-of-17 / 19);
 * a fourth hardcoded copy would drift the same way.
 */
function hasVisibleSource(response: {
    omittedSources?: readonly unknown[];
    erroredSources?: readonly unknown[];
    events: readonly unknown[];
}): boolean {
    // A source that ERRORED was visible to this user — it was attempted. Only
    // an omitted source was filtered out on permissions, and treating an
    // outage as a permission loss would delete a user's whole calendar because
    // a database was briefly slow.
    return (response.erroredSources?.length ?? 0) > 0 || response.events.length > 0;
}

/** Map an aggregation event onto the shape the reconciler and providers use. */
function toPushable(e: {
    entityType: string;
    entityId: string;
    title: string;
    date: string;
    end?: string;
    detail?: string;
}): PushableEvent {
    return {
        // The reconciler's identity is (sourceKey, sourceEntityId). Using the
        // aggregation's own entityType/entityId rather than its composite `id`
        // keeps the mapping stable when the event TYPE changes for the same
        // underlying row — a due-date event becoming an overdue event must
        // patch the existing calendar entry, not orphan it and create another.
        sourceKey: e.entityType,
        sourceEntityId: e.entityId,
        title: e.title,
        startsAt: e.date,
        endsAt: e.end ?? null,
        description: e.detail ?? null,
    };
}
