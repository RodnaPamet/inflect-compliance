/**
 * ServiceNow client + mapper (S1).
 *
 * Three classes of thing are worth pinning here, and only one of them is
 * "does the happy path work":
 *
 *   1. The instance host comes from configJson and receives the integration
 *      user's PASSWORD. configJson is stored verbatim with no validation for
 *      any provider, so an off-domain instance must be refused before any
 *      request — the same hole Workday had at two call sites.
 *   2. A ServiceNow encoded query is not an inert filter. `javascript:` and
 *      `gs.` execute server-side with the integration user's rights.
 *   3. The Table API's value shapes and date format are both quietly wrong if
 *      taken at face value — `{value, display_value}` stringifies to
 *      `[object Object]`, and a zone-less timestamp parses as local time.
 */
import {
    ServiceNowClient,
    assertInertQuery,
    snValue,
    SERVICENOW_PAGE_SIZE,
    type ServiceNowConnectionConfig,
} from '@/app-layer/integrations/providers/servicenow/client';
import {
    ServiceNowChangeMapper,
    mapApproval,
    mapChangeState,
    parseServiceNowDate,
} from '@/app-layer/integrations/providers/servicenow/mapper';

const CFG: ServiceNowConnectionConfig = {
    instance: 'acme.service-now.com',
    table: 'change_request',
    windowDays: 30,
    username: 'inflect.integration',
    password: 'pw',
};

const jsonRes = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as unknown as Response;

/**
 * `jest.fn(async () => …)` infers a ZERO-length parameter tuple, so
 * `mock.calls[0][0]` is a compile error — and the assertion that matters here
 * is WHICH URL was requested. Typing the double as `fetch` is what makes the
 * argument inspectable.
 */
type FetchFn = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

function fetchStub(pages: unknown[]): FetchFn {
    let i = 0;
    return jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
        jsonRes(pages[Math.min(i++, pages.length - 1)]),
    );
}
const noFetch = (): FetchFn => jest.fn();

const row = (over: Record<string, unknown> = {}) => ({
    sys_id: 'sid-1',
    number: 'CHG0001',
    short_description: 'Patch the thing',
    approval: 'approved',
    state: 'Closed Complete',
    sys_updated_on: '2026-08-01 12:00:00',
    ...over,
});

describe('the instance host is validated before the password is sent', () => {
    it.each([
        ['evil.example.com', 'unrelated domain'],
        ['service-now.com.attacker.net', 'contains the domain, is not under it'],
        ['evil-service-now.com', 'defeats a naive endsWith'],
        ['acme.service-now.com@evil.example', 'userinfo — the real host is evil.example'],
    ])('refuses %s (%s) WITHOUT making a request', async (instance) => {
        const fetchImpl = noFetch();
        const c = new ServiceNowClient({ ...CFG, instance }, fetchImpl as unknown as typeof fetch);
        const r = await c.testConnection();
        expect(r.ok).toBe(false);
        // The assertion that matters. A guard that throws AFTER the request has
        // already handed over the credential is not a guard.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each(['acme.service-now.com', 'https://acme.service-now.com/', 'ACME.Service-Now.com', 'agency.servicenowservices.com'])(
        'accepts %s',
        async (instance) => {
            const fetchImpl = fetchStub([{ result: [{ sys_id: 'x' }] }]);
            const c = new ServiceNowClient({ ...CFG, instance }, fetchImpl as unknown as typeof fetch);
            expect((await c.testConnection()).ok).toBe(true);
        },
    );

    it('includes the gov-cloud estate — omitting it locks out the likeliest buyers', async () => {
        const fetchImpl = fetchStub([{ result: [] }]);
        const c = new ServiceNowClient({ ...CFG, instance: 'agency.servicenowservices.com' }, fetchImpl as unknown as typeof fetch);
        await c.testConnection();
        expect(String(fetchImpl.mock.calls[0][0])).toContain('agency.servicenowservices.com');
    });
});

describe('an encoded query is not an inert filter', () => {
    it.each(['javascript:gs.getUser()', 'active=true^ORDERBYjavascript:gs.now()', 'sys_id=x^gs.log("hi")'])(
        'refuses %s',
        (q) => {
            expect(() => assertInertQuery(q)).toThrow(/server-side script/);
        },
    );

    it('allows an ordinary field filter', () => {
        expect(assertInertQuery('active=true^priority=1')).toBe('active=true^priority=1');
    });

    it('the read applies it to a caller-supplied filter', async () => {
        const fetchImpl = noFetch();
        const c = new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch);
        await expect(
            c.listRemoteObjects({ filters: { encodedQuery: 'javascript:gs.now()' } }),
        ).rejects.toThrow(/server-side script/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('missing credentials throw instead of sending an empty Basic header', () => {
    it.each([['', 'pw'], ['u', '']])('username=%p password=%p', async (username, password) => {
        // Sending `Basic <base64 ":">` gets a 401, resilientFetch turns any 401
        // into IntegrationAuthError, and the connection is marked
        // credential-failed for OUR malformed request — telling an admin their
        // password was revoked when it was never sent.
        const fetchImpl = noFetch();
        const c = new ServiceNowClient({ ...CFG, username, password }, fetchImpl as unknown as typeof fetch);
        expect((await c.testConnection()).ok).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('testConnection probes the configured table', () => {
    it('reads the table the connection will actually use, not a generic ping', async () => {
        const fetchImpl = fetchStub([{ result: [] }]);
        await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).testConnection();
        // An integration user with valid credentials and no ACL on the table is
        // the most common failure, and a ping elsewhere reports it as healthy.
        expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/now/table/change_request');
    });

    it('reports a failure rather than throwing out of the Test button', async () => {
        const fetchImpl: FetchFn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => jsonRes({}, false, 403));
        const r = await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).testConnection();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('403');
    });

    it('refuses an unexpected response shape rather than calling it connected', async () => {
        const fetchImpl: FetchFn = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () => jsonRes({ nope: true }));
        expect((await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).testConnection()).ok).toBe(false);
    });
});

describe('paging', () => {
    it('keeps reading while pages are full and stops on a short one', async () => {
        const full = { result: Array.from({ length: SERVICENOW_PAGE_SIZE }, (_, i) => row({ sys_id: `s${i}` })) };
        const short = { result: [row({ sys_id: 'last' })] };
        const fetchImpl = fetchStub([full, short]);
        const r = await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).listRemoteObjects();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(r.items).toHaveLength(SERVICENOW_PAGE_SIZE + 1);
        expect(r.nextCursor).toBeUndefined();
    });

    it('hands back a cursor when it stopped at the cap with more available', async () => {
        const full = { result: Array.from({ length: SERVICENOW_PAGE_SIZE }, (_, i) => row({ sys_id: `s${i}` })) };
        const fetchImpl = fetchStub([full]);
        const r = await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch)
            .listRemoteObjects({ limit: SERVICENOW_PAGE_SIZE });
        expect(r.nextCursor).toBe(String(SERVICENOW_PAGE_SIZE));
    });

    it('orders newest-updated first, so a mid-read change is re-read rather than skipped', async () => {
        // Offset pagination over a live table is lossy either way; DESC bounds
        // it to duplicates, which the sys_id-keyed ingest absorbs. ASC would
        // lose rows silently.
        const fetchImpl = fetchStub([{ result: [] }]);
        await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).listRemoteObjects();
        const q = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('sysparm_query') ?? '';
        expect(q).toContain('ORDERBYDESCsys_updated_on');
    });

    it('refuses a malformed cursor rather than silently restarting from zero', async () => {
        const c = new ServiceNowClient(CFG, fetchStub([{ result: [] }]) as unknown as typeof fetch);
        await expect(c.listRemoteObjects({ cursor: 'not-a-number' })).rejects.toThrow(/Invalid ServiceNow cursor/);
    });

    it('builds the time window itself rather than accepting one', async () => {
        const fetchImpl = fetchStub([{ result: [] }]);
        await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).listRemoteObjects();
        // Read the param the way a server does — URLSearchParams serialises the
        // space in `YYYY-MM-DD HH:MM:SS` as `+`, so decodeURIComponent alone
        // leaves a `+` where the timestamp's space belongs.
        const q = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('sysparm_query') ?? '';
        expect(q).toMatch(/^sys_updated_on>=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    });
});

describe('outbound is closed until S5 designs retry idempotency', () => {
    it('create and update refuse rather than shipping an unconsidered write', async () => {
        const c = new ServiceNowClient(CFG, fetchStub([{}]) as unknown as typeof fetch);
        await expect(c.createRemoteObject()).rejects.toThrow(/not enabled/);
        await expect(c.updateRemoteObject()).rejects.toThrow(/not enabled/);
    });
});

describe('the Table API value shapes', () => {
    it('unwraps {value, display_value}, preferring the human name', () => {
        expect(snValue({ value: 'abc123', display_value: 'Alice Smith' })).toBe('Alice Smith');
        expect(snValue({ value: 'abc123' })).toBe('abc123');
        expect(snValue('plain')).toBe('plain');
        expect(snValue(undefined)).toBe('');
    });

    it('the mapper unwraps EVERY field, not only the reference ones', () => {
        // display_value=all wraps the whole row. A mapper that special-cased
        // references would put "[object Object]" in an evidence record, and
        // nothing would fail.
        const local = new ServiceNowChangeMapper().toLocal({
            sys_id: { value: 'sid-1' },
            number: { value: 'CHG0042', display_value: 'CHG0042' },
            short_description: { value: 'Rotate the key' },
            assigned_to: { value: 'u1', display_value: 'Alice Smith' },
        });
        expect(local.externalKey).toBe('CHG0042');
        expect(local.title).toBe('Rotate the key');
        expect(local.assignedTo).toBe('Alice Smith');
        expect(JSON.stringify(local)).not.toContain('[object Object]');
    });
});

describe('approval and state mapping', () => {
    it('approved / rejected map through', () => {
        expect(mapApproval('approved')).toBe('APPROVED');
        expect(mapApproval('Rejected')).toBe('REJECTED');
    });

    it('not_requested is PENDING — never a pass, and never dropped', () => {
        // Nobody asked for approval is WEAKER than asked-and-waiting. Treating
        // it as a pass, or dropping it as unmapped, makes an unapproved
        // emergency change indistinguishable from an approved one.
        for (const v of ['not_requested', 'not requested', 'requested', '']) {
            expect(mapApproval(v)).toBe('PENDING');
        }
    });

    it('an unrecognised state is not closed — it is not guessed', () => {
        // `state` is an integer whose meaning is instance-specific, so an
        // unknown value defaulting to complete would manufacture the evidence.
        expect(mapChangeState('Closed Complete')).toBe('CLOSED_COMPLETE');
        expect(mapChangeState('Canceled')).toBe('CLOSED_INCOMPLETE');
        expect(mapChangeState('Scheduled')).toBe('OPEN');
        expect(mapChangeState('Some Custom State')).toBe('OPEN');
    });
});

describe('dates', () => {
    it('reads ServiceNow timestamps as UTC, not local time', () => {
        // `new Date('2026-01-01 12:00:00')` parses in LOCAL time. On any server
        // not running UTC that moves every change hours out — enough to push a
        // change across a day boundary and out of the window that selected it.
        expect(parseServiceNowDate('2026-01-01 12:00:00')?.toISOString()).toBe('2026-01-01T12:00:00.000Z');
    });

    it('returns null for an unparseable value rather than an Invalid Date', () => {
        // Invalid Date compares as neither before nor after anything, so a
        // window filter over it silently excludes the row instead of failing.
        expect(parseServiceNowDate('')).toBeNull();
        expect(parseServiceNowDate('not a date')).toBeNull();
    });

    it('the mapper produces a real Date for the timestamp fields', () => {
        const local = new ServiceNowChangeMapper().toLocal(row({ opened_at: '2026-07-04 09:30:00' }));
        expect((local.openedAt as Date).toISOString()).toBe('2026-07-04T09:30:00.000Z');
    });
});

describe('remote objects', () => {
    it('carries sys_id as remoteId and a parsed remoteUpdatedAt', async () => {
        const fetchImpl = fetchStub([{ result: [row()] }]);
        const r = await new ServiceNowClient(CFG, fetchImpl as unknown as typeof fetch).listRemoteObjects();
        expect(r.items[0].remoteId).toBe('sid-1');
        expect(r.items[0].remoteUpdatedAt?.toISOString()).toBe('2026-08-01T12:00:00.000Z');
    });

    it('getRemoteObject returns null on 404 but propagates an auth failure', async () => {
        const notFound = new ServiceNowClient(CFG, (async () => { throw new Error('x 404 y'); }) as unknown as typeof fetch);
        await expect(notFound.getRemoteObject('sid-1')).resolves.toBeNull();
        // Swallowing a 401 into null would read as a deleted record.
        const denied = new ServiceNowClient(CFG, (async () => { throw new Error('HTTP 401'); }) as unknown as typeof fetch);
        await expect(denied.getRemoteObject('sid-1')).rejects.toThrow('401');
    });
});
