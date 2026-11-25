/**
 * One log line per vendor answer the calendar push's open items depend on
 * (#5957).
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Several behaviours of Graph, Entra and Google were built from documentation,
 * with no account to observe them against (`docs/calendar-push-design.md`,
 * "Roadmap → Step 2 / Step 3 — open items"). The owner runs the real-account
 * steps (`docs/runbooks/calendar-vendor-verification.md`); this line is what
 * those steps leave behind, and the `calendar-observations` VM check counts it.
 * Nobody reads a raw log to answer an open item.
 *
 * ═══ WHAT THE LINE CARRIES, AND NOTHING ELSE ═══
 *
 * The message is `calendar.vendor_observation` and the fields are exactly
 * `provider`, `operation`, `status`, `code` and, on an insert, `dateShape`.
 * Every value is from a closed vocabulary or is shape-checked here before it is
 * written:
 *
 *   operation  a member of `CALENDAR_VENDOR_OPERATIONS`
 *   status     an HTTP status, or null (a redirect carries none)
 *   code       a provider's machine error code (Graph's `error.code`, Google's
 *              `reason`, OAuth's `error`) or an `AADSTS<digits>` number — only
 *              when it has a code's shape; never a message or a description
 *   dateShape  what Graph or Google echoed back for an all-day event's start,
 *              as a SHAPE relative to the date we sent — never the date
 *
 * No tenant, person, email, title, event id, token, authorization code or URL.
 *
 * ═══ WHY A CHILD LOGGER ═══
 *
 * `logger.info` enriches every line with the ambient request context
 * (`requestId`, `tenantId`, `userId`). That is right for an application log and
 * wrong here: the observation must be countable without naming who it came
 * from, so it is written through a child logger with no bindings, which adds
 * only pino's own `level`, `time`, `pid` and `hostname`.
 *
 * Writing it never throws: an observation is evidence about a vendor, and its
 * loss must not fail a push or a sign-in.
 *
 * @module integrations/providers/calendar/vendor-observation
 */
import { createChildLogger } from '@/lib/observability';

/** The message every observation is written under. The VM check greps for it. */
export const CALENDAR_VENDOR_OBSERVATION = 'calendar.vendor_observation';

/**
 * What answered, and to what.
 *
 *   graph.insert                 a Graph create answered as a NEW event (2xx),
 *                                or refused with anything but a duplicate
 *   graph.insert_existing        a Graph create answered 2xx with an event Graph
 *                                had created EARLIER — its `createdDateTime` is
 *                                more than `EXISTING_EVENT_AGE_MS` before the
 *                                answer: Graph de-duplicated on transactionId
 *   graph.insert_duplicate       a Graph create answered 409, or 400 coded as a
 *                                duplicate
 *   graph.duplicate_found        the marker lookup after a duplicate found it
 *   graph.duplicate_not_found    the marker lookup after a duplicate did not
 *   graph.patch                  every Graph patch answer (a 404/410 is the
 *                                event gone; it is then created again)
 *   google.insert                every Google create answer
 *   entra.admin_consent_error    an error on the `/adminconsent` redirect
 *   entra.personal_consent_error an error on a person's Outlook sign-in redirect
 *   entra.exchange_error         a refused Outlook code exchange
 */
export const CALENDAR_VENDOR_OPERATIONS = [
    'graph.insert',
    'graph.insert_existing',
    'graph.insert_duplicate',
    'graph.duplicate_found',
    'graph.duplicate_not_found',
    'graph.patch',
    'google.insert',
    'entra.admin_consent_error',
    'entra.personal_consent_error',
    'entra.exchange_error',
] as const;
export type CalendarVendorOperation = (typeof CALENDAR_VENDOR_OPERATIONS)[number];

/** Where an answer came from. */
export type CalendarVendorProvider = 'graph' | 'google' | 'entra';

const PROVIDER_OF: Readonly<Record<CalendarVendorOperation, CalendarVendorProvider>> = {
    'graph.insert': 'graph',
    'graph.insert_existing': 'graph',
    'graph.insert_duplicate': 'graph',
    'graph.duplicate_found': 'graph',
    'graph.duplicate_not_found': 'graph',
    'graph.patch': 'graph',
    'google.insert': 'google',
    'entra.admin_consent_error': 'entra',
    'entra.personal_consent_error': 'entra',
    'entra.exchange_error': 'entra',
};

/**
 * Where the start date an all-day insert's answer echoes lands, against the
 * date we sent:
 *
 *   same_date        the same calendar date
 *   shifted_back     an earlier date (e.g. midnight moved into the previous day)
 *   shifted_forward  a later date
 *   unreadable       the answer carried no start we could read
 */
export const ALL_DAY_DATE_SHAPES = ['same_date', 'shifted_back', 'shifted_forward', 'unreadable'] as const;
export type AllDayDateShape = (typeof ALL_DAY_DATE_SHAPES)[number];

/** A machine code: letters, digits, `_`, `.`, `-`; never prose. */
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface CalendarVendorObservation {
    operation: CalendarVendorOperation;
    /** The HTTP status of the answer; null when there was none (a redirect). */
    status: number | null;
    /** A machine error code or an AADSTS number; anything not code-shaped is dropped. */
    code?: string | null;
    /** For an all-day insert's answer only. */
    dateShape?: AllDayDateShape;
}

/** The exact record written. Built field by field, so nothing else can ride along. */
export function calendarVendorObservationFields(obs: CalendarVendorObservation): Record<string, unknown> {
    const status = typeof obs.status === 'number' && Number.isInteger(obs.status) && obs.status >= 100 && obs.status <= 599 ? obs.status : null;
    const code = typeof obs.code === 'string' && CODE_SHAPE.test(obs.code) ? obs.code : null;
    const fields: Record<string, unknown> = {
        provider: PROVIDER_OF[obs.operation],
        operation: obs.operation,
        status,
        code,
    };
    if (obs.dateShape !== undefined && (ALL_DAY_DATE_SHAPES as readonly string[]).includes(obs.dateShape)) {
        fields.dateShape = obs.dateShape;
    }
    return fields;
}

/** Write one observation. Never throws. */
export function observeCalendarVendor(obs: CalendarVendorObservation): void {
    try {
        createChildLogger({}).info(calendarVendorObservationFields(obs), CALENDAR_VENDOR_OBSERVATION);
    } catch {
        // An observation is evidence, not work: losing one fails nothing.
    }
}

/**
 * Compare the start date an insert's answer echoed with the one we sent.
 *
 * `echoed` is the provider's start: Graph's `{ dateTime, timeZone }` (answered
 * in UTC, its default when no `Prefer: outlook.timezone` is sent — and this
 * writer sends none) or Google's `{ date }` / `{ dateTime }`. Only the leading
 * `YYYY-MM-DD` is compared; nothing of it is returned.
 */
export function allDayDateShape(sentDate: string, echoed: unknown): AllDayDateShape {
    const start = (echoed ?? null) as { date?: unknown; dateTime?: unknown } | null;
    const raw = typeof start?.date === 'string' ? start.date : typeof start?.dateTime === 'string' ? start.dateTime : null;
    const got = raw?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!got || !/^\d{4}-\d{2}-\d{2}$/.test(sentDate)) return 'unreadable';
    if (got === sentDate) return 'same_date';
    return got < sentDate ? 'shifted_back' : 'shifted_forward';
}

/**
 * How long before its answer an event must have been created for a 2xx create
 * to be read as Graph handing back an EARLIER event (a de-duplicated
 * transactionId) rather than making a new one. Generous, because the two clocks
 * compared are Graph's own (`createdDateTime` against its `Date` header) and a
 * create takes well under a second.
 */
export const EXISTING_EVENT_AGE_MS = 5 * 60 * 1000;

/**
 * Was the event in a 2xx create answer made before this request? Reads Graph's
 * `createdDateTime` against the answer's `Date` header (Graph's clock on both
 * sides), falling back to `now` when the header is absent. Unreadable → false:
 * a create we cannot date is counted as a new one, never as a duplicate.
 */
export function createdBeforeAnswer(createdDateTime: unknown, answerDate: string | null, now: () => number = Date.now): boolean {
    if (typeof createdDateTime !== 'string') return false;
    // Graph writes seven fractional digits and sometimes no zone; read as UTC.
    const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(createdDateTime) ? createdDateTime : `${createdDateTime}Z`;
    const created = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isFinite(created)) return false;
    const answered = answerDate ? Date.parse(answerDate) : NaN;
    const reference = Number.isFinite(answered) ? answered : now();
    return reference - created > EXISTING_EVENT_AGE_MS;
}
