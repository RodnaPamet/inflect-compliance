/**
 * The `calendar.vendor_observation` line (#5957): one per vendor answer the
 * calendar push's open items depend on, carrying exactly `provider`,
 * `operation`, `status`, `code` and, on an insert, `dateShape` — never a
 * tenant, a person, an email, a title, an id, a token, a code or a URL.
 *
 * The line is what the owner's real-account steps leave behind
 * (`docs/runbooks/calendar-vendor-verification.md`) and what the
 * `calendar-observations` VM check counts. Its fields are a PUBLIC surface
 * once counted, so every case below asserts the EXACT record the logger
 * received, not a subset of it: a field that rides along fails here.
 *
 * The writers run against a scripted transport through the real resilient
 * layer; the logger's child is replaced, so what is asserted is the record
 * that would have been written.
 */
const written: Array<{ fields: Record<string, unknown>; msg: string }> = [];
const childBindings: unknown[] = [];
let sinkDown = false;
jest.mock('@/lib/observability', () => ({
    ...jest.requireActual('@/lib/observability'),
    createChildLogger: (bindings: unknown) => {
        childBindings.push(bindings);
        return {
            info: (fields: Record<string, unknown>, msg: string) => {
                if (sinkDown) throw new Error('sink down');
                written.push({ fields, msg });
            },
        };
    },
}));

import {
    allDayDateShape,
    calendarVendorObservationFields,
    CALENDAR_VENDOR_OBSERVATION,
    CALENDAR_VENDOR_OPERATIONS,
    createdBeforeAnswer,
    observeCalendarVendor,
} from '@/app-layer/integrations/providers/calendar/vendor-observation';
import { createGoogleCalendarWriter } from '@/app-layer/integrations/providers/calendar/google-writer';
import { createGraphCalendarWriter } from '@/app-layer/integrations/providers/calendar/graph-writer';
import { recreatedClientEventId, CalendarWriteError } from '@/app-layer/integrations/providers/calendar/calendar-http';
import {
    CalendarCodeExchangeError,
    exchangeCalendarCode,
} from '@/app-layer/integrations/providers/calendar/token';
import type { PushableEvent } from '@/app-layer/usecases/calendar-event-reconcile';

const TITLE = 'Task due: Rotate keys for jane@contoso.example';
const EVENT: PushableEvent = {
    sourceKey: 'task-due',
    sourceEntityId: 'task-1',
    title: TITLE,
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: null,
    description: 'Open in Inflect: https://app.example.test/t/acme/tasks/task-1',
};
const CLIENT_ID = 'a'.repeat(40);
const ANSWER_DATE = 'Tue, 01 Sep 2026 03:00:05 GMT';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function scripted(answers: Response[]) {
    const fetchImpl = (async () => {
        const next = answers.shift();
        if (!next) throw new Error('unscripted request');
        return next;
    }) as unknown as typeof fetch;
    return { fetchImpl, sleepImpl: async () => undefined };
}
const tokens = () => ({ current: async () => 'token-current', refresh: async () => 'token-refreshed' });

const graph = (answers: Response[]) => createGraphCalendarWriter({ tokens: tokens(), deps: scripted(answers) });
const google = (answers: Response[]) => createGoogleCalendarWriter({ tokens: tokens(), deps: scripted(answers) });

const lines = () => written.map((w) => w.fields);

beforeEach(() => {
    written.length = 0;
    childBindings.length = 0;
});

afterEach(() => {
    // Every line is under the one message, through a child with NO bindings
    // (no requestId, tenantId or userId from the ambient context).
    expect(written.map((w) => w.msg).filter((m) => m !== CALENDAR_VENDOR_OBSERVATION)).toEqual([]);
    expect(childBindings.filter((b) => JSON.stringify(b) !== '{}')).toEqual([]);
    // Nothing of the request, the answer's prose, or the token leaks into any line.
    const all = JSON.stringify(written);
    for (const leak of ['jane', 'contoso', 'Rotate', 'token-', CLIENT_ID, 'AAMk', 'https://', '2026-']) {
        expect(all).not.toContain(leak);
    }
});

describe('the record', () => {
    it.each(CALENDAR_VENDOR_OPERATIONS)('%s carries exactly provider, operation, status and code', (operation) => {
        const fields = calendarVendorObservationFields({ operation, status: 400, code: 'ErrorInvalidRequest' });
        expect(Object.keys(fields).sort()).toEqual(['code', 'operation', 'provider', 'status']);
        expect(fields.provider).toBe(operation.split('.')[0]);
    });

    it('adds dateShape only when given one, and only from its vocabulary', () => {
        expect(Object.keys(calendarVendorObservationFields({ operation: 'graph.insert', status: 201, dateShape: 'same_date' })).sort()).toEqual([
            'code',
            'dateShape',
            'operation',
            'provider',
            'status',
        ]);
        const bad = calendarVendorObservationFields({ operation: 'graph.insert', status: 201, dateShape: '2026-09-01' as never });
        expect(bad).not.toHaveProperty('dateShape');
    });

    it.each([
        'The user jane@contoso.example has not consented',
        'AADSTS65001: The user or administrator has not consented',
        'https://graph.microsoft.com/v1.0/me/events',
        '',
        'x'.repeat(65),
    ])('a code that is not code-shaped (%j) is dropped, never written', (code) => {
        expect(calendarVendorObservationFields({ operation: 'entra.exchange_error', status: 400, code }).code).toBeNull();
    });

    it.each(['AADSTS65001', 'invalid_grant', 'ErrorDuplicateTransactionId', 'duplicate', 'ALREADY_EXISTS'])('a machine code (%s) is kept', (code) => {
        expect(calendarVendorObservationFields({ operation: 'entra.exchange_error', status: 400, code }).code).toBe(code);
    });

    it('a status outside HTTP\'s range is null', () => {
        expect(calendarVendorObservationFields({ operation: 'graph.patch', status: 42 }).status).toBeNull();
        expect(calendarVendorObservationFields({ operation: 'entra.admin_consent_error', status: null }).status).toBeNull();
    });

    it('never throws, even when the logger does', () => {
        sinkDown = true;
        try {
            expect(() => observeCalendarVendor({ operation: 'graph.patch', status: 200 })).not.toThrow();
        } finally {
            sinkDown = false;
        }
    });
});

describe('the date shape: what an all-day insert echoed, never the date itself', () => {
    it.each([
        [{ dateTime: '2026-09-01T00:00:00.0000000', timeZone: 'UTC' }, 'same_date'],
        [{ dateTime: '2026-08-31T22:00:00.0000000', timeZone: 'UTC' }, 'shifted_back'],
        [{ dateTime: '2026-09-02T00:00:00.0000000', timeZone: 'UTC' }, 'shifted_forward'],
        [{ date: '2026-09-01' }, 'same_date'],
        [{ date: '2026-08-31' }, 'shifted_back'],
        [{}, 'unreadable'],
        [null, 'unreadable'],
        [{ dateTime: 'tomorrow' }, 'unreadable'],
    ])('%j → %s', (echoed, shape) => {
        expect(allDayDateShape('2026-09-01', echoed)).toBe(shape);
    });
});

describe('an earlier event handed back for a repeated transactionId', () => {
    it.each([
        ['2026-09-01T03:00:04.1234567Z', ANSWER_DATE, false],
        ['2026-09-01T03:00:04.1234567', ANSWER_DATE, false],
        ['2026-08-31T03:00:04.1234567Z', ANSWER_DATE, true],
        ['2026-09-01T02:50:00Z', ANSWER_DATE, true],
        [undefined, ANSWER_DATE, false],
        ['not a date', ANSWER_DATE, false],
    ])('created %s, answered %s → %s', (created, answered, earlier) => {
        expect(createdBeforeAnswer(created, answered)).toBe(earlier);
    });

    it('falls back to the local clock when the answer carries no Date header', () => {
        const now = () => Date.parse('2026-09-01T03:00:05Z');
        expect(createdBeforeAnswer('2026-09-01T03:00:04Z', null, now)).toBe(false);
        expect(createdBeforeAnswer('2026-08-01T03:00:04Z', null, now)).toBe(true);
    });
});

describe('Graph', () => {
    const created = { id: 'AAMk-new', createdDateTime: '2026-09-01T03:00:04.1234567Z', start: { dateTime: '2026-09-01T00:00:00.0000000', timeZone: 'UTC' } };

    it('graph.insert: a new event, with the shape of its echoed start', async () => {
        await graph([json(201, created, { date: ANSWER_DATE })]).insert({ clientEventId: CLIENT_ID, event: EVENT });
        expect(lines()).toEqual([{ provider: 'graph', operation: 'graph.insert', status: 201, code: null, dateShape: 'same_date' }]);
    });

    it('graph.insert: a start Graph moved into the previous day is shifted_back', async () => {
        const moved = { ...created, start: { dateTime: '2026-08-31T22:00:00.0000000', timeZone: 'UTC' } };
        await graph([json(201, moved, { date: ANSWER_DATE })]).insert({ clientEventId: CLIENT_ID, event: EVENT });
        expect(lines()).toEqual([{ provider: 'graph', operation: 'graph.insert', status: 201, code: null, dateShape: 'shifted_back' }]);
    });

    it('graph.insert_existing: a 2xx whose event Graph created earlier — the de-duplicated transactionId', async () => {
        const earlier = { ...created, id: 'AAMk-original', createdDateTime: '2026-08-31T03:00:04.1234567Z' };
        await expect(
            graph([json(200, earlier, { date: ANSWER_DATE })]).insert({ clientEventId: CLIENT_ID, event: EVENT }),
        ).resolves.toEqual({ remoteEventId: 'AAMk-original' });
        expect(lines()).toEqual([{ provider: 'graph', operation: 'graph.insert_existing', status: 200, code: null, dateShape: 'same_date' }]);
    });

    it('graph.insert_duplicate then graph.duplicate_found', async () => {
        await graph([
            json(409, { error: { code: 'ErrorItemAlreadyExists', message: `exists: ${TITLE}` } }),
            json(200, { value: [{ id: 'AAMk-original' }] }),
        ]).insert({ clientEventId: CLIENT_ID, event: EVENT });
        expect(lines()).toEqual([
            { provider: 'graph', operation: 'graph.insert_duplicate', status: 409, code: 'ErrorItemAlreadyExists' },
            { provider: 'graph', operation: 'graph.duplicate_found', status: 200, code: null },
        ]);
    });

    it('graph.insert_duplicate (a duplicate-coded 400) then graph.duplicate_not_found', async () => {
        const err = await graph([
            json(400, { error: { code: 'ErrorDuplicateTransactionId', message: TITLE } }),
            json(200, { value: [] }),
        ])
            .insert({ clientEventId: CLIENT_ID, event: EVENT })
            .catch((e) => e);
        expect(err).toBeInstanceOf(CalendarWriteError);
        expect(lines()).toEqual([
            { provider: 'graph', operation: 'graph.insert_duplicate', status: 400, code: 'ErrorDuplicateTransactionId' },
            { provider: 'graph', operation: 'graph.duplicate_not_found', status: 200, code: null },
        ]);
    });

    it('graph.insert: a refusal that does not name a duplicate is recorded with its code', async () => {
        await graph([json(400, { error: { code: 'ErrorInvalidRequest', message: TITLE } })])
            .insert({ clientEventId: CLIENT_ID, event: EVENT })
            .catch(() => undefined);
        expect(lines()).toEqual([{ provider: 'graph', operation: 'graph.insert', status: 400, code: 'ErrorInvalidRequest' }]);
    });

    it('graph.insert: an answer the resilient layer throws is recorded by its status', async () => {
        await graph([json(403, { error: { code: 'ErrorAccessDenied' } })])
            .insert({ clientEventId: CLIENT_ID, event: EVENT })
            .catch(() => undefined);
        expect(lines()).toEqual([{ provider: 'graph', operation: 'graph.insert', status: 403, code: null }]);
    });

    it('graph.patch: a 2xx (the id still resolves — Deleted Items, for a hand-deleted event)', async () => {
        await graph([json(200, { id: 'AAMk-old' })]).patch({ remoteEventId: 'AAMk-old', event: EVENT });
        expect(lines()).toEqual([{ provider: 'graph', operation: 'graph.patch', status: 200, code: null }]);
    });

    it('graph.patch: a 404 (the event gone), then the re-creation\'s graph.insert', async () => {
        await expect(
            graph([
                json(404, { error: { code: 'ErrorItemNotFound' } }),
                json(201, { ...created, id: 'AAMk-recreated' }, { date: ANSWER_DATE }),
            ]).patch({ remoteEventId: 'AAMk-old', event: EVENT }),
        ).resolves.toEqual({ remoteEventId: 'AAMk-recreated' });
        expect(recreatedClientEventId('AAMk-old')).not.toBe(CLIENT_ID);
        expect(lines()).toEqual([
            { provider: 'graph', operation: 'graph.patch', status: 404, code: null },
            { provider: 'graph', operation: 'graph.insert', status: 201, code: null, dateShape: 'same_date' },
        ]);
    });

    it('graph.patch: a 410 answered as a response carries Graph\'s code', async () => {
        await graph([json(410, { error: { code: 'ErrorItemNotFound' } }), json(201, created, { date: ANSWER_DATE })]).patch({
            remoteEventId: 'AAMk-old',
            event: EVENT,
        });
        expect(lines()[0]).toEqual({ provider: 'graph', operation: 'graph.patch', status: 410, code: 'ErrorItemNotFound' });
    });

    it('a delete writes no observation: no open item depends on it', async () => {
        await graph([new Response(null, { status: 204 })]).remove({ remoteEventId: 'AAMk-old' });
        expect(lines()).toEqual([]);
    });
});

describe('Google', () => {
    it('google.insert: a new event, with the shape of its echoed start', async () => {
        await google([json(200, { id: CLIENT_ID, start: { date: '2026-09-01' } })]).insert({ clientEventId: CLIENT_ID, event: EVENT });
        expect(lines()).toEqual([{ provider: 'google', operation: 'google.insert', status: 200, code: null, dateShape: 'same_date' }]);
    });

    it('google.insert: a retried insert\'s 409 with Google\'s reason', async () => {
        await google([json(409, { error: { code: 409, errors: [{ reason: 'duplicate' }], message: TITLE } })]).insert({
            clientEventId: CLIENT_ID,
            event: EVENT,
        });
        expect(lines()).toEqual([{ provider: 'google', operation: 'google.insert', status: 409, code: 'duplicate' }]);
    });

    it('google.insert: a refusal with only a status word', async () => {
        await google([json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: TITLE } })])
            .insert({ clientEventId: CLIENT_ID, event: EVENT })
            .catch(() => undefined);
        expect(lines()).toEqual([{ provider: 'google', operation: 'google.insert', status: 400, code: 'INVALID_ARGUMENT' }]);
    });
});

describe('the Outlook code exchange\'s refusal is read, codes only', () => {
    const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const exchange = (res: Response | (() => never)) =>
        exchangeCalendarCode(
            {
                provider: 'outlook-calendar',
                code: 'the-secret-code',
                redirectUri: 'https://app.example.test/api/integrations/calendar/callback',
                codeVerifier: VERIFIER,
                entraTenantId: 'contoso',
            },
            { fetchImpl: (async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch },
        ).catch((e) => e);

    it('AADSTS65001 at the start of the description → CONSENT_REQUIRED, with its HTTP status', async () => {
        const err = await exchange(
            json(400, {
                error: 'invalid_grant',
                error_description: 'AADSTS65001: The user or administrator has not consented to use the application. jane@contoso.example',
                error_codes: [65001],
            }),
        );
        expect(err).toBeInstanceOf(CalendarCodeExchangeError);
        expect(err.status).toBe(400);
        expect(err.reading).toEqual({ kind: 'CONSENT_REQUIRED', errorCode: 'invalid_grant', aadstsCode: 'AADSTS65001' });
        expect(String(err.message)).not.toMatch(/jane|secret/);
    });

    it('no AADSTS in the description: the first of Entra\'s numeric error_codes is read instead', async () => {
        const err = await exchange(json(400, { error: 'invalid_grant', error_description: 'Trace: x', error_codes: [65001, 50000] }));
        expect(err.reading).toEqual({ kind: 'CONSENT_REQUIRED', errorCode: 'invalid_grant', aadstsCode: 'AADSTS65001' });
    });

    it('a refusal with no recognised number keeps its OAuth code', async () => {
        const err = await exchange(json(400, { error: 'invalid_grant', error_description: 'AADSTS70008: The code has expired.' }));
        expect(err.reading).toEqual({ kind: 'OTHER', errorCode: 'invalid_grant', aadstsCode: 'AADSTS70008' });
    });

    it('a body that is not JSON has no reading, and keeps its status', async () => {
        const err = await exchange(new Response('<html>oops</html>', { status: 400, headers: { 'content-type': 'text/html' } }));
        expect(err).toBeInstanceOf(CalendarCodeExchangeError);
        expect(err.status).toBe(400);
        expect(err.reading).toBeNull();
    });

    it('a request that never got an answer has no status', async () => {
        const err = await exchange(() => {
            throw new Error('socket hang up');
        });
        expect(err).toBeInstanceOf(CalendarCodeExchangeError);
        expect(err.status).toBeNull();
    });
});
