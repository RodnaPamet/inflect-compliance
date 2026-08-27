/**
 * The Entra (Graph) directory writer.
 *
 * Every test drives an INJECTED fetch. `global.fetch` is replaced by a throwing
 * spy in `beforeEach` and asserted untouched, so a future edit that reintroduces
 * a real network or token call fails here rather than in someone's tenant.
 *
 * The centre of gravity is the `definitivelyNotApplied` pair. A wrong `true`
 * settles the journal row FAILED — a positive claim the directory is unchanged —
 * which is the one outcome `findRestorableState` (APPLIED / INDETERMINATE) and
 * `listUnsettledWrites` (PENDING / INDETERMINATE) BOTH exclude. So a lost
 * response filed as a refusal makes the captured prior state unreachable AND
 * hides it from the operator sweep at the same time. Those two assertions are
 * the reason this file exists; the rest guard the ways you get there.
 */
import {
    DirectoryWriteError,
    type DirectoryAccountState,
} from '@/app-layer/usecases/identity-disable-account';
import { resolveWriteTarget } from '@/app-layer/usecases/identity-write-target';
import {
    assertEntraObjectId,
    createEntraIdWriter,
    EntraCredentialRejectedError,
    EntraPrivilegedTargetError,
    EntraWritePermissionMissingError,
    ENTRA_WRITER_PROVIDER_ID,
    type EntraWriterDeps,
} from '@/app-layer/integrations/providers/entra-id/writer';
import { IntegrationTimeoutError } from '@/app-layer/integrations/bounded-fetch';
import {
    IntegrationAuthError,
    IntegrationRateLimitedError,
} from '@/app-layer/integrations/http-resilience';
import { markAuthFailure } from '@/app-layer/integrations/connection-health';
import type { PrismaTx } from '@/lib/db-context';

// ── fixtures ────────────────────────────────────────────────────────────

const USER_ID = '11111111-2222-3333-4444-555555555555';

const BASE_CONFIG = {
    tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    clientId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    clientSecret: 'not-a-real-secret', // pragma: allowlist secret
    writesEnabled: true,
};

/** A JWT whose payload carries the given `roles`. Unsigned — nothing verifies it. */
function fakeGraphToken(roles: string[] | undefined): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'none' })}.${enc(roles === undefined ? { aud: 'graph' } : { aud: 'graph', roles })}.sig`;
}

const TOKEN_WITH_WRITE = fakeGraphToken(['User.Read.All', 'User.EnableDisableAccount.All']);
const TOKEN_READ_ONLY = fakeGraphToken(['User.Read.All', 'Directory.Read.All']);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

/** The Graph shape for the 403 family — identical for consent AND privileged target. */
function graphForbidden(): Response {
    return json(
        {
            error: {
                code: 'Authorization_RequestDenied',
                message: 'Insufficient privileges to complete the operation.',
            },
        },
        403,
    );
}

function graphUser(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: USER_ID,
        accountEnabled: true,
        onPremisesSyncEnabled: false,
        userPrincipalName: 'leaver@acme.example',
        displayName: 'Alex Leaver',
        userType: 'Member',
        assignedLicenses: [{ skuId: 'sku-e3' }],
        ...over,
    };
}

/** One recorded call, in the shape the assertions want to read. */
interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
}

/**
 * A scripted fetch. Each route is matched in order by predicate; the first match
 * wins and its handler is invoked with the call index for that route, so a test
 * can make the SAME url answer differently on the second attempt.
 */
function scriptedFetch(routes: Array<{
    when: (call: Call) => boolean;
    reply: (n: number) => Response | Promise<Response> | Error;
}>) {
    const calls: Call[] = [];
    const hits = new Map<number, number>();

    const impl: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
            headers[k.toLowerCase()] = v;
        }
        const call: Call = {
            url,
            method: init?.method ?? 'GET',
            headers,
            body: typeof init?.body === 'string' ? init.body : null,
        };
        calls.push(call);

        for (let i = 0; i < routes.length; i++) {
            if (!routes[i].when(call)) continue;
            const n = hits.get(i) ?? 0;
            hits.set(i, n + 1);
            const out = await routes[i].reply(n);
            if (out instanceof Error) throw out;
            return out;
        }
        throw new Error(`unscripted request: ${call.method} ${url}`);
    };

    return { impl, calls };
}

const isToken = (c: Call) => c.url.includes('/oauth2/v2.0/token');
const isPatch = (c: Call) => c.method === 'PATCH';
const isMemberOf = (c: Call) => c.url.includes('/memberOf/');
const isUserGet = (c: Call) => c.method === 'GET' && c.url.includes('/users/') && !isMemberOf(c);

/** Token route answering with the given access token. */
function tokenRoute(token: string, expiresIn = 3600) {
    return {
        when: isToken,
        reply: () => json({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }),
    };
}

/** Deps that never sleep and never reach the global fetch. */
function deps(impl: typeof fetch, over: Partial<EntraWriterDeps> = {}): EntraWriterDeps {
    return {
        fetchImpl: impl,
        sleepImpl: async () => {},
        rand: () => 0,
        ...over,
    };
}

// ── harness ─────────────────────────────────────────────────────────────

let realFetch: typeof fetch;
let globalFetchSpy: jest.Mock;

beforeEach(() => {
    realFetch = global.fetch;
    globalFetchSpy = jest.fn(() => {
        throw new Error('a test reached the REAL network');
    });
    global.fetch = globalFetchSpy as unknown as typeof fetch;
});

afterEach(() => {
    // Every test must be hermetic. This catches a writer edit that drops the
    // injected transport somewhere on a rarely-taken branch.
    expect(globalFetchSpy).not.toHaveBeenCalled();
    global.fetch = realFetch;
});

// ── the provider id ─────────────────────────────────────────────────────

describe('the provider id resolveWriteTarget matches on', () => {
    it('is the exact literal, and the write target accepts it', () => {
        const { impl } = scriptedFetch([tokenRoute(TOKEN_WITH_WRITE)]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        // Nothing type-checks `DirectoryWriter.provider` — it is `string`. The
        // near-miss `'microsoft-entra-id'` (the NextAuth provider id, used
        // throughout src/auth.ts) would make resolveWriteTarget return
        // REFUSED_TARGET for every account in every tenant, silently, while the
        // batch reported clean results.
        expect(writer.provider).toBe('entra-id');
        expect(ENTRA_WRITER_PROVIDER_ID).toBe('entra-id');
        expect(
            resolveWriteTarget({ provider: writer.provider, onPremisesSyncEnabled: false }),
        ).toEqual({ allowed: true });
    });
});

// ── construction ────────────────────────────────────────────────────────

describe('construction refuses once, not once per account', () => {
    it('rejects a writer built without the decrypted client secret', () => {
        const { impl } = scriptedFetch([]);
        // The natural mistake: a factory handed only `configJson`, because
        // resolveWriteTarget needs nothing else. Failing here fails the batch
        // once; failing lazily would journal 1000 FAILED rows.
        expect(() =>
            createEntraIdWriter({ ...BASE_CONFIG, clientSecret: undefined }, deps(impl)),
        ).toThrow(/clientSecret is missing or failed to decrypt/);
    });

    it('the missing-secret error is a plain Error, not a directory refusal', () => {
        const { impl } = scriptedFetch([]);
        let caught: unknown;
        try {
            createEntraIdWriter({ ...BASE_CONFIG, clientSecret: '' }, deps(impl));
        } catch (err) {
            caught = err;
        }
        // A decrypt failure must not be recorded as "your credentials are
        // revoked" — same reasoning as getEntraAccessToken's pre-flight.
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(DirectoryWriteError);
    });

    it('refuses a connection that has not opted into directory writes', () => {
        const { impl } = scriptedFetch([]);
        expect(() =>
            createEntraIdWriter({ ...BASE_CONFIG, writesEnabled: undefined }, deps(impl)),
        ).toThrow(/not enabled for directory writes/);
        // Fail closed: a truthy-looking string is not an opt-in either.
        expect(() =>
            createEntraIdWriter({ ...BASE_CONFIG, writesEnabled: 'yes' }, deps(impl)),
        ).toThrow(/not enabled for directory writes/);
    });

    it('says WHY when the stored flag is a truthy-looking string, instead of repeating the instruction', async () => {
        // The strict `!== true` is right and its silence was not. Sibling
        // booleans on this same connection — enrichMfa, enrichFederation in
        // index.ts — are read through a string-coercing `truthy` helper, so a
        // config row holding "true" as a string has those ON and this one OFF.
        // The operator sees a checkbox they ticked and an error telling them to
        // tick it, with nothing distinguishing that from having forgotten.
        const { impl } = scriptedFetch([]);
        const err = (() => {
            try {
                createEntraIdWriter({ ...BASE_CONFIG, writesEnabled: 'true' }, deps(impl));
                return null;
            } catch (e) {
                return e as Error;
            }
        })();

        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toMatch(/not enabled for directory writes/);
        expect(err?.message).toMatch(/stores writesEnabled as the string "true"/);
        expect(err?.message).toMatch(/string-coercing helper/);
    });

    it('does not append the diagnostic when the flag is simply absent', () => {
        // Nothing to explain: the base message already says everything there is
        // to say, and a paragraph about string coercion would just be noise on
        // the overwhelmingly common case.
        const { impl } = scriptedFetch([]);
        const err = (() => {
            try {
                createEntraIdWriter({ ...BASE_CONFIG, writesEnabled: undefined }, deps(impl));
                return null;
            } catch (e) {
                return e as Error;
            }
        })();

        expect(err?.message).toMatch(/not enabled for directory writes/);
        expect(err?.message).not.toMatch(/stores writesEnabled/);
    });
});

// ── the id shape ────────────────────────────────────────────────────────

describe('the external id is a GUID before it reaches a URL path', () => {
    it.each([
        ['a guest UPN', 'guest_acme.com#EXT#@contoso.onmicrosoft.com'],
        ['a traversal', '../groups/00000000-0000-0000-0000-000000000000'],
        ['an empty string', '   '],
    ])('refuses %s without making a request', async (_label, bad) => {
        const { impl, calls } = scriptedFetch([tokenRoute(TOKEN_WITH_WRITE)]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        await expect(writer.readState(bad)).rejects.toBeInstanceOf(DirectoryWriteError);
        // A `#` truncates the path at the fragment; `../` re-targets a PATCH
        // aimed at /users onto a different Graph collection.
        expect(calls).toHaveLength(0);
    });

    it('marks the refusal as proven — nothing was sent', () => {
        let caught: unknown;
        try {
            assertEntraObjectId('not-a-guid');
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(DirectoryWriteError);
        expect((caught as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });
});

// ── readState ───────────────────────────────────────────────────────────

describe('readState', () => {
    it('asks for accountEnabled and onPremisesSyncEnabled explicitly', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        await writer.readState(USER_ID);

        const read = calls.find(isUserGet)!;
        // GET /users/{id} with no $select returns a DEFAULT property set
        // containing neither of these, and `undefined === false` is false — so
        // the account would read as enabled and we would disable one we never
        // observed.
        expect(read.url).toContain('$select=');
        expect(read.url).toContain('accountEnabled');
        expect(read.url).toContain('onPremisesSyncEnabled');
        // signInActivity needs AuditLog.Read.All plus a premium licence and has
        // an entire fallback on the READ path; copying USER_SELECT_FULL here
        // would 4xx on tenants without it, with no fallback.
        expect(read.url).not.toContain('signInActivity');
    });

    it('refuses when Graph omits accountEnabled rather than defaulting it true', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isUserGet, reply: () => json(graphUser({ accountEnabled: undefined })) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        // Absent must not read as enabled. `enabled` drives the
        // ALREADY_DISABLED short-circuit whose whole purpose is to stop a second
        // disable journalling `priorState: disabled` and destroying the real one.
        await expect(writer.readState(USER_ID)).rejects.toThrow(/state is unknown/);
    });

    it('maps a deleted account to already-disabled instead of ending the batch', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isUserGet, reply: () => json({ error: { code: 'Request_ResourceNotFound' } }, 404) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        // readState is called OUTSIDE the usecase's try/catch, and
        // findLeaverCandidates does not filter on account status — so a
        // since-deleted account is routine, and throwing here would kill a
        // 1000-account run at whichever one happened to be gone.
        const state = await writer.readState(USER_ID);
        expect(state.enabled).toBe(false);
        expect(state.priorState.notFound).toBe(true);
        // beginWrite rejects an empty capture; this one has to survive that
        // even though it never reaches it.
        expect(Object.keys(state.priorState).length).toBeGreaterThan(0);
    });

    it('captures what a restore needs, and only that', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [{ id: 'group-a' }, { id: 'group-b' }] }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl, { now: () => 1_700_000_000_000 }));
        const state = await writer.readState(USER_ID);

        expect(state.enabled).toBe(true);
        expect(state.priorState).toMatchObject({
            // The value a restore writes back — as OBSERVED.
            accountEnabled: true,
            // UPNs get renamed and recycled; the object id is the handle, the
            // UPN and display name are what a human confirms against.
            id: USER_ID,
            userPrincipalName: 'leaver@acme.example',
            displayName: 'Alex Leaver',
            // Read at WRITE time, not taken from the stored sync row.
            onPremisesSyncEnabled: false,
            // Group-based licensing strips the licence when a dynamic group
            // drops a disabled user, which starts a 30-day mailbox clock that
            // re-enabling does not rewind.
            assignedLicenseSkuIds: ['sku-e3'],
            memberOfGroupIds: ['group-a', 'group-b'],
        });
        // A plaintext JSON column six months later cannot tell an absent key
        // from a field the writer of that era never selected.
        // v2 since `onPremStateObserved` joined the capture. Version and shape are
        // asserted TOGETHER on purpose: bumping one without the other is the
        // ambiguity the stamp exists to prevent — an absent key would otherwise
        // mean "that era did not record it" and "Graph did not answer" at once.
        expect(state.priorState.captureSchema).toBe('entra-id/disable-account/v2');
        expect(state.priorState).toHaveProperty('onPremStateObserved');
        expect(state.priorState.capturedSelect).toContain('accountEnabled');
        expect(state.priorState.capturedAt).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('keeps PII the capture does not need out of the plaintext column', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isUserGet,
                reply: () =>
                    json(graphUser({ mobilePhone: '+15550000', otherMails: ['x@y.z'], employeeId: 'E-1' })),
            },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        // priorStateJson is NOT in the field-encryption manifest — only
        // IdentityWriteJournal.detail is. Dumping the Graph user verbatim would
        // put these in the clear for every offboarded worker.
        expect(state.priorState).not.toHaveProperty('mobilePhone');
        expect(state.priorState).not.toHaveProperty('otherMails');
        expect(state.priorState).not.toHaveProperty('employeeId');
    });

    it('records "could not read" memberships as null, not as an empty list', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ error: { code: 'nope' } }, 400) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        // null and [] mean different things, and a restore reading the journal
        // has to be able to tell them apart.
        expect(state.priorState.memberOfGroupIds).toBeNull();
        // And the capture must not CLAIM completeness about a list it never
        // read. This branch used to answer `memberOfTruncated: false` — a
        // positive statement of wholeness, on the one flag whose entire job is
        // to report wholeness.
        expect(state.priorState.memberOf).toBe('unavailable');
        expect(state.enabled).toBe(true);
    });

    it('says complete only when the whole page came back', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [{ id: 'group-a' }] }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        const state = await writer.readState(USER_ID);

        expect(state.priorState).toMatchObject({ memberOf: 'complete', memberOfGroupIds: ['group-a'] });
    });

    it('says truncated when Graph offered another page', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            {
                when: isMemberOf,
                reply: () => json({ value: [{ id: 'group-a' }], '@odata.nextLink': 'https://graph/next' }),
            },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        const state = await writer.readState(USER_ID);

        // One page is deliberate — this is a record of what a disable displaced,
        // not an inventory — so the record has to say it is partial.
        expect(state.priorState.memberOf).toBe('truncated');
    });

    it('falls back past a refused assignedLicenses rather than failing the read', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isUserGet,
                reply: (n) =>
                    n === 0
                        ? json({ error: { code: 'Request_UnsupportedQuery' } }, 400)
                        : json(graphUser({ assignedLicenses: undefined })),
            },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        // The signInActivity lesson from the read path: one property in the
        // select must never be able to fail the whole request — and if that 4xx
        // were a 403 it would be reported as "you lack permission to disable
        // accounts" when the real cause is an unrelated select field.
        expect(state.enabled).toBe(true);
        expect(state.priorState.assignedLicenseSkuIds).toBeNull();
        expect(state.priorState.capturedSelect).not.toContain('assignedLicenses');
        expect(calls.filter(isUserGet)).toHaveLength(2);
    });
});

// ── the 403 discriminator ───────────────────────────────────────────────

describe('403 — the same Graph code, two different operator actions', () => {
    async function readThen(impl: typeof fetch): Promise<[ReturnType<typeof createEntraIdWriter>, DirectoryAccountState]> {
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);
        return [writer, state];
    }

    it('refuses BEFORE the PATCH when the token proves the permission is absent', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_READ_ONLY),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const [writer, state] = await readThen(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EntraWritePermissionMissingError);
        // A 1000-account batch fails identically instead of making 1000 doomed
        // writes — and the operator is told to re-consent, which for THIS cause
        // is the right advice.
        expect((err as Error).message).toMatch(/re-consent the application/);
        expect((err as Error).message).toContain('User.EnableDisableAccount.All');
        expect(calls.filter(isPatch)).toHaveLength(0);
    });

    it('names the account, not consent, when the role IS present and Graph still refuses', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => graphForbidden() },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const [writer, state] = await readThen(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EntraPrivilegedTargetError);
        const msg = (err as Error).message;
        // The body is byte-identical to the missing-consent case. Telling this
        // operator to re-consent would have them grant directory write, watch
        // it not help, and keep the broader grant.
        expect(msg).toContain(USER_ID);
        expect(msg).toMatch(/Privileged Authentication Administrator/);
        expect(msg).toMatch(/Do NOT re-consent/);
        expect(msg).not.toMatch(/An administrator must re-consent/);
    });

    it('does not let a 403 escape as an IntegrationAuthError', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => graphForbidden() },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const [writer, state] = await readThen(impl);
        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);

        // markAuthFailure keys on that class. A missing WRITE scope is not a bad
        // credential — the secret is valid and every posture sync works — so
        // letting it through would mark the connection revoked, raise the
        // banner, and have shouldBypassQueueRetry take the tenant's READ syncs
        // down over a write permission.
        expect((err as Error).name).not.toBe('IntegrationAuthError');
        expect(err).toBeInstanceOf(DirectoryWriteError);
        // And it must not carry `/users/<objectId>` in a message that
        // markAuthFailure would persist into an unencrypted, UI-rendered column
        // under the premise that integration URLs hold no identifiers.
        expect((err as Error).message).not.toContain('graph.microsoft.com/v1.0/users/');
    });
});

// ── the PATCH ───────────────────────────────────────────────────────────

describe('the PATCH itself', () => {
    async function ready(impl: typeof fetch) {
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);
        return { writer, state };
    }

    it('sends Content-Type and a pre-serialized absolute set, and does not parse the 204', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            // 204 No Content is the success shape. `await res.json()` — the read
            // path's idiom throughout index.ts — throws on it.
            { when: isPatch, reply: () => new Response(null, { status: 204 }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        await expect(writer.disable(USER_ID, state)).resolves.toBeUndefined();

        const patch = calls.find(isPatch)!;
        // Without this header Graph answers 400, which is in none of
        // resilientFetch's classification sets — so it comes back as a plain
        // Response and a writer that skips `res.ok` reads a request that changed
        // nothing as a completed disable.
        expect(patch.headers['content-type']).toBe('application/json');
        // A string, not a Request/stream/FormData: resilientFetch reuses the
        // same `init` across attempts, so a one-shot body fails the retry.
        expect(typeof patch.body).toBe('string');
        expect(JSON.parse(patch.body!)).toEqual({ accountEnabled: false });
        expect(patch.url).toContain(encodeURIComponent(USER_ID));
    });

    it('treats a 400 as a refusal rather than a success', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => json({ error: { code: 'Request_BadRequest', message: 'bad' } }, 400) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });

    it('refreshes the token once on a 401 and only escalates if the fresh one fails too', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isPatch,
                reply: (n) => (n === 0 ? new Response('', { status: 401 }) : new Response(null, { status: 204 })),
            },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        // A sequential batch absorbing 429s can outlive an hour-long token, and
        // the resulting 401 is indistinguishable at the catch site from a
        // revoked secret.
        await expect(writer.disable(USER_ID, state)).resolves.toBeUndefined();
        expect(calls.filter(isToken)).toHaveLength(2);
        expect(calls.filter(isPatch)).toHaveLength(2);
    });

    it('reports a persistent 401 as proven-unapplied, keeping the original as cause', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => new Response('', { status: 401 }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EntraCredentialRejectedError);
        // Graph evaluated and refused, so the directory is unchanged — and the
        // contract can only read that off a DirectoryWriteError.
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).cause).toBeDefined();
    });
});

// ── the on-prem re-verification ─────────────────────────────────────────

describe('the on-premises flag is re-read, not trusted from the database', () => {
    it('refuses on a FRESH true even though resolveWriteTarget already passed', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isUserGet, reply: () => json(graphUser({ onPremisesSyncEnabled: true })) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        // The usecase checked ConnectedIdentityAccount, written by the last
        // sync — which for a >5000-user directory spans several scheduled runs.
        // An account brought under Azure AD Connect since then still reads false
        // there, and Graph would accept the PATCH and let Connect revert it: the
        // account reports disabled, re-enables itself, and the audit trail says
        // the offboarding succeeded.
        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/Azure AD Connect/);
        expect(calls.filter(isPatch)).toHaveLength(0);
    });

    it('BOTH write selects carry onPremisesSyncEnabled — the observation claim rests on it', async () => {
        // The connector got this test in the same diff; the writer is the half
        // that actually authorises the live write and only its FULL select was
        // pinned. WRITE_SELECT_MINIMAL is the fallback taken whenever a tenant
        // 4xxs on assignedLicenses — a real and expected condition here — so
        // trimming the field from it would make `onPremStateObserved` claim an
        // answer nobody asked for, on the path that writes.
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isUserGet,
                reply: (n: number) => (n === 0 ? graphForbidden() : json(graphUser())),
            },
        ]);
        await createEntraIdWriter(BASE_CONFIG, deps(impl)).readState(USER_ID);

        // `/users/{id}/memberOf` is also under /users/ and selects only `id`,
        // so it must be excluded — otherwise this fails for a reason that has
        // nothing to do with what it is checking.
        const gets = calls.filter(
            (c) => c.method === 'GET' && c.url.includes('/users/') && !c.url.includes('memberOf'),
        );
        expect(gets.length).toBeGreaterThanOrEqual(2); // full select, then the fallback
        for (const g of gets) expect(g.url).toContain('onPremisesSyncEnabled');
    });

    it('refuses when Graph OMITTED the flag entirely', async () => {
        // The property is genuinely absent — no answer at all. This test used to
        // pass `onPremisesSyncEnabled: null` while claiming to test omission,
        // which is a different case and the reason the two were conflated for so
        // long: the name described the risk, the fixture exercised the other one.
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isUserGet,
                reply: () => {
                    // The key is genuinely REMOVED, not set to undefined and not
                    // set to null. `graphUser()` defaults it to `false`, so
                    // omission has to be constructed deliberately — which is
                    // itself why this case went untested for so long.
                    const u = graphUser();
                    delete u.onPremisesSyncEnabled;
                    return json(u);
                },
            },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        // Unknown is not cloud-only, and the two differ exactly where it matters.
        expect(state.priorState.onPremStateObserved).toBe(false);
        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect(calls.filter(isPatch)).toHaveLength(0);
    });

    it('DISABLES when Graph answered null — the cloud-only case', async () => {
        // Graph's contract: `true` when synced from an on-premises AD, and
        // "otherwise the user isn't being synced and can be managed in Microsoft
        // Entra ID". A null it actually SENT is that "otherwise", and it is the
        // permanent state of every user in a tenant without AD Connect.
        //
        // The live writer must agree with the write-target rail here. When it
        // did not, DRY_RUN — which uses the snapshot writer and never reaches
        // this check — reported "would disable" for accounts this path refused,
        // so the seven-day observation window compared two different answers.
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => new Response(null, { status: 204 }) },
            { when: isUserGet, reply: () => json(graphUser({ onPremisesSyncEnabled: null })) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        expect(state.priorState.onPremisesSyncEnabled).toBeNull();
        expect(state.priorState.onPremStateObserved).toBe(true);
        await writer.disable(USER_ID, state);
        expect(calls.filter(isPatch)).toHaveLength(1);
    });
});

// ── THE PAIR ────────────────────────────────────────────────────────────

describe('definitivelyNotApplied — proven refusal vs lost response', () => {
    async function ready(impl: typeof fetch) {
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);
        return { writer, state };
    }

    it('a PROVEN refusal sets it TRUE', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => graphForbidden() },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        // Graph evaluated the request and rejected it with a body. That is what
        // makes FAILED — a positive claim the directory is unchanged — safe to
        // write.
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });

    it('a LOST response leaves it FALSE, even when a read-back says still enabled', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isPatch,
                reply: () => new IntegrationTimeoutError('https://graph.microsoft.com/v1.0/users/x', 30_000),
            },
            // The confirming read: the account still reads ENABLED.
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DirectoryWriteError);
        // FALSE, deliberately, and this is the assertion the whole file exists
        // for. A read-back on an eventually-consistent directory is strong
        // evidence, not the provider rejecting the request. A wrong TRUE would
        // settle the row FAILED — invisible to findRestorableState (APPLIED /
        // INDETERMINATE) AND to listUnsettledWrites (PENDING / INDETERMINATE) —
        // so the captured prior state becomes unreachable and nobody is told to
        // look. INDETERMINATE costs an operator a look; a wrong FAILED costs
        // them the account.
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(false);
        expect((err as Error).message).toMatch(/may or may not have changed/);
    });

    it('a throttle that outlived the absorb budget also leaves it FALSE', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isPatch,
                reply: () => new IntegrationRateLimitedError('https://graph.microsoft.com/v1.0/users/x', 90_000),
            },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const { writer, state } = await ready(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        // Graph's write throttle is materially tighter than its read throttle
        // and a leaver batch is 1000 sequential accounts, so this is the
        // expected case rather than the exceptional one.
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(false);
        expect((err as Error).message).toMatch(/throttled beyond the absorb budget/);
    });

    it('a lost response whose write LANDED resolves normally', async () => {
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => new IntegrationTimeoutError('https://graph.microsoft.com/x', 30_000) },
            {
                when: isUserGet,
                // First: the pre-write capture. Second: the confirming read,
                // which now observes the intended end state.
                reply: (n) => json(graphUser({ accountEnabled: n === 0 })),
            },
        ]);
        const { writer, state } = await ready(impl);

        // The end state holds, so this is not a failure — and resolving lets the
        // usecase record APPLIED, which keeps the capture reachable from
        // findRestorableState instead of stranding it.
        await expect(writer.disable(USER_ID, state)).resolves.toBeUndefined();
        expect(calls.filter(isUserGet).length).toBeGreaterThanOrEqual(2);
    });

    it('a failed confirming read leaves it FALSE and says the outcome is unknown', async () => {
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => new IntegrationTimeoutError('https://graph.microsoft.com/x', 30_000) },
            {
                when: isUserGet,
                reply: (n) => (n === 0 ? json(graphUser()) : new Error('socket hang up')),
            },
        ]);
        const { writer, state } = await ready(impl);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(false);
        expect((err as Error).message).toMatch(/confirming read also failed/);
    });

    it('a token that could not be obtained is proven-unapplied — no request existed', async () => {
        // A capture taken by a healthy writer, handed to one whose token
        // endpoint is now down. This is the mid-batch shape: the read worked,
        // the exchange for the write did not.
        const captured: DirectoryAccountState = {
            enabled: true,
            priorState: { accountEnabled: true, onPremisesSyncEnabled: false, id: USER_ID },
        };
        const { impl, calls } = scriptedFetch([
            { when: isToken, reply: () => new Response('', { status: 500 }) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        const err = await writer.disable(USER_ID, captured).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DirectoryWriteError);
        // The rule the whole file runs on: everything before the PATCH is
        // dispatched is proven-unapplied, because no request existed.
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect(calls.filter(isPatch)).toHaveLength(0);
    });
});

// ── token caching ───────────────────────────────────────────────────────

describe('the token is exchanged once per batch, not once per call', () => {
    it('serves two accounts from one client-credentials exchange', async () => {
        const other = '99999999-8888-7777-6666-555555555555';
        const { impl, calls } = scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => new Response(null, { status: 204 }) },
            { when: isUserGet, reply: (n) => json(graphUser({ id: n === 0 ? USER_ID : other })) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        for (const id of [USER_ID, other]) {
            const state = await writer.readState(id);
            await writer.disable(id, state);
        }

        // Two accounts × (GET + PATCH) would be four exchanges on a naive
        // writer — 2000 for a full batch, against an endpoint Entra throttles
        // per app-per-tenant, before a single directory call.
        expect(calls.filter(isToken)).toHaveLength(1);
    });

    it('re-exchanges before the token expires rather than after', async () => {
        let clock = 0;
        const { impl, calls } = scriptedFetch([
            // 10 minutes. The 5-minute skew makes it stale at t=5m.
            tokenRoute(TOKEN_WITH_WRITE, 600),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl, { now: () => clock }));

        await writer.readState(USER_ID);
        expect(calls.filter(isToken)).toHaveLength(1);

        clock = 6 * 60_000;
        await writer.readState(USER_ID);
        // Renewed EARLY, so a batch never carries a token into the window where
        // Graph answers 401 and the catch site cannot tell that from a revoked
        // secret.
        expect(calls.filter(isToken)).toHaveLength(2);
    });
});

// ── preflight ───────────────────────────────────────────────────────────

describe('preflight', () => {
    it('refuses a read-only-consented connection with one call', async () => {
        const { impl, calls } = scriptedFetch([tokenRoute(TOKEN_READ_ONLY)]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        await expect(writer.preflight()).rejects.toBeInstanceOf(EntraWritePermissionMissingError);
        expect(calls).toHaveLength(1);
    });

    it('passes a connection whose token carries a write role', async () => {
        const { impl } = scriptedFetch([tokenRoute(TOKEN_WITH_WRITE)]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        await expect(writer.preflight()).resolves.toBeUndefined();
    });

    it('accepts the broader roles a tenant may already hold', async () => {
        for (const role of ['User.ReadWrite.All', 'Directory.ReadWrite.All']) {
            const { impl } = scriptedFetch([tokenRoute(fakeGraphToken([role]))]);
            const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
            await expect(writer.preflight()).resolves.toBeUndefined();
        }
    });

    it('does NOT accept Directory.Read.All, which reads as write to almost everyone', async () => {
        const { impl } = scriptedFetch([tokenRoute(fakeGraphToken(['Directory.Read.All']))]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        await expect(writer.preflight()).rejects.toBeInstanceOf(EntraWritePermissionMissingError);
    });

    it('treats a token with no roles claim at all as zero consent', async () => {
        // A client-credentials token for an app with nothing consented has no
        // roles claim — that is an ANSWER, not an unknown.
        const { impl } = scriptedFetch([tokenRoute(fakeGraphToken(undefined))]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        await expect(writer.preflight()).rejects.toBeInstanceOf(EntraWritePermissionMissingError);
    });

    it('proceeds when the token cannot be decoded, rather than refusing on our own parse failure', async () => {
        const { impl, calls } = scriptedFetch([
            { when: isToken, reply: () => json({ access_token: 'opaque-not-a-jwt', expires_in: 3600 }) }, // pragma: allowlist secret — a deliberately non-JWT literal, asserting the writer refuses an undecodable token
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => new Response(null, { status: 204 }) },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        await expect(writer.preflight()).resolves.toBeUndefined();
        const state = await writer.readState(USER_ID);
        await expect(writer.disable(USER_ID, state)).resolves.toBeUndefined();
        expect(calls.filter(isPatch)).toHaveLength(1);
    });

    it('claims neither cause on a 403 it cannot diagnose', async () => {
        const { impl } = scriptedFetch([
            { when: isToken, reply: () => json({ access_token: 'opaque-not-a-jwt', expires_in: 3600 }) }, // pragma: allowlist secret — a deliberately non-JWT literal, asserting the writer refuses an undecodable token
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => graphForbidden() },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        // Naming the wrong cause is worse than naming none: one sends the
        // operator to a consent screen that will not help.
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect(err).not.toBeInstanceOf(EntraWritePermissionMissingError);
        expect(err).not.toBeInstanceOf(EntraPrivilegedTargetError);
        expect((err as Error).message).toMatch(/could not be decoded/);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });
});

// ── the classes that must not escape this file ──────────────────────────

describe('an IntegrationAuthError never leaves the writer', () => {
    /** Enough of a PrismaTx for markAuthFailure's early return; explodes if reached. */
    const explodingDb = {
        integrationConnection: {
            updateMany: () => {
                throw new Error('markAuthFailure reached the database');
            },
        },
    } as unknown as PrismaTx;

    function readWith401() {
        return scriptedFetch([
            tokenRoute(TOKEN_WITH_WRITE),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            {
                when: isUserGet,
                reply: () =>
                    json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401),
            },
        ]);
    }

    it('converts a 401 on the READ, which the cloak does not take back from the classifier', async () => {
        // The cloak reclaims 403 and 404. 401 is deliberately left to the shared
        // classifier — and `readState` is called OUTSIDE the usecase's
        // try/catch, so what the classifier throws propagates out of the leaver
        // pass exactly as it is.
        const { impl } = readWith401();
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        const err = await writer.readState(USER_ID).catch((e: unknown) => e);

        expect(err).not.toBeInstanceOf(IntegrationAuthError);
        expect(err).toBeInstanceOf(EntraCredentialRejectedError);
        // 401 proves the request was refused at the edge without being
        // processed, which is what the contract wants said out loud.
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });

    it('is inert to markAuthFailure, which keys on the class alone', async () => {
        // The real mechanism, asserted against the real function rather than
        // against a name. `markAuthFailure` no-ops on anything that is not an
        // IntegrationAuthError — so the class IS the trigger, and a caller that
        // catches whatever the leaver pass threw and passes it along (the shape
        // every other sync in this codebase already has) would otherwise mark
        // the connection credential-revoked from the offboarding path, raise the
        // UI banner, and have shouldBypassQueueRetry take the tenant's READ
        // syncs down with it.
        const { impl } = readWith401();
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const err = await writer.readState(USER_ID).catch((e: unknown) => e);

        await expect(markAuthFailure(explodingDb, 'conn-1', err)).resolves.toBe(false);
    });

    it('scrubs the object id out of the cause it deliberately keeps', async () => {
        // The writer keeps the original so a future call site holding a
        // connectionId can unwrap it and decide whether THIS 401 should mark the
        // connection — a decision the module docblock leaves open on purpose. A
        // seam that is only safe while nobody uses it is not a seam: the
        // retained error's message is what markAuthFailure would persist into
        // `IntegrationConnection.authFailureReason`, a column left out of the
        // field-encryption manifest on the recorded grounds that integration
        // URLs are system-generated and carry no identifiers. `/users/<objectId>`
        // is the first thing on any path here that makes that false.
        const { impl } = readWith401();
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const err = await writer.readState(USER_ID).catch((e: unknown) => e);

        const cause = (err as Error).cause;
        expect(cause).toBeInstanceOf(IntegrationAuthError);
        expect((cause as IntegrationAuthError).status).toBe(401);
        expect((cause as Error).message).not.toContain(USER_ID);
        expect((cause as Error).message).toContain('{objectId}');
        // Still recognisable as the same event, so unwrapping it stays useful.
        expect((cause as Error).message).toContain('graph.microsoft.com');
    });
});

describe('a 403 on the READ is not a write-permission problem', () => {
    function forbiddenRead(token: string) {
        return scriptedFetch([
            tokenRoute(token),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isUserGet, reply: () => graphForbidden() },
        ]);
    }

    it('does not send the operator to consent a permission that would not fix it', async () => {
        // The request that failed is a GET. Telling this operator "the
        // connection was consented for READ only; disabling additionally
        // requires User.EnableDisableAccount.All" has them grant directory
        // write, watch the identical failure, and keep the broader grant — the
        // exact harm the privileged-target branch was written to avoid,
        // arriving through the other door.
        const { impl, calls } = forbiddenRead(TOKEN_READ_ONLY);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        const err = await writer.readState(USER_ID).catch((e: unknown) => e);
        const message = (err as Error).message;

        expect(err).not.toBeInstanceOf(EntraWritePermissionMissingError);
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect(message).toMatch(/refused to READ/);
        expect(message).toMatch(/restricted-management administrative unit/);
        expect(message).not.toMatch(/re-consent/i);
        expect(message).not.toContain('User.EnableDisableAccount.All');
        // Nothing was written, and the read never got past its own retry.
        expect(calls.filter(isPatch)).toHaveLength(0);
    });

    it('reports the role claim as a diagnostic, never as the diagnosis', async () => {
        // Having the write role says nothing about why a READ was refused, so
        // it is reported and then explicitly discounted rather than used to pick
        // a cause.
        const { impl } = forbiddenRead(TOKEN_WITH_WRITE);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));

        const err = await writer.readState(USER_ID).catch((e: unknown) => e);
        const message = (err as Error).message;

        expect(err).not.toBeInstanceOf(EntraPrivilegedTargetError);
        expect(message).toMatch(/the request that was refused is a read/);
        expect(message).not.toMatch(/re-consent/i);
    });

    it('leaves the WRITE 403 discriminator exactly as it was', async () => {
        // The whole point is that the two phases now differ. If a 403 on the
        // PATCH stopped naming consent, this change would have traded one wrong
        // answer for another.
        const { impl } = scriptedFetch([
            tokenRoute(TOKEN_READ_ONLY),
            { when: isMemberOf, reply: () => json({ value: [] }) },
            { when: isPatch, reply: () => graphForbidden() },
            { when: isUserGet, reply: () => json(graphUser()) },
        ]);
        const writer = createEntraIdWriter(BASE_CONFIG, deps(impl));
        const state = await writer.readState(USER_ID);

        const err = await writer.disable(USER_ID, state).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EntraWritePermissionMissingError);
        expect((err as Error).message).toMatch(/re-consent the application/);
    });
});
