/**
 * The two `CalendarWriter`s against a scripted transport (#5937 step 2).
 *
 * Each case scripts what Google or Graph answers and asserts what the writer
 * does with it, through the REAL resilient layer — so a 401 is the layer's
 * `IntegrationAuthError` and an exhausted 429 its `IntegrationRateLimitedError`,
 * the two errors the sweep treats as the connection's problem.
 *
 * Graph's answer to a duplicate `transactionId` is NOT known from a real
 * mailbox (open item of #5937). The Graph duplicate cases below test the
 * defensive handling of each plausible shape, not Graph's behaviour.
 */
import { createGoogleCalendarWriter, GOOGLE_MARKER_PROPERTY } from '@/app-layer/integrations/providers/calendar/google-writer';
import { createGraphCalendarWriter, GRAPH_MARKER_PROPERTY_ID } from '@/app-layer/integrations/providers/calendar/graph-writer';
import { recreatedClientEventId, CalendarWriteError } from '@/app-layer/integrations/providers/calendar/calendar-http';
import { revokeGoogleCalendarToken } from '@/app-layer/integrations/providers/calendar/token';
import { IntegrationAuthError, IntegrationRateLimitedError } from '@/app-layer/integrations/http-resilience';
import type { PushableEvent } from '@/app-layer/usecases/calendar-event-reconcile';

const EVENT: PushableEvent = {
    sourceKey: 'task-due',
    sourceEntityId: 'task-1',
    title: 'Task due: Rotate keys',
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: null,
    description: 'Open in Inflect: https://app.example.test/t/acme/tasks/task-1',
};
const CLIENT_ID = 'a'.repeat(40);

interface Call { method: string; url: string; body: unknown; auth: string | null; prefer: string | null }

/** A transport answering from a script, recording every request. */
function scripted(answers: Array<Response | (() => Response)>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
            method: String(init?.method),
            url: String(input),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            auth: headers.get('authorization'),
            prefer: headers.get('prefer'),
        });
        const next = answers.shift();
        if (!next) throw new Error(`unscripted request: ${init?.method} ${String(input)}`);
        return typeof next === 'function' ? next() : next;
    }) as typeof fetch;
    return { calls, deps: { fetchImpl, sleepImpl: async () => undefined } };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

function tokens() {
    let n = 0;
    return {
        current: jest.fn(async () => 'token-current'),
        refresh: jest.fn(async () => `token-refreshed-${++n}`),
    };
}

describe('Google Calendar writer', () => {
    it('inserts an all-day, private, free event under OUR id, marked as Inflect\'s', async () => {
        const t = scripted([json(200, { id: CLIENT_ID })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).resolves.toEqual({ remoteEventId: CLIENT_ID });
        const call = t.calls[0];
        expect(call.method).toBe('POST');
        expect(call.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
        expect(call.auth).toBe('Bearer token-current');
        expect(call.body).toEqual({
            id: CLIENT_ID,
            summary: EVENT.title,
            description: EVENT.description,
            start: { date: '2026-09-01' },
            end: { date: '2026-09-02' },
            transparency: 'transparent',
            visibility: 'private',
            reminders: { useDefault: true },
            extendedProperties: { private: { [GOOGLE_MARKER_PROPERTY]: CLIENT_ID } },
        });
        // No attendees, no location: nobody is invited to a person's own deadline.
        expect(call.body).not.toHaveProperty('attendees');
        expect(call.body).not.toHaveProperty('location');
    });

    it('a retried insert (409) is the event a previous attempt created — no second event', async () => {
        const t = scripted([json(409, { error: { code: 409, message: 'The requested identifier already exists.' } })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).resolves.toEqual({ remoteEventId: CLIENT_ID });
        expect(t.calls).toHaveLength(1);
    });

    it('a patch un-cancels the event, so one deleted by hand comes back when its deadline changes', async () => {
        const t = scripted([json(200, { id: 'evt-1' })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.patch({ remoteEventId: 'evt-1', event: EVENT })).resolves.toEqual({ remoteEventId: 'evt-1' });
        expect(t.calls[0].method).toBe('PATCH');
        expect(t.calls[0].url).toMatch(/\/events\/evt-1$/);
        expect(t.calls[0].body).toMatchObject({ status: 'confirmed', summary: EVENT.title });
    });

    it.each([404, 410])('a patch of an event that is gone (%i) creates it again and answers the NEW id', async (status) => {
        const t = scripted([json(status, { error: { code: status } }), json(200, { id: recreatedClientEventId('evt-1') })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        const out = await writer.patch({ remoteEventId: 'evt-1', event: EVENT });
        expect(out).toEqual({ remoteEventId: recreatedClientEventId('evt-1') });
        expect(t.calls[1].method).toBe('POST');
        // A deterministic id, so a retried re-creation is a 409, not a twin.
        expect((t.calls[1].body as { id: string }).id).toBe(recreatedClientEventId('evt-1'));
    });

    it.each([204, 404, 410])('a delete answered %i is done', async (status) => {
        const t = scripted([status === 204 ? empty(204) : json(status, { error: { code: status } })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.remove({ remoteEventId: 'evt-1' })).resolves.toBeUndefined();
        expect(t.calls[0].method).toBe('DELETE');
    });

    it('a 401 is retried ONCE with a freshly refreshed token, then is the provider\'s real answer', async () => {
        const tk = tokens();
        const t = scripted([empty(401), empty(401)]);
        const writer = createGoogleCalendarWriter({ tokens: tk, deps: t.deps });
        const err = await writer.insert({ clientEventId: CLIENT_ID, event: EVENT }).catch((e) => e);
        expect(err).toBeInstanceOf(IntegrationAuthError);
        expect(tk.refresh).toHaveBeenCalledTimes(1);
        expect(t.calls.map((c) => c.auth)).toEqual(['Bearer token-current', 'Bearer token-refreshed-1']);
    });

    it('a 401 that a refresh cures is not an error', async () => {
        const t = scripted([empty(401), json(200, { id: CLIENT_ID })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).resolves.toEqual({ remoteEventId: CLIENT_ID });
    });

    it('a 429 that outlasts the budget is IntegrationRateLimitedError — the connection-level throttle', async () => {
        const t = scripted([empty(429, { 'retry-after': '1' }), empty(429, { 'retry-after': '1' })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).rejects.toBeInstanceOf(IntegrationRateLimitedError);
    });

    it('Google\'s 403 rateLimitExceeded is a THROTTLE, not a lost credential', async () => {
        // Treated as auth, a busy morning would revoke the busiest people.
        const quota = () => json(403, { error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } });
        const t = scripted([quota, quota]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        const err = await writer.insert({ clientEventId: CLIENT_ID, event: EVENT }).catch((e) => e);
        expect(err).toBeInstanceOf(IntegrationRateLimitedError);
        expect(err).not.toBeInstanceOf(IntegrationAuthError);
    });

    it('any other 403 is the credential\'s problem', async () => {
        const t = scripted([json(403, { error: { code: 403, errors: [{ reason: 'forbidden' }] } })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.remove({ remoteEventId: 'evt-1' })).rejects.toBeInstanceOf(IntegrationAuthError);
    });

    it('a 400 is THIS event\'s failure, and its message carries no title', async () => {
        const t = scripted([json(400, { error: { message: `bad: ${EVENT.title}` } })]);
        const writer = createGoogleCalendarWriter({ tokens: tokens(), deps: t.deps });
        const err = await writer.insert({ clientEventId: CLIENT_ID, event: EVENT }).catch((e) => e);
        expect(err).toBeInstanceOf(CalendarWriteError);
        expect(String(err.message)).not.toContain('Rotate keys');
    });
});

describe('Microsoft Graph writer', () => {
    it('inserts with transactionId, the immutable-id header and the Inflect marker', async () => {
        const t = scripted([json(201, { id: 'AAMk-immutable' })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).resolves.toEqual({ remoteEventId: 'AAMk-immutable' });
        const call = t.calls[0];
        expect(call.url).toBe('https://graph.microsoft.com/v1.0/me/events');
        expect(call.prefer).toBe('IdType="ImmutableId"');
        expect(call.body).toEqual({
            subject: EVENT.title,
            body: { contentType: 'text', content: EVENT.description },
            start: { dateTime: '2026-09-01T00:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-09-02T00:00:00', timeZone: 'UTC' },
            isAllDay: true,
            showAs: 'free',
            sensitivity: 'private',
            transactionId: CLIENT_ID,
            singleValueExtendedProperties: [{ id: GRAPH_MARKER_PROPERTY_ID, value: CLIENT_ID }],
        });
    });

    it('a duplicate answered 2xx with an id is taken as the event (unverified shape)', async () => {
        const t = scripted([json(200, { id: 'AAMk-original' })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).resolves.toEqual({ remoteEventId: 'AAMk-original' });
    });

    it.each([
        ['409', () => json(409, { error: { code: 'ErrorItemAlreadyExists' } })],
        ['400 naming a duplicate', () => json(400, { error: { code: 'ErrorDuplicateTransactionId' } })],
    ])('a duplicate answered %s is FOUND by our marker, not created twice (unverified shape)', async (_label, dup) => {
        const t = scripted([dup, json(200, { value: [{ id: 'AAMk-original' }] })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).resolves.toEqual({ remoteEventId: 'AAMk-original' });
        expect(t.calls).toHaveLength(2);
        expect(t.calls[1].method).toBe('GET');
        const filter = decodeURIComponent(new URL(t.calls[1].url).searchParams.get('$filter') ?? '');
        expect(filter).toContain(`ep/value eq '${CLIENT_ID}'`);
        expect(filter).toContain(GRAPH_MARKER_PROPERTY_ID);
    });

    it('a duplicate that cannot be found is a per-event failure, retried next run — never a second POST', async () => {
        const t = scripted([json(409, { error: { code: 'Conflict' } }), json(200, { value: [] })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).rejects.toBeInstanceOf(CalendarWriteError);
        expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('a 400 that does not name a duplicate is a plain per-event failure', async () => {
        const t = scripted([json(400, { error: { code: 'ErrorInvalidRequest' } })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.insert({ clientEventId: CLIENT_ID, event: EVENT })).rejects.toBeInstanceOf(CalendarWriteError);
        expect(t.calls).toHaveLength(1);
    });

    it('a patch of a deleted event (404) creates it again and answers the new id', async () => {
        const t = scripted([json(404, { error: { code: 'ErrorItemNotFound' } }), json(201, { id: 'AAMk-new' })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.patch({ remoteEventId: 'AAMk-old', event: EVENT })).resolves.toEqual({ remoteEventId: 'AAMk-new' });
        expect((t.calls[1].body as { transactionId: string }).transactionId).toBe(recreatedClientEventId('AAMk-old'));
    });

    it('a patch that succeeds keeps the id', async () => {
        const t = scripted([json(200, { id: 'AAMk-old' })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.patch({ remoteEventId: 'AAMk-old', event: EVENT })).resolves.toEqual({ remoteEventId: 'AAMk-old' });
        expect(t.calls[0].body).not.toHaveProperty('transactionId');
    });

    it.each([204, 404, 410])('a delete answered %i is done', async (status) => {
        const t = scripted([status === 204 ? empty(204) : json(status, { error: { code: 'ErrorItemNotFound' } })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.remove({ remoteEventId: 'AAMk-old' })).resolves.toBeUndefined();
    });

    it('401 → refresh once → 401 is IntegrationAuthError', async () => {
        const tk = tokens();
        const t = scripted([empty(401), empty(401)]);
        const writer = createGraphCalendarWriter({ tokens: tk, deps: t.deps });
        await expect(writer.remove({ remoteEventId: 'x' })).rejects.toBeInstanceOf(IntegrationAuthError);
        expect(tk.refresh).toHaveBeenCalledTimes(1);
    });

    it('a 429 with a long Retry-After is not waited out', async () => {
        const t = scripted([empty(429, { 'retry-after': '120' })]);
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: t.deps });
        await expect(writer.patch({ remoteEventId: 'x', event: EVENT })).rejects.toBeInstanceOf(IntegrationRateLimitedError);
        expect(t.calls).toHaveLength(1);
    });

    it('every request carries a real Accept-Language (#3458) as well as the bearer token', async () => {
        const seen: Headers[] = [];
        const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
            seen.push(new Headers(init?.headers));
            return empty(204);
        }) as typeof fetch;
        const writer = createGraphCalendarWriter({ tokens: tokens(), deps: { fetchImpl, sleepImpl: async () => undefined } });
        await writer.remove({ remoteEventId: 'x' });
        expect(seen[0].get('accept-language')).toBe('en-US');
        expect(seen[0].get('authorization')).toBe('Bearer token-current');
    });
});

describe('Google revocation on disconnect', () => {
    const answering = (res: Response) => (async () => res) as unknown as typeof fetch;

    it('revokes the REFRESH token, form-encoded, at oauth2.googleapis.com/revoke', async () => {
        const calls: Array<{ url: string; body: string }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), body: String(init?.body) });
            return empty(200);
        }) as typeof fetch;
        await expect(revokeGoogleCalendarToken('fixture-refresh', { fetchImpl })).resolves.toBe('revoked');
        expect(calls).toEqual([{ url: 'https://oauth2.googleapis.com/revoke', body: 'token=fixture-refresh' }]);
    });

    it('a token Google no longer knows is revoked too', async () => {
        await expect(
            revokeGoogleCalendarToken('rt', { fetchImpl: answering(json(400, { error: 'invalid_token' })) }),
        ).resolves.toBe('revoked');
    });

    it('never throws: an outage is reported, and the disconnect goes on', async () => {
        await expect(revokeGoogleCalendarToken('rt', { fetchImpl: answering(empty(503)) })).resolves.toBe('not-confirmed');
        const failing = (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch;
        await expect(revokeGoogleCalendarToken('rt', { fetchImpl: failing })).resolves.toBe('not-confirmed');
    });
});
