/**
 * JML HRIS write-back, Phase 1 (#2639) — the credential gate and the LIVE
 * preflight, over a faked fetch.
 *
 * ═══ WHAT THIS FILE IS DEFENDING ═══
 *
 * Phase 1 ships vocabulary and a credential check and NO WRITE. Three things
 * can go wrong with that, and each is invisible without a test:
 *
 *   1. A PREFLIGHT THAT WRITES. The design's Phase 2 is blocked on the joiner
 *      settling what a pre-hire is, so a mutating request from this path would
 *      be shipping the blocked half by accident. Every request the preflight
 *      makes is asserted, by method and by URL.
 *
 *   2. A PREFLIGHT THAT TRUSTS ONE READ. Against a live orangehrm 5.9 (#2587)
 *      the list row carries the write-back handle (`empNumber`) and does NOT
 *      carry the work email at any `model` — while the same employee's
 *      contact-details endpoint returns one. "Handle present, identity field
 *      absent" is a real vendor shape. A preflight that concluded from a roster
 *      page that it had seen both would report a green for a path it never
 *      touched, so the A/B is pinned in BOTH directions here.
 *
 *   3. A GATE THAT IS SKIPPED. The rung and the per-connection opt-in are the
 *      whole consent story of this phase. They are asserted at the PROVIDER
 *      METHOD — the call site — and by counting network calls, because a gate
 *      that the caller stops calling is a gate that still passes its own unit
 *      tests.
 *
 * No live credentials and no network: every test drives `fetchImpl` or an
 * injected double, so the suite runs from a clean checkout.
 */
import { BambooHrProvider, isHrisSyncProvider } from '@/app-layer/integrations/providers/hris';
import {
    describeWriteBackEnabled,
    gateWriteBackPreflight,
    isHrisWriteBackPreflightProvider,
    readWriteBackEnabled,
    writeBackPreflightResult,
    HRIS_WRITEBACK_MAX_MODE,
    WRITE_BACK_ENABLED_FIELD,
} from '@/app-layer/integrations/providers/hris/write-back';
import { OrangeHrmProvider } from '@/app-layer/integrations/providers/orangehrm';
import { OrangeHrmTokenError } from '@/app-layer/integrations/providers/orangehrm/token';
import {
    preflightOrangeHrmWriteBack,
    ORANGEHRM_IDENTITY_FIELD,
} from '@/app-layer/integrations/providers/orangehrm/write-back-preflight';
import { CONFIG_FIELD_RULES } from '@/app-layer/integrations/config-schema';
import { IntegrationAuthError, IntegrationTerminalError } from '@/app-layer/integrations/http-resilience';
import { LADDER, isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';

const HOST = 'acme.orangehrmlive.com';
const CLIENT = { host: HOST, clientId: 'cid', clientSecret: 'csecret' };
/** A connection that has opted in and is otherwise complete. */
const ENABLED_CONFIG = { baseUrl: HOST, clientId: 'cid', clientSecret: 'csecret', writeBackEnabled: true };

const json = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
    ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body }) as unknown as Response;

const mockFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
    jest.fn(impl) as unknown as jest.MockedFunction<typeof fetch>;

/**
 * A list row exactly as 5.9 returns one — no `workEmail`, no `contactDetails`.
 * Copied from `tests/unit/orangehrm-provider.test.ts`'s `row`, whose docblock
 * records why inventing an email onto it is how fifty green tests coexisted
 * with a connector that could not normalise a single employee.
 */
const listRow = (empNumber: unknown = 7) => ({
    empNumber,
    employeeId: 'BADGE-7',
    firstName: 'Person',
    middleName: '',
    lastName: '7',
    jobTitle: { title: null },
    subunit: { name: null },
    empStatus: { name: null },
    supervisors: [],
    terminationId: null,
});

/**
 * The three responses a healthy instance gives, with each stage overridable.
 *
 * `contact` is a THUNK returning the response so a test can throw from it, and
 * the default carries `workEmail: null` — the explicit-null shape 5.9 returns
 * for an empty field, which is the expected pre-hire state.
 */
function instance(over: {
    token?: () => Promise<Response>;
    list?: () => Promise<Response>;
    contact?: () => Promise<Response>;
} = {}) {
    return mockFetch(async (url) => {
        if (/\/oauth2\/token/.test(url)) return (over.token ?? (async () => json({ access_token: 'tok' })))();
        if (/\/pim\/employee\/\d+\/contact-details/.test(url)) {
            return (over.contact ?? (async () => json({ data: { workEmail: null, countryCode: null } })))();
        }
        if (/\/pim\/employees(\?|$)/.test(url)) {
            return (over.list ?? (async () => json({ data: [listRow()] })))();
        }
        throw new Error(`unexpected URL in preflight test: ${url}`);
    });
}

/** Every URL the double was called with, in order. */
const urls = (f: jest.MockedFunction<typeof fetch>) => f.mock.calls.map((c) => String(c[0]));
/** Every HTTP method, with an absent one rendered as the GET it is. */
const methods = (f: jest.MockedFunction<typeof fetch>) =>
    f.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase());

describe('HRIS write-back Phase 1 — the ladder clamp', () => {
    it('HRIS_WRITEBACK_MAX_MODE is a rung of the shared ladder', () => {
        // The tripwire `write-ladder.ts` asks for: a clamp that is not a rung
        // sorts to -1 in `isAboveClamp`, which reads as "nothing is above it"
        // — a ceiling that silently stops being one.
        expect(LADDER).toContain(HRIS_WRITEBACK_MAX_MODE);
    });

    it('refuses every rung ABOVE the clamp and permits every rung at or below it', () => {
        // Stated as the ladder's own partition rather than three literals, so a
        // rung added above AUTOMATIC lands in the refused half with no edit.
        const refused = LADDER.filter((m) => gateWriteBackPreflight({ provider: 'orangehrm', config: ENABLED_CONFIG, mode: m })?.outcome === 'REFUSED_MODE');
        const expected = LADDER.filter((m) => m === 'DISABLED' || isAboveClamp(m, HRIS_WRITEBACK_MAX_MODE));
        expect(refused).toEqual(expected);
        // The denominator, so an empty ladder could not make this vacuous.
        expect(LADDER.length).toBeGreaterThanOrEqual(3);
        // And the positive control: at least one rung is NOT refused, or the
        // partition above would be satisfied by a gate that refuses everything.
        expect(LADDER.filter((m) => !expected.includes(m))).toEqual(['DRY_RUN']);
    });

    it('AUTOMATIC is refused today, and the refusal says the write does not exist', () => {
        const r = gateWriteBackPreflight({ provider: 'orangehrm', config: ENABLED_CONFIG, mode: 'AUTOMATIC' });
        expect(r?.outcome).toBe('REFUSED_MODE');
        expect(r?.detail).toContain('above the HRIS write-back ceiling of DRY_RUN');
        expect(r?.writeProven).toBe(false);
    });

    it('DISABLED is refused before the opt-in is even consulted', () => {
        // Order matters: a tenant that has switched identity writes off must
        // not be told to tick a connection checkbox that would change nothing.
        const r = gateWriteBackPreflight({ provider: 'orangehrm', config: {}, mode: 'DISABLED' });
        expect(r?.outcome).toBe('REFUSED_MODE');
        expect(r?.detail).not.toMatch(/Allow HRIS write-back/);
    });
});

describe('HRIS write-back Phase 1 — the per-connection opt-in', () => {
    it('is strict: only the boolean true opts in', () => {
        expect(readWriteBackEnabled({ [WRITE_BACK_ENABLED_FIELD]: true })).toBe(true);
        for (const value of ['true', 'yes', 'on', '1', 1, {}, [], 'false', false, null, undefined]) {
            expect(readWriteBackEnabled({ [WRITE_BACK_ENABLED_FIELD]: value })).toBe(false);
        }
        expect(readWriteBackEnabled({})).toBe(false);
    });

    it('refuses a connection that has not opted in, at DRY_RUN', () => {
        const r = gateWriteBackPreflight({ provider: 'orangehrm', config: { baseUrl: HOST }, mode: 'DRY_RUN' });
        expect(r?.outcome).toBe('REFUSED_WRITE_BACK_DISABLED');
        expect(r?.detail).toContain('separate opt-in from directory writes');
    });

    it('lets an opted-in connection through to the live half', () => {
        expect(gateWriteBackPreflight({ provider: 'orangehrm', config: ENABLED_CONFIG, mode: 'DRY_RUN' })).toBeNull();
    });

    it('says something USEFUL about a stored value that looks affirmative', () => {
        // The Entra lesson repeated: an operator who ticked the box and is told
        // to tick the box has been told nothing. A string "true" reads as ON in
        // the admin UI and OFF here.
        const r = gateWriteBackPreflight({
            provider: 'orangehrm',
            config: { [WRITE_BACK_ENABLED_FIELD]: 'true' },
            mode: 'DRY_RUN',
        });
        expect(r?.outcome).toBe('REFUSED_WRITE_BACK_DISABLED');
        expect(r?.detail).toContain('reads as ON in the admin UI and OFF here');
    });

    it('describes a non-affirmative stored value differently, and an absent one not at all', () => {
        expect(describeWriteBackEnabled(undefined)).toBe('');
        expect(describeWriteBackEnabled(null)).toBe('');
        expect(describeWriteBackEnabled(false)).toBe('');
        expect(describeWriteBackEnabled('off')).toContain('which is not an opt-in');
        expect(describeWriteBackEnabled(1)).toContain('reads as ON in the admin UI');
    });
});

describe('HRIS write-back Phase 1 — the result cannot overclaim', () => {
    it('refuses to build WRITE_PATH_READABLE without all three observations', () => {
        const base = {
            outcome: 'WRITE_PATH_READABLE' as const,
            provider: 'orangehrm',
            detail: 'x',
            authenticated: true,
            handleObserved: true,
            identityFieldReadable: true,
        };
        expect(() => writeBackPreflightResult(base)).not.toThrow();
        expect(() => writeBackPreflightResult({ ...base, authenticated: false })).toThrow(
            /without all three observations/,
        );
        expect(() => writeBackPreflightResult({ ...base, handleObserved: false })).toThrow(
            /without all three observations/,
        );
        expect(() => writeBackPreflightResult({ ...base, identityFieldReadable: false })).toThrow(
            /without all three observations/,
        );
    });

    it('writeProven is false on every result this module can build', () => {
        // The one claim Phase 1 may never make. Proving a credential can write
        // requires writing, which this phase does not do.
        const outcomes = [
            'WRITE_PATH_READABLE',
            'REFUSED_WRITE_BACK_DISABLED',
            'REFUSED_MODE',
            'REFUSED_NO_HANDLE',
            'REFUSED_IDENTITY_FIELD_UNREADABLE',
            'REFUSED_CREDENTIAL',
            'PREFLIGHT_INDETERMINATE',
        ] as const;
        for (const outcome of outcomes) {
            const r = writeBackPreflightResult({
                outcome,
                provider: 'orangehrm',
                detail: 'x',
                authenticated: true,
                handleObserved: true,
                identityFieldReadable: true,
            });
            expect(r.writeProven).toBe(false);
        }
        expect(outcomes.length).toBe(7);
    });
});

describe('OrangeHRM write-back preflight — the happy path reads twice and writes never', () => {
    it('authenticates, finds the handle in the LIST, and reads the field per RECORD', async () => {
        const f = instance();
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });

        expect(r.outcome).toBe('WRITE_PATH_READABLE');
        expect(r).toMatchObject({
            provider: 'orangehrm',
            authenticated: true,
            handleObserved: true,
            identityFieldReadable: true,
            writeProven: false,
        });
        // The verdict must not be mistaken for "it can write".
        expect(r.detail).toContain('Whether this credential may WRITE is not established');

        // Three calls, in order, and the third is the SINGULAR per-record path.
        const seen = urls(f);
        expect(seen).toHaveLength(3);
        expect(seen[0]).toContain('/oauth2/token');
        expect(seen[1]).toContain('/api/v2/pim/employees?');
        expect(seen[2]).toBe(
            `https://${HOST}/web/index.php/api/v2/pim/employee/7/contact-details`,
        );
    });

    it('sends exactly one POST — the OAuth token exchange — and nothing else mutating', async () => {
        // The whole of Phase 1's safety claim, expressed as a count. A PUT or a
        // PATCH appearing here is the blocked Phase 2 shipping by accident.
        const f = instance();
        await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(methods(f)).toEqual(['POST', 'GET', 'GET']);
        expect(urls(f)[0]).toContain('/oauth2/token');
        expect(methods(f).filter((m) => ['PUT', 'PATCH', 'DELETE'].includes(m))).toEqual([]);
    });

    it('pins the ordering the roster read also pins, so the probe subject is stable', async () => {
        const f = instance();
        await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        const list = new URL(urls(f)[1]);
        expect(list.searchParams.get('sortField')).toBe('employee.empNumber');
        expect(list.searchParams.get('sortOrder')).toBe('ASC');
        expect(list.searchParams.get('limit')).toBe('1');
        // Without this an instance whose only rows are past employees reads as
        // an empty roster and a good credential is refused.
        expect(list.searchParams.get('includeEmployees')).toBe('currentAndPast');
    });
});

describe('OrangeHRM write-back preflight — handle present, identity field absent (#2587)', () => {
    it('does not take the identity field from the list row, even when one is there', async () => {
        // The A/B, in the direction that catches a shortcut: hand the list a
        // work email (a shape 5.9 does NOT emit) and the per-record call must
        // still happen. A preflight that trusted the row would stop at two
        // calls and report a green for a path it never touched.
        const f = instance({ list: async () => json({ data: [{ ...listRow(), workEmail: 'someone@acme.test' }] }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });

        expect(urls(f)).toHaveLength(3);
        expect(urls(f)[2]).toContain('/contact-details');
        expect(r.outcome).toBe('WRITE_PATH_READABLE');
    });

    it('reaches WRITE_PATH_READABLE from the REAL 5.9 shape, whose list row has no email', async () => {
        // The other direction: the row this vendor actually sends carries no
        // `workEmail` key at all, and that is not a refusal — it is why the
        // second read exists.
        const f = instance();
        expect(Object.prototype.hasOwnProperty.call(listRow(), 'workEmail')).toBe(false);
        expect((await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f })).outcome).toBe('WRITE_PATH_READABLE');
    });

    it('an EXPLICIT NULL work email is the expected pre-hire state, not a refusal', async () => {
        const f = instance({ contact: async () => json({ data: { [ORANGEHRM_IDENTITY_FIELD]: null } }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('WRITE_PATH_READABLE');
        expect(r.identityFieldReadable).toBe(true);
    });

    it('an ABSENT work email KEY is a refusal, because the shape cannot carry the write', async () => {
        // Present-and-null vs absent is the distinction the whole second read
        // exists to make, and on 5.9 sibling keys come back as explicit null,
        // which is what makes it observable at all.
        const f = instance({ contact: async () => json({ data: { countryCode: null, street1: null } }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('REFUSED_IDENTITY_FIELD_UNREADABLE');
        expect(r.handleObserved).toBe(true);
        expect(r.identityFieldReadable).toBe(false);
        expect(r.detail).toContain('absent is not the same as the field being empty');
    });

    it('a NON-EMPTY work email on the probe subject is not a refusal either', async () => {
        // Whose record it is does not matter: emptiness is a CANDIDATE fact
        // belonging to Phase 2's conditional, and reading it as a connection
        // fact would refuse a whole batch because employee #1 has an address.
        const f = instance({ contact: async () => json({ data: { workEmail: 'taken@acme.test' } }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('WRITE_PATH_READABLE');
        // …and the value never leaves the preflight.
        expect(r.detail).not.toContain('taken@acme.test');
    });
});

describe('OrangeHRM write-back preflight — what each failure PROVES', () => {
    it('a roster read that succeeded with no rows refuses NO_HANDLE', async () => {
        const f = instance({ list: async () => json({ data: [] }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('REFUSED_NO_HANDLE');
        expect(r.authenticated).toBe(true);
        expect(urls(f)).toHaveLength(2);
    });

    it('a row with no empNumber refuses NO_HANDLE rather than falling back to the badge number', async () => {
        const f = instance({ list: async () => json({ data: [listRow(null)] }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('REFUSED_NO_HANDLE');
        expect(r.detail).toContain('empNumber');
        // BADGE-7 is on the row and must never become an address.
        expect(urls(f).some((u) => u.includes('BADGE-7'))).toBe(false);
    });

    it('a roster read that FAILED is indeterminate, never NO_HANDLE', async () => {
        // A failed read proves nothing about what the roster holds, and
        // NO_HANDLE is a claim about the roster's contents.
        const f = instance({ list: async () => json({ ok: false }, { ok: false, status: 503 }) });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('PREFLIGHT_INDETERMINATE');
        expect(r.handleObserved).toBe(false);
    });

    it('401 on the roster read is a PROVEN credential refusal', async () => {
        const f = instance({
            list: async () => {
                throw new IntegrationAuthError(401, 'https://x/pim/employees');
            },
        });
        expect((await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f })).outcome).toBe('REFUSED_CREDENTIAL');
    });

    it('401 on contact-details is a credential refusal, not a field problem', async () => {
        const f = instance({
            contact: async () => {
                throw new IntegrationAuthError(403, 'https://x/pim/employee/7/contact-details');
            },
        });
        const r = await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f });
        expect(r.outcome).toBe('REFUSED_CREDENTIAL');
        // `IntegrationAuthError extends IntegrationTerminalError`, so an
        // instanceof test in the wrong order turns a revoked credential into a
        // 404-shaped answer about one record.
        expect(r.handleObserved).toBe(true);
    });

    it('404 on contact-details says the FIELD is unreachable, and is told apart from 401', async () => {
        const f = instance({
            contact: async () => {
                throw new IntegrationTerminalError(404, 'https://x/pim/employee/7/contact-details');
            },
        });
        expect((await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f })).outcome).toBe(
            'REFUSED_IDENTITY_FIELD_UNREADABLE',
        );
    });

    it('a 5xx on contact-details is indeterminate', async () => {
        const f = instance({ contact: async () => json({}, { ok: false, status: 500 }) });
        expect((await preflightOrangeHrmWriteBack(CLIENT, { fetchImpl: f })).outcome).toBe('PREFLIGHT_INDETERMINATE');
    });

    it('a token exchange rejected with a status is a PROVEN credential refusal', async () => {
        // OAuth2 says `invalid_client` with a 400, not a 401. The status is
        // carried on the error rather than parsed back out of its message.
        const f = instance();
        const r = await preflightOrangeHrmWriteBack(CLIENT, {
            fetchImpl: f,
            fetchToken: async () => {
                throw new OrangeHrmTokenError(400);
            },
        });
        expect(r.outcome).toBe('REFUSED_CREDENTIAL');
        expect(r.detail).toContain('HTTP 400');
        expect(r.authenticated).toBe(false);
    });

    it('a token exchange that was LOST is indeterminate', async () => {
        const r = await preflightOrangeHrmWriteBack(CLIENT, {
            fetchImpl: instance(),
            fetchToken: async () => {
                throw new Error('ETIMEDOUT');
            },
        });
        expect(r.outcome).toBe('PREFLIGHT_INDETERMINATE');
    });

    it('an off-allowlist host refuses BEFORE any request, so no secret leaves', async () => {
        const f = instance();
        const r = await preflightOrangeHrmWriteBack({ ...CLIENT, host: 'attacker.example.com' }, { fetchImpl: f });
        expect(r.outcome).toBe('REFUSED_CREDENTIAL');
        expect(f).not.toHaveBeenCalled();
    });
});

describe('OrangeHrmProvider.writeBackPreflight — the gate at the CALL SITE', () => {
    const provider = (over: { fetchImpl?: typeof fetch } = {}) => new OrangeHrmProvider(over);

    it('is recognised by the seam test', () => {
        expect(isHrisWriteBackPreflightProvider(provider())).toBe(true);
        // …and the sync seam is untouched by it.
        expect(isHrisSyncProvider(provider())).toBe(true);
    });

    it('makes NO network call when the tenant rung refuses', async () => {
        const f = instance();
        const r = await provider({ fetchImpl: f }).writeBackPreflight(ENABLED_CONFIG, 'DISABLED');
        expect(r.outcome).toBe('REFUSED_MODE');
        expect(f).not.toHaveBeenCalled();
    });

    it('makes NO network call when the connection has not opted in', async () => {
        const f = instance();
        const r = await provider({ fetchImpl: f }).writeBackPreflight(
            { baseUrl: HOST, clientId: 'cid', clientSecret: 'csecret' },
            'DRY_RUN',
        );
        expect(r.outcome).toBe('REFUSED_WRITE_BACK_DISABLED');
        expect(f).not.toHaveBeenCalled();
    });

    it('makes NO network call when the rung is above the clamp', async () => {
        const f = instance();
        const r = await provider({ fetchImpl: f }).writeBackPreflight(ENABLED_CONFIG, 'AUTOMATIC');
        expect(r.outcome).toBe('REFUSED_MODE');
        expect(f).not.toHaveBeenCalled();
    });

    it('runs the live half once both gates pass', async () => {
        const f = instance();
        const r = await provider({ fetchImpl: f }).writeBackPreflight(ENABLED_CONFIG, 'DRY_RUN');
        expect(r.outcome).toBe('WRITE_PATH_READABLE');
        expect(urls(f)).toHaveLength(3);
    });

    it('an incomplete connection is a PROVEN refusal, with every missing field named', async () => {
        const f = instance();
        const r = await provider({ fetchImpl: f }).writeBackPreflight(
            { writeBackEnabled: true, baseUrl: HOST },
            'DRY_RUN',
        );
        expect(r.outcome).toBe('REFUSED_CREDENTIAL');
        expect(r.detail).toContain('clientId');
        expect(r.detail).toContain('clientSecret');
        expect(f).not.toHaveBeenCalled();
    });
});

describe('the opt-in is declared, classified, and NOT offered where it cannot be checked', () => {
    it('OrangeHRM declares it as an optional boolean', () => {
        const field = new OrangeHrmProvider().configSchema.configFields.find(
            (x) => x.key === WRITE_BACK_ENABLED_FIELD,
        );
        expect(field).toBeDefined();
        // `type: 'boolean'` is load bearing beyond the widget: the admin page
        // derives which keys `coerceDeclaredBooleans` converts from exactly
        // this, and the strict `=== true` read is what makes a string 'true'
        // stay off.
        expect(field!.type).toBe('boolean');
        expect(field!.required).toBe(false);
    });

    it('every OrangeHRM config field carries a rule, so the new one cannot reach configJson unclassified', () => {
        // `validateProviderConfig` throws 400 for an undeclared key, so a field
        // added here without a rule breaks connection saving outright — which
        // is the right failure and a terrible way to find out.
        const declared = new OrangeHrmProvider().configSchema.configFields.map((x) => x.key);
        const classified = Object.keys(CONFIG_FIELD_RULES.orangehrm ?? {});
        expect(declared.filter((k) => !classified.includes(k))).toEqual([]);
        expect(declared).toContain(WRITE_BACK_ENABLED_FIELD);
    });

    it('BambooHR does NOT declare it, and that is a decision rather than an oversight', () => {
        // Open Question 1 — does BambooHR expose an employee-update API at the
        // same gateway base with the same Basic auth? — is not unanswered, it
        // is unanswerable from this repo: there is no tenant to ask, and
        // `liveValidation = false` means nothing has ever proven that key does
        // anything. A checkbox is a question put to a customer, and this one
        // cannot be honoured or even preflighted, so it is not asked yet.
        //
        // WHEN THAT CHANGES: add the field, add a BambooHR preflight, and
        // delete this test in the same diff.
        const bamboo = new BambooHrProvider();
        expect(bamboo.configSchema.configFields.map((x) => x.key)).not.toContain(WRITE_BACK_ENABLED_FIELD);
        expect(isHrisWriteBackPreflightProvider(bamboo)).toBe(false);
    });
});

describe('Phase 2 has not shipped', () => {
    it('no mode above the clamp can reach the live half, whatever the ladder grows', () => {
        // Belt and braces on the one thing this phase must not do. Expressed
        // over the ladder rather than over a literal so a new top rung is
        // covered the day it lands.
        const reachable = (LADDER as readonly IdentityWriteMode[]).filter(
            (m) => gateWriteBackPreflight({ provider: 'orangehrm', config: ENABLED_CONFIG, mode: m }) === null,
        );
        expect(reachable.every((m) => !isAboveClamp(m, HRIS_WRITEBACK_MAX_MODE))).toBe(true);
        expect(reachable.length).toBeGreaterThan(0);
    });
});
