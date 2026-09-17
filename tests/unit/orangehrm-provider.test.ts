/**
 * OrangeHRM — the fixture provider (#2548), over a faked fetch.
 *
 * No live credentials and no network: every test here drives `fetchImpl` or an
 * injected module double, so the whole suite runs from a clean checkout.
 *
 * WHAT IS ACTUALLY WORTH PINNING HERE, given the provider is an internal test
 * fixture rather than a customer integration:
 *
 *   · FAIL-CLOSED CONDUCT. Being a fixture buys no exemption. It writes the
 *     same `Employee` rows the personnel checks read and the 05:00 leaver pass
 *     acts on, so a green signal it has not earned is exactly as harmful here.
 *
 *   · THE REFUSAL ON AN ALL-DROPPED ROSTER. The field mapping is written from
 *     documentation and has never met a live instance — that is the premise of
 *     the whole issue — so the interesting test is not "it maps the happy
 *     payload" but "it is loud when the payload is not the one it expected".
 *
 *   · THE CREDENTIAL BOUNDARY. Both requests carry a secret to a host that came
 *     out of `configJson`, which `upsertIntegrationConnection` stores verbatim.
 *
 *   · `empNumber` OVER `employeeId`. That preference is the provider's one
 *     substantive contribution to the question the issue exists to answer, and
 *     it is a single `||` away from being silently wrong.
 */
import { OrangeHrmProvider } from '@/app-layer/integrations/providers/orangehrm';
import {
    readOrangeHrmRoster,
    mapOrangeHrmStatus,
    ORANGEHRM_PAGE_SIZE,
    ORANGEHRM_MAX_PER_RUN,
    ORANGEHRM_MAX_PAGES_PER_RUN,
    type OrangeHrmEmployeeRow,
    type OrangeHrmEnrichment,
} from '@/app-layer/integrations/providers/orangehrm/roster';
import { fetchOrangeHrmAccessToken } from '@/app-layer/integrations/providers/orangehrm/token';
import { HRIS_PROVIDERS, isHrisProviderId, isHrisSyncProvider } from '@/app-layer/integrations/providers/hris';

const HOST = 'acme.orangehrmlive.com';
const GOOD = { baseUrl: HOST, clientId: 'cid', clientSecret: 'csecret' };

/** A JSON response, in the shape `resilientFetch`'s callers consume. */
const json = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
    ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => body,
    }) as unknown as Response;

/**
 * A `typeof fetch` view of a spy whose calls stay inspectable.
 *
 * The narrow `(url: string, init?: RequestInit)` signature a readable double
 * wants is not assignable to `fetch`'s full overload set, so every call site
 * would otherwise carry `as unknown as typeof fetch`. Casting once here keeps
 * the assertions about arguments — which URL, which header — legible.
 */
const mockFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
    jest.fn(impl) as unknown as jest.MockedFunction<typeof fetch>;

/**
 * A list row as OrangeHRM 5.9 ACTUALLY returns one. Captured, not invented:
 * the complete key set is empNumber, empStatus, employeeId, firstName,
 * jobTitle, lastName, middleName, subunit, supervisors, terminationId.
 *
 * No workEmail. No contactDetails. No dates. The previous version of this
 * helper put an email on the row, which is why 50 green tests coexisted with a
 * connector that could not normalise a single employee (#2587).
 */
const row = (i: number, over: Partial<OrangeHrmEmployeeRow> = {}): OrangeHrmEmployeeRow => ({
    empNumber: i,
    employeeId: `BADGE-${i}`,
    firstName: 'Person',
    middleName: '',
    lastName: String(i),
    jobTitle: { title: null },
    subunit: { name: null },
    empStatus: { name: null },
    supervisors: [],
    terminationId: null,
    ...over,
});

/**
 * How many LIST pages were fetched.
 *
 * Every one of these assertions predates per-employee enrichment, when a page
 * was the only kind of request and `toHaveBeenCalledTimes` happened to mean
 * "pages". It no longer does — a 5,000-employee run makes 100 list calls and
 * 10,000 enrichment calls — so the thing being counted is now named.
 */
function pageCalls(f: { mock: { calls: unknown[][] } }): number {
    return f.mock.calls.filter((c) => !/\/pim\/employees?\/\d+\//.test(String(c[0]))).length;
}

/**
 * Serve an explicit row set plus the two per-employee calls it implies.
 * `emailFor` decides which employees have a work email — the email lives on
 * contact-details now, so "this employee has no email" is a property of the
 * ENRICHMENT response, not of the list row.
 */
function rosterFetch(rows: OrangeHrmEmployeeRow[], emailFor: (n: number) => string | null) {
    return mockFetch(async (url) => {
        const contact = /\/pim\/employee\/(\d+)\/contact-details/.exec(url);
        if (contact) return json({ data: { workEmail: emailFor(Number(contact[1])) } });
        if (/\/job-details/.test(url)) return json({ data: { joinedDate: null, employeeTerminationRecord: { id: null, date: null } } });
        const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
        return json({ data: offset === 0 ? rows : [] });
    });
}

/** What the two per-employee calls yield, in the shape the real endpoints return. */
const enrich = (over: Partial<OrangeHrmEnrichment> = {}): OrangeHrmEnrichment => ({
    workEmail: 'p@acme.test',
    joinedDate: null,
    terminationDate: null,
    managerEmail: null,
    ...over,
});

/**
 * A fetch that serves `total` rows in ORANGEHRM_PAGE_SIZE-sized pages AND the
 * two per-employee calls each row now requires. Routing by URL rather than by
 * call count, because the enrichment phase is concurrent and its request order
 * is deliberately not deterministic.
 */
function pagedFetch(total: number, opts: { emailFor?: (n: number) => string | null } = {}) {
    const emailFor = opts.emailFor ?? ((n: number) => `p${n}@acme.test`);
    return mockFetch(async (url) => {
        const contact = /\/pim\/employee\/(\d+)\/contact-details/.exec(url);
        if (contact) return json({ data: { workEmail: emailFor(Number(contact[1])) } });
        const job = /\/pim\/employees\/(\d+)\/job-details/.exec(url);
        if (job) return json({ data: { joinedDate: null, employeeTerminationRecord: { id: null, date: null } } });
        const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
        const take = Math.max(0, Math.min(ORANGEHRM_PAGE_SIZE, total - offset));
        return json({ data: Array.from({ length: take }, (_, k) => row(offset + k)) });
    });
}

// ─────────────────────────── fail-closed conduct ───────────────────────────

describe('runCheck never manufactures a signal', () => {
    it('ERRORs — it does not answer PASSED for a check it never ran', async () => {
        const r = await new OrangeHrmProvider().runCheck();
        expect(r.status).toBe('ERROR');
        expect(r.status).not.toBe('PASSED');
    });

    it('and NOT_APPLICABLE is also wrong here — that reads as "assessed, does not apply"', async () => {
        const r = await new OrangeHrmProvider().runCheck();
        expect(r.status).not.toBe('NOT_APPLICABLE');
    });

    it('produces no evidence, so nothing downstream can cite the non-check', () => {
        expect(new OrangeHrmProvider().mapResultToEvidence()).toBeNull();
    });
});

// ────────────────────── the HRIS allowlist and its cost ────────────────────

describe('the fixture is inside the HRIS allowlist, not beside it', () => {
    it('is dispatchable and guard-visible by the one list both consumers read', () => {
        expect(isHrisProviderId('orangehrm')).toBe(true);
        expect([...HRIS_PROVIDERS]).toContain('orangehrm');
    });

    it('POSITIVE CONTROL — the membership test still refuses a non-member', () => {
        // Without this, `isHrisProviderId` returning true unconditionally would
        // satisfy the assertion above while meaning nothing.
        expect(isHrisProviderId('definitely-not-an-hris-provider')).toBe(false);
    });

    it('satisfies the sync-provider shape the usecase resolves against', () => {
        // `registry.getProvider(conn.provider)` is followed by this predicate;
        // failing it lands in the "Provider does not support HRIS sync" arm.
        expect(isHrisSyncProvider(new OrangeHrmProvider())).toBe(true);
    });

    it('runs no scheduled checks, so nothing routes a control at it', () => {
        expect(new OrangeHrmProvider().supportedChecks).toEqual([]);
    });

    it('says in its own description that it is not a supported integration', () => {
        // The disclaimer is load-bearing: there is no "internal" flag on
        // IntegrationProvider, so these strings are the only place an operator
        // reading the connector list is told what this is.
        const p = new OrangeHrmProvider();
        expect(p.description).toMatch(/not a supported integration/i);
        expect(p.setupGuide).toMatch(/not a supported customer integration/i);
    });
});

// ───────────────────────── the credential boundary ─────────────────────────

describe('a secret never leaves for an unlisted host', () => {
    it('the roster read refuses an off-domain host BEFORE the request', async () => {
        const fetchImpl = mockFetch(async () => json({ data: [] }));
        await expect(
            readOrangeHrmRoster({ host: 'evil-orangehrm.com' }, 'live-bearer-token', null, { fetchImpl }),
        ).rejects.toThrow(/not a recognised OrangeHRM host/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('and refuses a listed host smuggled into userinfo', async () => {
        const fetchImpl = mockFetch(async () => json({ data: [] }));
        await expect(
            readOrangeHrmRoster({ host: `${HOST}@attacker.test` }, 'live-bearer-token', null, { fetchImpl }),
        ).rejects.toThrow(/must not carry credentials/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL — a listed host DOES reach the network', async () => {
        // The two refusals above are satisfied by any provider that never
        // fetches at all. This is what makes them mean something.
        const fetchImpl = pagedFetch(1);
        const r = await readOrangeHrmRoster({ host: HOST }, 'live-bearer-token', null, { fetchImpl });
        expect(pageCalls(fetchImpl)).toBe(1);
        expect(r.employees).toHaveLength(1);
    });

    it('the token exchange refuses an off-domain host before sending the client secret', async () => {
        const fetchImpl = mockFetch(async () => json({ access_token: 'x' }));
        await expect(
            fetchOrangeHrmAccessToken({ host: 'attacker.test', clientId: 'cid', clientSecret: 'csecret' }, { fetchImpl }),
        ).rejects.toThrow(/Refusing to send OrangeHRM credentials/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

// ───────────────────────────── token exchange ──────────────────────────────

describe('the client-credentials exchange', () => {
    it('posts the grant to the instance token endpoint with the secret in a Basic header', async () => {
        const fetchImpl = mockFetch(async () => json({ access_token: 'minted' }));
        const token = await fetchOrangeHrmAccessToken(
            { host: HOST, clientId: 'cid', clientSecret: 'csecret' },
            { fetchImpl },
        );
        expect(token).toBe('minted');

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`https://${HOST}/web/index.php/oauth2/token`);
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
        // The secret must be in the header, not the form body — a proxy in
        // front of the instance that logs bodies would otherwise capture it.
        expect(String(init.body)).toBe('grant_type=client_credentials');
    });

    it('a 200 carrying no access_token throws HERE, not as a 401 one frame later', async () => {
        // An empty Bearer header would come back 401 from the ROSTER endpoint
        // and read as a credential problem several frames from the exchange
        // that actually failed.
        const fetchImpl = mockFetch(async () => json({}));
        await expect(fetchOrangeHrmAccessToken({ host: HOST, clientId: 'c', clientSecret: 's' }, { fetchImpl })).rejects.toThrow(
            /no access_token/,
        );
    });

    it('a non-ok token response throws with its status', async () => {
        const fetchImpl = mockFetch(async () => json({}, { ok: false, status: 401 }));
        await expect(fetchOrangeHrmAccessToken({ host: HOST, clientId: 'c', clientSecret: 's' }, { fetchImpl })).rejects.toThrow(
            /401/,
        );
    });

    it('refuses empty credentials before building a request', async () => {
        const fetchImpl = mockFetch(async () => json({ access_token: 'x' }));
        await expect(fetchOrangeHrmAccessToken({ host: HOST, clientId: '', clientSecret: 's' }, { fetchImpl })).rejects.toThrow(
            /client id and client secret are required/,
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

// ─────────────────────────── status derivation ─────────────────────────────

describe('status derivation defers to the shared rule', () => {
    const now = new Date('2026-06-01T00:00:00Z');

    it('an employee leaving next month is OFFBOARDING, not TERMINATED', () => {
        // The case offboarded_access_removed exists for. TERMINATED here hands
        // the leaver pass somebody who is still coming to work.
        const status = mapOrangeHrmStatus(
            { empStatus: { name: 'Full-Time Permanent' } },
            enrich({ terminationDate: '2026-07-01' }),
            now,
        );
        expect(status).toBe('OFFBOARDING');
    });

    it('a hire starting next month is ONBOARDING, not ACTIVE', () => {
        expect(mapOrangeHrmStatus({}, enrich({ joinedDate: '2026-07-01' }), now)).toBe('ONBOARDING');
    });

    it('a past termination date is TERMINATED even though the status string says active', () => {
        // Dates beat the status string — the string is what an administrator
        // customises per tenant, so it cannot be relied on alone.
        const status = mapOrangeHrmStatus(
            { empStatus: { name: 'Full-Time Permanent' } },
            enrich({ terminationDate: '2026-01-01' }),
            now,
        );
        expect(status).toBe('TERMINATED');
    });

    it('a termination RECORD with no usable date is TERMINATED, not ACTIVE', () => {
        // OrangeHRM's own last resort. ACTIVE here would hide lingering access
        // for somebody the HR system has already terminated.
        expect(mapOrangeHrmStatus({ terminationId: 1 }, enrich(), now)).toBe('TERMINATED');
    });

    it('no termination record and no dates is ACTIVE', () => {
        expect(mapOrangeHrmStatus({ empStatus: { name: 'Full-Time Permanent' } }, enrich(), now)).toBe('ACTIVE');
    });

    it('reads the vendor status STRING when there are no dates at all', () => {
        // Proves `empStatus.name` is actually wired into the shared rule. Every
        // other case here carries a date, and dates win — so without this the
        // field could be passed as `undefined` and nothing would notice, which
        // is the whole fallback arm gone silently.
        expect(mapOrangeHrmStatus({ empStatus: { name: 'Terminated' } }, enrich(), now)).toBe('TERMINATED');
        expect(mapOrangeHrmStatus({ empStatus: { name: 'On Leave' } }, enrich(), now)).toBe('LEAVE');
    });
});

// ───────────────────────────── normalisation ───────────────────────────────

describe('normalisation', () => {
    it('hrisRecordId is empNumber — the handle an OrangeHRM update is addressed by', async () => {
        // The whole reason this provider exists. BambooHR's hrisRecordId comes
        // from `r.id`, whose presence is Open Question 2; Workday has none.
        // OrangeHRM publishes empNumber as a first-class list field, so the
        // write-back rehearsal has a subject that is not a guess.
        const fetchImpl = rosterFetch([row(7, { empNumber: 7, employeeId: 'BADGE-7' })], () => 'p7@acme.test');
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].hrisRecordId).toBe('7');
    });

    it('externalId is the badge number, NOT the record id', async () => {
        // externalId is provenance and not an address; mirroring BambooHR's
        // `employeeNumber || workEmail` keeps the two fields meaning the same
        // thing across providers.
        const fetchImpl = rosterFetch([row(7, { empNumber: 7, employeeId: 'BADGE-7' })], () => 'p7@acme.test');
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].externalId).toBe('BADGE-7');
        expect(employees[0].externalId).not.toBe('7');
    });

    it('drops a row with no empNumber — it cannot be enriched, so it has no email', async () => {
        // This asserted a null hrisRecordId until #2587, when the email moved
        // to a per-employee call addressed BY empNumber. Without one there is
        // no contact-details URL to build, so such a row can never acquire a
        // work email and is dropped by the same rule that drops a contractor.
        // The alternative is a request to `/pim/employee//contact-details`.
        const fetchImpl = rosterFetch([row(7, { empNumber: null }), row(8)], (n) => `p${n}@acme.test`);
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees).toHaveLength(1);
        expect(employees[0].hrisRecordId).toBe('8');
        expect(fetchImpl.mock.calls.every((c) => !/\/employee\/\/|\/employees\/\//.test(String(c[0])))).toBe(true);
    });

    it('externalId falls back to the work email when the badge number is blank', async () => {
        const fetchImpl = rosterFetch([row(7, { employeeId: '  ' })], () => 'p7@acme.test');
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].externalId).toBe('p7@acme.test');
        expect(employees[0].hrisRecordId).toBe('7');
    });

    it('reads the work email from the per-employee contact-details call', async () => {
        // The list row carries no email at all on a real 5.9 instance, so this
        // is the ONLY path by which an employee acquires one. Verified against
        // a live instance before this test was written (#2587).
        const fetchImpl = rosterFetch([row(1)], () => 'enriched@acme.test');
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].workEmail).toBe('enriched@acme.test');
    });

    it('resolves the manager by supervisor empNumber — the entry carries NO email', async () => {
        // A live 5.9 returns {empNumber, firstName, lastName, middleName} for a
        // supervisor and nothing more, so reading `s.workEmail` here yielded
        // null for every employee who had a manager (#2587). Verified by
        // assigning a real supervisor on a real instance.
        const fetchImpl = rosterFetch([row(1, { supervisors: [{ empNumber: 9 }] })], (n) =>
            n === 9 ? 'boss@acme.test' : `p${n}@acme.test`,
        );
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].managerEmail).toBe('boss@acme.test');
    });

    it('takes the FIRST supervisor when an employee has several', async () => {
        const fetchImpl = rosterFetch([row(1, { supervisors: [{ empNumber: 9 }, { empNumber: 8 }] })], (n) =>
            n === 9 ? 'first@acme.test' : n === 8 ? 'second@acme.test' : `p${n}@acme.test`,
        );
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].managerEmail).toBe('first@acme.test');
    });

    it('a manager shared by many reports is fetched ONCE, not once per report', async () => {
        // The cache is the whole reason the manager graph does not multiply the
        // request count. Without it this is 30 extra calls, and the enrichment
        // phase is already the expensive half of the run.
        const rows = Array.from({ length: 30 }, (_, k) => row(k + 10, { supervisors: [{ empNumber: 9 }] }));
        const fetchImpl = rosterFetch(rows, (n) => (n === 9 ? 'boss@acme.test' : `p${n}@acme.test`));
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees).toHaveLength(30);
        expect(employees.every((e) => e.managerEmail === 'boss@acme.test')).toBe(true);
        const bossCalls = fetchImpl.mock.calls.filter((c) => /\/employee\/9\/contact-details/.test(String(c[0])));
        expect(bossCalls).toHaveLength(1);
    });

    it('no supervisor means no manager, not a dropped employee', async () => {
        const fetchImpl = rosterFetch([row(1, { supervisors: [] })], () => 'p1@acme.test');
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees[0].managerEmail).toBeNull();
    });

    it('drops a row with no work email rather than inventing a key', async () => {
        const fetchImpl = rosterFetch([row(1), row(2)], (n) => (n === 2 ? null : `p${n}@acme.test`));
        const { employees } = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(employees).toHaveLength(1);
        expect(employees[0].workEmail).toBe('p1@acme.test');
    });
});

// ─────────── the refusal that makes an unverified mapping safe ─────────────

describe('an all-dropped roster is refused, not reported complete', () => {
    it('throws when rows came back and none carried a work email', async () => {
        // complete:true with an empty roster is the mass-terminate path: on any
        // run after the first of a pass the departure reconcile fires and marks
        // everyone it has not touched TERMINATED.
        const fetchImpl = rosterFetch([row(1), row(2)], () => null);
        await expect(readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl })).rejects.toThrow(
            /none carried a work email/,
        );
    });

    it('POSITIVE CONTROL — a genuinely empty roster is NOT refused', async () => {
        // The refusal is scoped to "rows came back and none normalised". An
        // instance with no employees at all is a different fact and must stay a
        // clean, complete, empty read.
        const fetchImpl = mockFetch(async () => json({ data: [] }));
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(r.employees).toEqual([]);
        expect(r.complete).toBe(true);
    });

    it('POSITIVE CONTROL — one surviving row is enough to keep the read', async () => {
        // A page of contractors with no work email beside one real employee is
        // an ordinary roster, not a mapping failure.
        const fetchImpl = rosterFetch([row(1), row(2)], (n) => (n === 1 ? null : `p${n}@acme.test`));
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(r.employees).toHaveLength(1);
        expect(r.complete).toBe(true);
    });
});

// ──────────────────────── pagination and completeness ──────────────────────

describe('pagination and the completeness claim', () => {
    it('pages until a short page and reports the roster complete', async () => {
        const total = ORANGEHRM_PAGE_SIZE + 3;
        const fetchImpl = pagedFetch(total);
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(r.employees).toHaveLength(total);
        expect(r.complete).toBe(true);
        expect(r.resumeToken).toBeNull();
        expect(pageCalls(fetchImpl)).toBe(2);
    });

    it('a full final page is NOT the end — it reads one more', async () => {
        // Stopping at an exactly-full page would silently truncate a roster
        // whose size is a multiple of the page size, and call it complete.
        const fetchImpl = pagedFetch(ORANGEHRM_PAGE_SIZE);
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(pageCalls(fetchImpl)).toBe(2);
        expect(r.complete).toBe(true);
    });

    it('dropped rows do not end the pass — the short-page test counts RAW rows', async () => {
        // Counting normalised rows here would make a full page of email-less
        // rows look like the end of the roster and truncate the pass silently.
        const emailless = mockFetch(async (url) => {
            const contact = /\/pim\/employee\/(\d+)\/contact-details/.exec(url);
            // Only employee 999 has an email; the first full page has none.
            if (contact) return json({ data: { workEmail: contact[1] === '999' ? 'p999@acme.test' : null } });
            if (/\/job-details/.test(url)) return json({ data: { joinedDate: null, employeeTerminationRecord: { id: null, date: null } } });
            const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
            if (offset === 0) {
                return json({ data: Array.from({ length: ORANGEHRM_PAGE_SIZE }, (_, k) => row(k)) });
            }
            return json({ data: [row(999)] });
        });
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl: emailless });
        expect(pageCalls(emailless)).toBe(2);
        expect(r.employees).toHaveLength(1);
        expect(r.complete).toBe(true);
    });

    it('hands back a resume cursor when the per-run row cap is reached', async () => {
        const fetchImpl = pagedFetch(ORANGEHRM_MAX_PER_RUN + ORANGEHRM_PAGE_SIZE);
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        expect(r.employees).toHaveLength(ORANGEHRM_MAX_PER_RUN);
        expect(r.complete).toBe(false);
        expect(r.resumeToken).toBe(String(ORANGEHRM_MAX_PER_RUN));
        expect(pageCalls(fetchImpl)).toBe(ORANGEHRM_MAX_PAGES_PER_RUN);
    });

    it('resumes from the cursor instead of re-reading the pass from zero', async () => {
        const fetchImpl = pagedFetch(ORANGEHRM_PAGE_SIZE + 2);
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', String(ORANGEHRM_PAGE_SIZE), { fetchImpl });
        expect(r.employees).toHaveLength(2);
        const [firstUrl] = fetchImpl.mock.calls[0] as unknown as [string];
        expect(new URL(firstUrl).searchParams.get('offset')).toBe(String(ORANGEHRM_PAGE_SIZE));
    });

    it('refuses a malformed cursor rather than restarting from zero', async () => {
        // A silent restart would re-upsert everything AND make a pass that
        // never completes look like one that keeps making progress.
        const fetchImpl = mockFetch(async () => json({ data: [] }));
        await expect(readOrangeHrmRoster({ host: HOST }, 'tok', 'not-a-number', { fetchImpl })).rejects.toThrow(
            /Invalid OrangeHRM resume cursor/,
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('a non-ok roster response throws rather than returning a short roster', async () => {
        const fetchImpl = mockFetch(async () => json({}, { ok: false, status: 500 }));
        await expect(readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl })).rejects.toThrow(/HTTP 500/);
    });

    it('requests the detailed model and past employees', async () => {
        // Filtering past employees out would make a terminated employee
        // indistinguishable from a deleted one, and the reconcile reads absence
        // as deletion.
        const fetchImpl = pagedFetch(1);
        await readOrangeHrmRoster({ host: HOST }, 'tok', null, { fetchImpl });
        const [url] = fetchImpl.mock.calls[0] as unknown as [string];
        const params = new URL(url).searchParams;
        expect(params.get('model')).toBe('detailed');
        expect(params.get('includeEmployees')).toBe('currentAndPast');
        expect(params.get('limit')).toBe(String(ORANGEHRM_PAGE_SIZE));
    });
});

// ───────────────────────────── the read deadline ───────────────────────────

describe('the read deadline keeps the roster read inside the lock lease', () => {
    it('stops paging once the budget is spent and hands back a cursor', async () => {
        const fetchImpl = pagedFetch(ORANGEHRM_PAGE_SIZE * 4);
        let ticks = 0;
        // Advances one minute per page, so the second check is past the budget.
        const now = () => new Date(1_000_000 + ticks++ * 60_000);
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, {
            fetchImpl,
            now,
            readDeadlineAt: 1_000_000 + 30_000,
        });
        expect(pageCalls(fetchImpl)).toBe(1);
        expect(r.complete).toBe(false);
        expect(r.resumeToken).toBe(String(ORANGEHRM_PAGE_SIZE));
    });

    it('a short page outranks the deadline — a finished roster is not reported partial', async () => {
        // Checking the clock first would store a cursor past the end of the
        // roster and defer the departure reconcile a whole scheduled run to
        // discover what this run already knew.
        const fetchImpl = pagedFetch(3);
        let ticks = 0;
        const now = () => new Date(1_000_000 + ticks++ * 60_000);
        const r = await readOrangeHrmRoster({ host: HOST }, 'tok', null, {
            fetchImpl,
            now,
            readDeadlineAt: 1_000_000 + 30_000,
        });
        expect(r.complete).toBe(true);
        expect(r.resumeToken).toBeNull();
    });
});

// ──────────────────────── the provider's own seams ─────────────────────────

describe('the provider wires the two halves together', () => {
    it('refuses BEFORE any request when the connection is incomplete', async () => {
        const readRoster = jest.fn(async () => ({ employees: [], complete: true, resumeToken: null }));
        const fetchToken = jest.fn(async () => 'tok');
        const p = new OrangeHrmProvider({ readRoster, fetchToken });
        await expect(p.listEmployees({ ...GOOD, clientSecret: '' })).rejects.toThrow(/incomplete/i);
        expect(fetchToken).not.toHaveBeenCalled();
        expect(readRoster).not.toHaveBeenCalled();
    });

    it('a dead credential propagates as a throw — it is not swallowed into an empty roster', async () => {
        // An empty roster reported complete is the mass-terminate path.
        const readRoster = jest.fn(async () => ({ employees: [], complete: true, resumeToken: null }));
        const p = new OrangeHrmProvider({
            fetchToken: jest.fn(async () => {
                throw new Error('OrangeHRM token request failed: 401');
            }),
            readRoster,
        });
        await expect(p.listEmployees(GOOD)).rejects.toThrow('401');
        expect(readRoster).not.toHaveBeenCalled();
    });

    it('carries the roster read’s incompleteness through unchanged', async () => {
        // The provider must not round a partial roster up to complete — that
        // flag is what the departure reconcile keys on.
        const p = new OrangeHrmProvider({
            fetchToken: jest.fn(async () => 'tok'),
            readRoster: jest.fn(async () => ({ employees: [], complete: false, resumeToken: '50' })),
        });
        const r = await p.listEmployees(GOOD);
        expect(r.complete).toBe(false);
        expect(r.resumeToken).toBe('50');
    });

    it('forwards the run’s read deadline rather than starting a fresh budget', async () => {
        // A fresh budget at the roster call would let a slow token exchange
        // push the read past the lock lease it is meant to fit inside (#2508).
        const readRoster = jest.fn(async () => ({ employees: [], complete: true, resumeToken: null }));
        const p = new OrangeHrmProvider({ fetchToken: jest.fn(async () => 'tok'), readRoster });
        await p.listEmployees(GOOD, '50', { readDeadlineAt: 12_345 });

        const call = readRoster.mock.calls[0] as unknown as [
            { host: string },
            string,
            string | null,
            { readDeadlineAt?: number },
        ];
        expect(call[1]).toBe('tok');
        expect(call[2]).toBe('50');
        expect(call[3].readDeadlineAt).toBe(12_345);
    });
});

describe('validateConnection', () => {
    it('names every missing field at once', async () => {
        const r = await new OrangeHrmProvider().validateConnection({}, {});
        expect(r.valid).toBe(false);
        expect(r.error).toContain('baseUrl');
        expect(r.error).toContain('clientId');
        expect(r.error).toContain('clientSecret');
    });

    it('rejects an off-domain host without probing it', async () => {
        const fetchToken = jest.fn(async () => 'tok');
        const p = new OrangeHrmProvider({ fetchToken });
        const r = await p.validateConnection({ baseUrl: 'attacker.test', clientId: 'c' }, { clientSecret: 's' });
        expect(r.valid).toBe(false);
        expect(fetchToken).not.toHaveBeenCalled();
    });

    it('makes a REAL token exchange and reports its failure', async () => {
        const p = new OrangeHrmProvider({
            fetchToken: jest.fn(async () => {
                throw new Error('OrangeHRM token request failed: 401');
            }),
        });
        const r = await p.validateConnection({ baseUrl: HOST, clientId: 'c' }, { clientSecret: 's' });
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/rejected the credentials/);
    });

    it('is valid when the exchange succeeds, and declares itself a live check', async () => {
        const p = new OrangeHrmProvider({ fetchToken: jest.fn(async () => 'tok') });
        const r = await p.validateConnection({ baseUrl: HOST, clientId: 'c' }, { clientSecret: 's' });
        expect(r.valid).toBe(true);
        expect(p.liveValidation).toBe(true);
    });
});
