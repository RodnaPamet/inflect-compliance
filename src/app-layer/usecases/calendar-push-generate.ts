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
 * ═══ ONLY THE PERSON'S OWN DEADLINES (owner decision 2026-11-25) ═══
 *
 * An OWNER or ADMIN can see every deadline in the workspace; pushing all of
 * them would put hundreds of other people's tasks into one personal calendar,
 * and send them to Google or Microsoft. So a deadline is pushed only when the
 * person is its owner or assignee — the calendar page's "My deadlines"
 * semantics, `ownerUserId === userId`, applied by the aggregation itself
 * (`ownedBy`). `training` carries no owner (do-not-touch §6) and is never
 * pushed. The per-source permission gate still runs first: owning a deadline
 * in a source the person may not see does not push it.
 *
 * ═══ ONLY WHAT IS STILL TO DO (owner decision 2026-11-25) ═══
 *
 * A deadline whose item is finished (`status === 'done'`) is not pushed, and
 * one already pushed is removed at the next run. It is still counted as
 * visible: a person whose deadlines are all done may still see their sources,
 * which is not the `no-visible-sources` case.
 *
 * ═══ THE WORKSPACE'S LANGUAGE (owner decision 2026-11-25) ═══
 *
 * The product's own wording — "Evidence review:", the link line — is written
 * in `Tenant.defaultLocale` through the `workspaceText.calendarPush`
 * catalogue. A job sees no browser cookie, and the person who reads the event
 * is reading the workspace's record. Titles of the items themselves are the
 * workspace's own text and go as written.
 *
 * @module usecases/calendar-push-generate
 */
import type { RequestContext } from '../types';
import { resolveMemberContext } from '../context-system';
import { getComplianceCalendarEvents, calendarSourceTypes } from './compliance-calendar';
import type { PushableEvent } from './calendar-event-reconcile';
import type { CalendarEvent, CalendarSourceName } from '../schemas/calendar.schemas';
import { DEFAULT_LOCALE, type Locale } from '@/lib/locale-constants';
import { workspaceTranslator } from '@/lib/i18n/workspace-text';

/** How far ahead a push looks. */
export const PUSH_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The catalogue namespace for the product's own wording in a pushed event. */
export const CALENDAR_PUSH_TEXT_NAMESPACE = 'workspaceText.calendarPush';

export type GenerateOutcome =
    /** The member is not ACTIVE. Push nothing; remove everything. */
    | { kind: 'refused'; reason: 'not-an-active-member' }
    /**
     * The member is active but may see NO calendar source. Distinct from an
     * empty window: everything previously pushed must be removed.
     */
    | { kind: 'no-visible-sources'; omittedSources: string[] }
    /**
     * A normal generation. `events` may still legitimately be empty.
     *
     * `held` names what this generation could NOT vouch for: the event types of
     * sources that failed or hit their cap (`sourceKeys`), or everything when
     * the aggregation's total cap bit (`all`). An event absent from such a
     * source may simply not have been read, so its calendar entry must not be
     * deleted tonight and re-created tomorrow.
     */
    | {
          kind: 'generated';
          events: PushableEvent[];
          omittedSources: string[];
          held?: { sourceKeys: string[]; all: boolean };
      };

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
    input: {
        tenantId: string;
        userId: string;
        /** The workspace's default language. Absent reads as the default locale. */
        locale?: Locale;
        /** The deployment's public origin. Absent or null: no link line. */
        publicOrigin?: string | null;
    },
    deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
    const resolve = deps.resolveContext ?? resolveMemberContext;
    const aggregate = deps.aggregate ?? getComplianceCalendarEvents;
    const now = deps.now ? deps.now() : new Date();
    const locale = input.locale ?? DEFAULT_LOCALE;

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

    // The window starts at the START OF TODAY (UTC), not at `now`. Day deadlines
    // are stored at UTC midnight, so a window from `now` — the job runs at
    // 03:00 — would drop today's deadlines and delete them from the person's
    // calendar on the very day they fall due.
    const from = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
    const to = new Date(from.getTime() + PUSH_WINDOW_DAYS * DAY_MS);
    const response = await aggregate(ctx, { from, to, now, ownedBy: input.userId, locale });

    const omittedSources = [...(response.omittedSources ?? [])].map(String);
    const failedSources = [...(response.failedSources ?? [])];
    const cappedSources = [...(response.truncation?.sources ?? [])];

    // The distinction the caller cannot make from an event count. A source that
    // FAILED was visible — it was attempted — so an outage is never read as a
    // lost permission, which would delete the person's whole calendar because a
    // database was briefly slow.
    if (response.events.length === 0 && omittedSources.length > 0 && failedSources.length === 0) {
        return { kind: 'no-visible-sources', omittedSources };
    }

    const linkLine = await linkLineWriter(locale, input.publicOrigin ?? null);
    const heldSources = [...new Set<CalendarSourceName>([...failedSources, ...cappedSources])];
    const held =
        heldSources.length > 0 || response.truncation?.totalCapped
            ? {
                  sourceKeys: heldSources.flatMap((name) => [...calendarSourceTypes(name)]),
                  all: response.truncation?.totalCapped === true,
              }
            : undefined;

    return {
        kind: 'generated',
        // A finished deadline leaves the calendar (owner decision 2026-11-25):
        // the calendar shows what is still to do. Dropping it from the set is
        // enough; the reconcile removes an event that is no longer generated.
        events: response.events.filter((e) => e.status !== 'done').map((e) => toPushable(e, linkLine)),
        omittedSources,
        ...(held ? { held } : {}),
    };
}

/**
 * The description's link line, in the workspace's language, or nothing.
 *
 * An event in somebody's calendar is read outside Inflect, so a relative link
 * is useless there: with no configured public origin (`APP_URL`) there is no
 * link line at all rather than a broken one.
 */
async function linkLineWriter(
    locale: Locale,
    publicOrigin: string | null,
): Promise<(href: string) => string | null> {
    if (!publicOrigin) return () => null;
    const origin = publicOrigin.replace(/\/+$/, '');
    const t = await workspaceTranslator(locale, CALENDAR_PUSH_TEXT_NAMESPACE);
    return (href) => (href.startsWith('/') ? t('openInInflect', { link: `${origin}${href}` }) : null);
}

/** Map an aggregation event onto the shape the reconciler and providers use. */
function toPushable(
    e: Pick<CalendarEvent, 'type' | 'entityId' | 'title' | 'date' | 'end' | 'detail' | 'href'>,
    linkLine: (href: string) => string | null,
): PushableEvent {
    const link = e.href ? linkLine(e.href) : null;
    const description = [e.detail, link].filter((part): part is string => !!part && part.length > 0).join('\n\n');
    return {
        // The reconciler's identity is (sourceKey, sourceEntityId). The event
        // TYPE, not the entity type, is the key: one row can carry two
        // deadlines — a risk's review date and its target date, a vendor's
        // review and its contract renewal — and keyed on the entity they would
        // share one calendar event and overwrite each other every night. A type
        // names a deadline column and never changes for the same row; the
        // composite `id` is not used because its format is the page's, not a
        // contract.
        sourceKey: e.type,
        sourceEntityId: e.entityId,
        title: e.title,
        startsAt: e.date,
        endsAt: e.end ?? null,
        description: description.length > 0 ? description : null,
    };
}
