/**
 * The Google Calendar API v3 writer (#5937 step 2).
 *
 * Writes only to the person's `primary` calendar, under the
 * `calendar.events` scope they granted. See `docs/calendar-push-design.md`,
 * "The CalendarWriter contract".
 *
 * ═══ THE FOUR ANSWERS THAT MATTER ═══
 *
 *   insert  200 → the event's id (which is OUR id: Google accepts a
 *                 caller-chosen id from the base32hex alphabet).
 *           409 → the id is already taken, i.e. a previous attempt created the
 *                 event and died before recording it. The event exists under
 *                 our id, so that IS the remote id. No second event.
 *   patch   404 / 410 → the event is gone from Google entirely. It is created
 *                 again under `recreatedClientEventId(old id)`, and the sweep
 *                 records the new id. A patch also sends `status: confirmed`,
 *                 because an event the person deleted by hand is kept by Google
 *                 as `cancelled` and a patch alone would leave it hidden — the
 *                 design re-creates a hand-deleted event when its deadline
 *                 changes, and on Google that is the patch itself.
 *   delete  204 → done. 404 / 410 → already gone, which is also done.
 *
 * ═══ GOOGLE'S 403 THAT IS NOT A LOST CREDENTIAL ═══
 *
 * Google answers a quota breach as `403` with reason `rateLimitExceeded`,
 * `userRateLimitExceeded` or `quotaExceeded`. The resilient layer turns every
 * 403 into `IntegrationAuthError`, and the push turns THAT into a revoked
 * connection — so a busy morning would disconnect the busiest people. The
 * transport below re-reads a 403 first and hands the layer a 429 for those
 * reasons, which it absorbs or raises as `IntegrationRateLimitedError`.
 *
 * ═══ WHAT THE EVENT CARRIES ═══
 *
 * An all-day event on the deadline's date; the title; a description of the
 * detail line and a link to the item; `transparency: transparent` (shown as
 * free); `visibility: private`; the calendar's default reminders; no
 * attendees, no location. `extendedProperties.private.inflectEventId` marks it
 * as Inflect's so support can tell ours from the person's own; private
 * extended properties are visible only to the calendar's own app access.
 *
 * @module integrations/providers/calendar/google-writer
 */
import type { CalendarWriter } from '@/app-layer/usecases/calendar-reconcile-sweep';
import type { PushableEvent } from '@/app-layer/usecases/calendar-event-reconcile';
import { IntegrationTerminalError } from '../../http-resilience';
import {
    allDaySpan,
    CalendarWriteError,
    createCalendarSend,
    isGoneStatus,
    readEventId,
    recreatedClientEventId,
    type CalendarAccessTokens,
    type CalendarHttpDeps,
} from './calendar-http';

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** The private extended property naming the event as Inflect's. */
export const GOOGLE_MARKER_PROPERTY = 'inflectEventId';

/** Google's 403 reasons that mean "slow down", not "you may not". */
const GOOGLE_QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

export function createGoogleCalendarWriter(opts: {
    tokens: CalendarAccessTokens;
    deps?: CalendarHttpDeps;
}): CalendarWriter {
    const send = createCalendarSend({
        tokens: opts.tokens,
        wrapTransport: googleQuotaAsThrottle,
        deps: opts.deps,
    });

    async function insert(clientEventId: string, event: PushableEvent): Promise<{ remoteEventId: string }> {
        const res = await send('POST', EVENTS_URL, {
            ...googleEventBody(event),
            id: clientEventId,
            extendedProperties: { private: { [GOOGLE_MARKER_PROPERTY]: clientEventId } },
        });
        // A previous attempt created it under this id and never recorded it.
        if (res.status === 409) return { remoteEventId: clientEventId };
        if (!res.ok) throw new CalendarWriteError('insert', res.status);
        return { remoteEventId: await readEventId(res, 'insert') };
    }

    return {
        insert: ({ clientEventId, event }) => insert(clientEventId, event),

        async patch({ remoteEventId, event }) {
            let res: Response;
            try {
                res = await send('PATCH', eventUrl(remoteEventId), { ...googleEventBody(event), status: 'confirmed' });
            } catch (err) {
                if (err instanceof IntegrationTerminalError && isGoneStatus(err.status)) {
                    return insert(recreatedClientEventId(remoteEventId), event);
                }
                throw err;
            }
            if (isGoneStatus(res.status)) return insert(recreatedClientEventId(remoteEventId), event);
            if (!res.ok) throw new CalendarWriteError('update', res.status);
            return { remoteEventId };
        },

        async remove({ remoteEventId }) {
            let res: Response;
            try {
                res = await send('DELETE', eventUrl(remoteEventId));
            } catch (err) {
                // Already gone is what a delete wanted.
                if (err instanceof IntegrationTerminalError && isGoneStatus(err.status)) return;
                throw err;
            }
            if (isGoneStatus(res.status)) return;
            if (!res.ok) throw new CalendarWriteError('delete', res.status);
        },
    };
}

function eventUrl(remoteEventId: string): string {
    return `${EVENTS_URL}/${encodeURIComponent(remoteEventId)}`;
}

/** The fields an insert and a patch both send. */
export function googleEventBody(event: PushableEvent): Record<string, unknown> {
    const { date, nextDate } = allDaySpan(event.startsAt);
    return {
        summary: event.title,
        description: event.description ?? '',
        start: { date },
        end: { date: nextDate },
        transparency: 'transparent',
        visibility: 'private',
        reminders: { useDefault: true },
    };
}

/**
 * Hand the resilient layer a 429 for Google's quota 403s. Every other answer
 * passes through untouched, 403s included.
 */
export function googleQuotaAsThrottle(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
        const res = await inner(input, init);
        if (res.status !== 403) return res;
        const reason = await quotaReason(res.clone());
        if (!reason) return res;
        return new Response(null, { status: 429, headers: res.headers });
    };
}

async function quotaReason(res: Response): Promise<string | null> {
    try {
        const body = (await res.json()) as { error?: { errors?: Array<{ reason?: unknown }> } };
        const reasons = (body.error?.errors ?? []).map((e) => e.reason);
        const hit = reasons.find((r): r is string => typeof r === 'string' && GOOGLE_QUOTA_REASONS.has(r));
        return hit ?? null;
    } catch {
        return null;
    }
}
