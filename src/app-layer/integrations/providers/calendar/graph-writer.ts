/**
 * The Microsoft Graph v1.0 writer (#5937 step 2).
 *
 * Writes only to the signed-in person's default calendar (`/me/events`), under
 * the delegated `Calendars.ReadWrite` they hold. See
 * `docs/calendar-push-design.md`, "The CalendarWriter contract".
 *
 * ═══ GRAPH DOES NOT TAKE A CALLER-CHOSEN EVENT ID ═══
 *
 * Its equivalent is `transactionId`: "a custom identifier specified by a client
 * app for the server to avoid redundant POST operations in case of client
 * retries to create the same event". Every request also sends
 * `Prefer: IdType="ImmutableId"`, so the id Graph returns stays valid when the
 * person moves the event between calendars or folders.
 *
 * ═══ A DUPLICATE transactionId — UNVERIFIED AGAINST A REAL MAILBOX ═══
 *
 * Microsoft's documentation says Graph de-duplicates on `transactionId`; it
 * does not say what the answer to the duplicate POST looks like. This was
 * written WITHOUT access to a real mailbox, so it handles every shape the
 * answer could plausibly take rather than the one it does take:
 *
 *   2xx with an id            → that is the event (the original, or a new one
 *                               if Graph did not de-duplicate after all).
 *   409, or 400 whose error   → the event exists. It is FOUND by the
 *   code names a duplicate      single-value extended property every insert
 *                               carries (`singleValueExtendedProperties`,
 *                               value = our client id), which `$filter` on
 *                               extended properties is documented to support.
 *                               Found → its id. Not found → a per-event
 *                               failure, retried by the next run.
 *
 * Which of these Graph actually answers is an OPEN item of #5937, to be
 * recorded against a real mailbox; see the design note.
 *
 * ═══ THE OTHER ANSWERS ═══
 *
 *   patch   404 → the event is gone; it is created again under
 *                 `recreatedClientEventId(old id)` and the sweep records the
 *                 new id. (An event the person deleted by hand is in Deleted
 *                 Items, where an immutable id may still resolve; what a patch
 *                 there does is unverified for the same reason as above.)
 *   delete  204 → done. 404 / 410 → already gone, also done.
 *
 * ═══ WHAT THE EVENT CARRIES ═══
 *
 * An all-day event on the deadline's date (`isAllDay`, midnight to midnight);
 * the title as `subject`; the detail line and a link as a plain-text `body`;
 * `showAs: free`; `sensitivity: private`; Outlook's default reminder (nothing
 * sent); no attendees, no location.
 *
 * @module integrations/providers/calendar/graph-writer
 */
import type { CalendarWriter } from '@/app-layer/usecases/calendar-reconcile-sweep';
import type { PushableEvent } from '@/app-layer/usecases/calendar-event-reconcile';
import { IntegrationTerminalError } from '../../http-resilience';
import { graphHeaders } from '@/lib/http/graph-headers';
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

const GRAPH = 'https://graph.microsoft.com/v1.0';
const EVENTS_URL = `${GRAPH}/me/events`;

/**
 * The single-value extended property naming the event as Inflect's. A fixed
 * property-set GUID that is Inflect's own; the value is our client event id,
 * which is also what finds the event after a duplicate insert.
 */
export const GRAPH_MARKER_PROPERTY_ID = 'String {8d3c5a1e-4f27-4b9a-9e61-2c7f0b3d5a84} Name inflectEventId';

export function createGraphCalendarWriter(opts: {
    tokens: CalendarAccessTokens;
    deps?: CalendarHttpDeps;
}): CalendarWriter {
    const send = createCalendarSend({
        tokens: opts.tokens,
        authHeaders: (token) => graphHeaders(token, { Prefer: 'IdType="ImmutableId"' }),
        deps: opts.deps,
    });

    async function insert(clientEventId: string, event: PushableEvent): Promise<{ remoteEventId: string }> {
        const res = await send('POST', EVENTS_URL, {
            ...graphEventBody(event),
            transactionId: clientEventId,
            singleValueExtendedProperties: [{ id: GRAPH_MARKER_PROPERTY_ID, value: clientEventId }],
        });
        if (res.ok) return { remoteEventId: await readEventId(res, 'insert') };
        if (res.status === 409 || (res.status === 400 && (await namesDuplicate(res)))) {
            const found = await findByClientEventId(clientEventId);
            if (found) return { remoteEventId: found };
            throw new CalendarWriteError('insert (duplicate not found)', res.status);
        }
        throw new CalendarWriteError('insert', res.status);
    }

    async function findByClientEventId(clientEventId: string): Promise<string | null> {
        // Single quotes inside an OData string literal are doubled. Our ids are
        // hex, so this is belt and braces.
        const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
        const filter =
            `singleValueExtendedProperties/Any(ep: ep/id eq ${literal(GRAPH_MARKER_PROPERTY_ID)}` +
            ` and ep/value eq ${literal(clientEventId)})`;
        const url = `${EVENTS_URL}?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`;
        const res = await send('GET', url);
        if (!res.ok) return null;
        const body = (await res.json().catch(() => null)) as { value?: Array<{ id?: unknown }> } | null;
        const id = body?.value?.[0]?.id;
        return typeof id === 'string' && id.length > 0 ? id : null;
    }

    return {
        insert: ({ clientEventId, event }) => insert(clientEventId, event),

        async patch({ remoteEventId, event }) {
            let res: Response;
            try {
                res = await send('PATCH', eventUrl(remoteEventId), graphEventBody(event));
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
export function graphEventBody(event: PushableEvent): Record<string, unknown> {
    const { date, nextDate } = allDaySpan(event.startsAt);
    return {
        subject: event.title,
        body: { contentType: 'text', content: event.description ?? '' },
        start: { dateTime: `${date}T00:00:00`, timeZone: 'UTC' },
        end: { dateTime: `${nextDate}T00:00:00`, timeZone: 'UTC' },
        isAllDay: true,
        showAs: 'free',
        sensitivity: 'private',
    };
}

/** Does a 400 say "duplicate"? Read from Graph's error CODE only, never its message. */
async function namesDuplicate(res: Response): Promise<boolean> {
    try {
        const body = (await res.clone().json()) as { error?: { code?: unknown } };
        const code = body.error?.code;
        return typeof code === 'string' && /duplicate|transactionid/i.test(code);
    } catch {
        return false;
    }
}
