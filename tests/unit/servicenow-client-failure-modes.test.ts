/**
 * ServiceNow client — the paths taken when the instance does NOT cooperate.
 *
 * `tests/unit/servicenow-client.test.ts` pins the happy path and the two
 * security refusals (off-domain host, script-bearing encoded query). This file
 * covers the other half: every place the client declines to guess.
 *
 * The recurring shape is that ServiceNow answers 200 with a body that does not
 * contain what was asked for. `res.ok` is true, `json()` parses, and the only
 * thing separating "the write landed" from "the write did not land" is whether
 * `body.result` is there. Every one of those checks is asserted here by the
 * error it raises, because the alternative — returning a RemoteObject built
 * from `undefined` — produces a `remoteId: ''` that the sync store will happily
 * persist as the identity of a record that does not exist.
 *
 * The other cluster is "the connection is half-configured": no table, no
 * credentials, a `windowDays` of zero. Those must all fail BEFORE a request, or
 * fail as a named error — never as a 401 that gets charged to the customer's
 * credential.
 */
import {
    ServiceNowClient,
    snValue,
    SERVICENOW_PAGE_SIZE,
    type ServiceNowConnectionConfig,
} from '@/app-layer/integrations/providers/servicenow/client';

const CFG: ServiceNowConnectionConfig = {
    instance: 'acme.service-now.com',
    table: 'change_request',
    windowDays: 30,
    username: 'inflect.integration',
    password: 'pw',
};

type FetchFn = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

const jsonRes = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as unknown as Response;

function fetchStub(pages: unknown[]): FetchFn {
    let i = 0;
    return jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
        jsonRes(pages[Math.min(i++, pages.length - 1)]),
    );
}
const noFetch = (): FetchFn => jest.fn();
const client = (over: Partial<ServiceNowConnectionConfig>, f: FetchFn) =>
    new ServiceNowClient({ ...CFG, ...over } as ServiceNowConnectionConfig, f as unknown as typeof fetch);

const row = (over: Record<string, unknown> = {}) => ({
    sys_id: 'sid-1',
    number: 'CHG0001',
    sys_updated_on: '2026-08-01 12:00:00',
    ...over,
});

describe('a connection with no table configured never reaches the network', () => {
    // `table` comes from configJson and is stored verbatim. An absent one used
    // to produce `/api/now/table/` — a valid URL that ServiceNow answers with a
    // 401 or a 404, either of which the resilience layer charges to the
    // credential. Refusing here keeps the diagnosis on the config field that is
    // actually empty.

    it('testConnection reports the missing table instead of probing', async () => {
        const fetchImpl = noFetch();
        const r = await client({ table: undefined }, fetchImpl).testConnection();
        expect(r).toEqual({ ok: false, message: 'No ServiceNow table configured.' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        ['listRemoteObjects', (c: ServiceNowClient) => c.listRemoteObjects()],
        ['findByCorrelationId', (c: ServiceNowClient) => c.findByCorrelationId('inflect:abc')],
        ['createRemoteObject', (c: ServiceNowClient) => c.createRemoteObject({ x: 1 }, 'inflect:abc')],
        ['updateRemoteObject', (c: ServiceNowClient) => c.updateRemoteObject('sid-1', { x: 1 })],
        ['getRemoteObject', (c: ServiceNowClient) => c.getRemoteObject('sid-1')],
    ])('%s throws "no table configured" and sends nothing', async (_name, call) => {
        const fetchImpl = noFetch();
        await expect(call(client({ table: undefined }, fetchImpl))).rejects.toThrow(
            /no table configured/i,
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('missing credentials are refused on every authenticated verb', () => {
    // Sending `Basic <base64 ":">` gets a 401, resilientFetch turns any 401 into
    // an IntegrationAuthError, and the connection is marked credential-failed
    // for OUR malformed request — telling an admin their password was revoked
    // when it was never sent. The existing suite pins this for testConnection;
    // the write verbs build the same header and must refuse identically.
    it.each([
        ['createRemoteObject', (c: ServiceNowClient) => c.createRemoteObject({ x: 1 }, 'inflect:abc')],
        ['updateRemoteObject', (c: ServiceNowClient) => c.updateRemoteObject('sid-1', { x: 1 })],
        ['listRemoteObjects', (c: ServiceNowClient) => c.listRemoteObjects()],
    ])('%s refuses when the username is absent', async (_name, call) => {
        const fetchImpl = noFetch();
        await expect(call(client({ username: undefined }, fetchImpl))).rejects.toThrow(
            /missing its integration-user credentials/,
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses when the password is absent', async () => {
        const fetchImpl = noFetch();
        await expect(
            client({ password: undefined }, fetchImpl).createRemoteObject({ x: 1 }, 'inflect:abc'),
        ).rejects.toThrow(/missing its integration-user credentials/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('testConnection never throws out of the Test button', () => {
    it('reports a non-Error throw as a message rather than propagating it', async () => {
        // `resilientFetch` is not the only thing under here — a rejected
        // promise carrying a string (a driver, a mock, a `throw 'timeout'`
        // somewhere down the stack) must still land in `message`, because the
        // admin-facing Test button renders `message` and nothing else.
        const fetchImpl = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => {
            // eslint-disable-next-line no-throw-literal -- deliberately not an Error
            throw 'instance hibernating';
        });
        const r = await client({}, fetchImpl).testConnection();
        expect(r.ok).toBe(false);
        expect(r.message).toBe('instance hibernating');
        expect(r.latencyMs).toEqual(expect.any(Number));
    });
});

describe('getRemoteObject distinguishes "not there" from "not readable"', () => {
    it('returns null when the instance answers 200 with an empty result', async () => {
        // A sys_id that does not exist can come back either as a 404 or as a
        // 200 with `{}` depending on the table's ACLs. Both mean the same
        // thing, and only the 404 form was pinned.
        const c = client({}, fetchStub([{}]));
        await expect(c.getRemoteObject('sid-1')).resolves.toBeNull();
    });

    it('maps a present result to a RemoteObject', async () => {
        const c = client({}, fetchStub([{ result: row() }]));
        await expect(c.getRemoteObject('sid-1')).resolves.toMatchObject({ remoteId: 'sid-1' });
    });

    it('refuses a table-less connection instead of reporting the record deleted', async () => {
        // The two answers mean opposite things to a sync: `null` is normal
        // attrition (the record was deleted upstream), a throw is a broken
        // integration. Without a table the URL is `/api/now/table//<sys_id>`,
        // which answers 404 — and the 404 arm below returns `null`. So a
        // misconfigured connection reported EVERY record as deleted, and the
        // operator was told their ServiceNow records had vanished.
        const fetchImpl = noFetch();
        await expect(client({ table: undefined }, fetchImpl).getRemoteObject('sid-1')).rejects.toThrow(
            /no table configured/i,
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('propagates a non-404 HTTP failure rather than reading it as deleted', async () => {
        const fetchImpl: FetchFn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
            async () => jsonRes({}, false, 500),
        );
        await expect(client({}, fetchImpl).getRemoteObject('sid-1')).rejects.toThrow(/HTTP 500/);
    });
});

describe('findByCorrelationId adopts exactly one record', () => {
    it('ADOPTS the single match — the retry-after-a-successful-create case', async () => {
        // The whole point of the correlation id: a retry that runs after the
        // remote record was created but before its id was recorded must find
        // and adopt it rather than creating a second one. Nothing pinned the
        // adopt itself — only "none" and "two".
        const c = client({}, fetchStub([{ result: [row({ sys_id: 'adopted' })] }]));
        const found = await c.findByCorrelationId('inflect:abc');
        expect(found).not.toBeNull();
        expect(found!.remoteId).toBe('adopted');
    });

    it('treats a result-less 200 as no match rather than crashing', async () => {
        const c = client({}, fetchStub([{}]));
        await expect(c.findByCorrelationId('inflect:abc')).resolves.toBeNull();
    });
});

describe('a 200 that does not carry the record is a failure, not a success', () => {
    it('create refuses a body with no result', async () => {
        // Returning a RemoteObject built from `undefined` would give
        // `remoteId: ''`, which the sync store persists as the identity of a
        // record that does not exist — and every later update PATCHes `/`.
        const c = client({}, fetchStub([{}]));
        await expect(c.createRemoteObject({ x: 1 }, 'inflect:abc')).rejects.toThrow(
            'ServiceNow create returned no record',
        );
    });

    it('update refuses a body with no result', async () => {
        const c = client({}, fetchStub([{}]));
        await expect(c.updateRemoteObject('sid-1', { x: 1 })).rejects.toThrow(
            'ServiceNow update returned no record',
        );
    });

    it('create surfaces the HTTP status when the POST itself failed', async () => {
        const fetchImpl: FetchFn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
            async () => jsonRes({}, false, 403),
        );
        await expect(client({}, fetchImpl).createRemoteObject({ x: 1 }, 'inflect:abc')).rejects.toThrow(
            'ServiceNow create failed (HTTP 403)',
        );
    });

    it('update surfaces the HTTP status when the PATCH itself failed', async () => {
        const fetchImpl: FetchFn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
            async () => jsonRes({}, false, 409),
        );
        await expect(client({}, fetchImpl).updateRemoteObject('sid-1', { x: 1 })).rejects.toThrow(
            'ServiceNow update failed (HTTP 409)',
        );
    });

    it('update refuses an empty remote id before building a URL from it', async () => {
        // `/api/now/table/change_request/` is a valid URL that PATCHes the
        // TABLE rather than a row.
        const fetchImpl = noFetch();
        await expect(client({}, fetchImpl).updateRemoteObject('', { x: 1 })).rejects.toThrow(
            'ServiceNow updates require a remote id',
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('listRemoteObjects tolerates a result-less page', () => {
    it('stops on a body with no result rather than looping forever', async () => {
        // `rows.length === SERVICENOW_PAGE_SIZE` is what continues the loop, so
        // an absent `result` must read as a zero-length page — not as a throw,
        // and not as a full one.
        const fetchImpl = fetchStub([{}]);
        const r = await client({}, fetchImpl).listRemoteObjects();
        expect(r.items).toEqual([]);
        expect(r.nextCursor).toBeUndefined();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('resumes from a supplied cursor instead of re-reading page one', async () => {
        const full = { result: Array.from({ length: SERVICENOW_PAGE_SIZE }, (_, i) => row({ sys_id: `s${i}` })) };
        const fetchImpl = fetchStub([full]);
        const r = await client({}, fetchImpl).listRemoteObjects({
            cursor: '400',
            limit: SERVICENOW_PAGE_SIZE,
        });
        const offset = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('sysparm_offset');
        expect(offset).toBe('400');
        // The cursor advances by what was READ, so a resumed read hands back
        // 400 + a page rather than restarting the count.
        expect(r.nextCursor).toBe(String(400 + SERVICENOW_PAGE_SIZE));
    });

    it('refuses a negative cursor, which would page backwards forever', async () => {
        const fetchImpl = noFetch();
        await expect(client({}, fetchImpl).listRemoteObjects({ cursor: '-1' })).rejects.toThrow(
            'Invalid ServiceNow cursor: -1',
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('the read window falls back to 90 days rather than to "everything"', () => {
    const windowStart = (f: FetchFn): Date => {
        const q = new URL(String(f.mock.calls[0][0])).searchParams.get('sysparm_query') ?? '';
        const stamp = /^sys_updated_on>=(.+?)\^/.exec(q)?.[1] ?? '';
        return new Date(stamp.replace(' ', 'T') + 'Z');
    };
    const daysAgo = (d: Date) => Math.round((Date.now() - d.getTime()) / 86_400_000);

    it.each([
        ['absent', undefined],
        ['zero', 0],
        ['negative', -5],
        ['not a number', 'ninety' as unknown as number],
    ])('windowDays %s falls back to 90', async (_label, windowDays) => {
        // A `0` or a negative would compute a window START in the future or at
        // "now", selecting nothing — a read that silently returns an empty
        // evidence set looks exactly like a table with no recent changes.
        const fetchImpl = fetchStub([{ result: [] }]);
        await client({ windowDays }, fetchImpl).listRemoteObjects();
        expect(daysAgo(windowStart(fetchImpl))).toBe(90);
    });

    it('honours a configured window', async () => {
        const fetchImpl = fetchStub([{ result: [] }]);
        await client({ windowDays: 7 }, fetchImpl).listRemoteObjects();
        expect(daysAgo(windowStart(fetchImpl))).toBe(7);
    });

    it('floors a fractional window rather than emitting a sub-second stamp', async () => {
        const fetchImpl = fetchStub([{ result: [] }]);
        await client({ windowDays: 3.9 }, fetchImpl).listRemoteObjects();
        expect(daysAgo(windowStart(fetchImpl))).toBe(3);
    });
});

describe('row values that are absent or unparseable', () => {
    it('unwraps a reference bag with neither display_value nor value to empty string', () => {
        // `display_value ?? value ?? ''`. Without the final fallback the mapper
        // writes `undefined` into an evidence field, which JSON-stringifies
        // away entirely rather than failing.
        expect(snValue({})).toBe('');
    });

    it('leaves remoteUpdatedAt undefined when the row carries no timestamp', async () => {
        const c = client({}, fetchStub([{ result: [{ sys_id: 'sid-1' }] }]));
        const r = await c.listRemoteObjects();
        expect(r.items[0].remoteId).toBe('sid-1');
        // Not `Invalid Date`, which compares as neither before nor after
        // anything — a window filter over it silently excludes the row.
        expect(r.items[0].remoteUpdatedAt).toBeUndefined();
    });

    it('leaves remoteUpdatedAt undefined when the timestamp will not parse', async () => {
        const c = client({}, fetchStub([{ result: [{ sys_id: 'sid-1', sys_updated_on: 'never' }] }]));
        const r = await c.listRemoteObjects();
        expect(r.items[0].remoteUpdatedAt).toBeUndefined();
    });
});
