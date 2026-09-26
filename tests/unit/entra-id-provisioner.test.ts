/**
 * #2878 finding 11 — creating in Entra, and minting the joining credential.
 *
 * ═══ WHAT THE OLD REFUSAL PROMISED, AND WHAT MUST STILL BE TRUE ═══
 *
 * `identity-provisioner-factory` used to refuse Entra creates outright:
 *
 *   > "The joining credential for it is a Temporary Access Pass, which needs
 *   > the authentication-methods policy and therefore `Policy.Read.All` — not
 *   > among the permissions this connector requests, and a consent decision
 *   > somebody has to make. **Refused rather than degraded to a password: a
 *   > silent downgrade is a different security posture from the one the tenant
 *   > configured.**"
 *
 * The consent decision has been made. The sentence in bold has not changed, and
 * the assertion that carries this file is the one about it: when the tenant's
 * own policy declines a Temporary Access Pass, this provisioner REFUSES. It
 * does not fall back, because the fallback would be a password hung on an
 * account this product just created — a credential the tenant's policy
 * explicitly declined to permit.
 *
 * ═══ AND CONSENT IS NEVER SUFFICIENT ON ITS OWN ═══
 *
 * Entra's consent list cannot separate creating from disabling:
 * `User.ReadWrite.All` is itself a member of the writer's `WRITE_ROLES`. So the
 * per-connection flag is the only place the directions are held apart, and this
 * factory fails CLOSED on it before it reads a credential.
 */
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/providers/entra-id/index', () => ({
    getEntraAccessToken: jest.fn(async () => 'token-abc'),
}));

import { createEntraIdProvisioner } from '@/app-layer/integrations/providers/entra-id/provisioner';

/** A connection that HAS opted in. The flag is the whole gate. */
const OPTED_IN = {
    tenantId: 't-1',
    clientId: 'c-1',
    clientSecret: 's-1',
    joinerWritesEnabled: true,
};

type Reply = { status: number; body?: unknown };

/** A fetch stub that answers by method + path fragment, and records the calls. */
function stubFetch(routes: Array<[RegExp, Reply]>) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const impl = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url: String(url), body });
        const hit = routes.find(([re]) => re.test(`${method} ${url}`));
        const reply = hit?.[1] ?? { status: 404 };
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
        } as unknown as Response;
    });
    return { impl: impl as unknown as typeof fetch, calls };
}

/** A directory whose policy permits a Temporary Access Pass. The ordinary case. */
const TAP_ENABLED: [RegExp, Reply] = [
    /TemporaryAccessPass$/,
    { status: 200, body: { id: 'TemporaryAccessPass', state: 'enabled' } },
];

function build(routes: Array<[RegExp, Reply]>, connection: Record<string, unknown> = OPTED_IN) {
    // The policy answer is appended rather than prepended, so a test that
    // supplies its own TemporaryAccessPass route still wins.
    const { impl, calls } = stubFetch([...routes, TAP_ENABLED]);
    return { p: createEntraIdProvisioner({ connection, doFetch: impl }), calls };
}

describe('the consent gate', () => {
    it('REFUSES to construct without the joiner flag, before reading a credential', () => {
        // A tenant that consented Policy.Read.All for any unrelated reason must
        // gain nothing here. The flag is the per-connection statement that they
        // asked for this specific capability.
        expect(() =>
            createEntraIdProvisioner({ connection: { tenantId: 't-1', clientId: 'c-1', clientSecret: 's' } }),
        ).toThrow();
    });

    it('REFUSES when only the LEAVER flag is set — the directions are separate', () => {
        // The separation this whole gate exists for: consenting to disables
        // must not grant create authority, and Entra's consent list cannot say
        // so because every permission sufficient to create is sufficient to
        // disable.
        expect(() =>
            createEntraIdProvisioner({
                connection: { tenantId: 't-1', clientId: 'c-1', clientSecret: 's', writesEnabled: true },
            }),
        ).toThrow();
    });

    it('constructs when the joiner flag is explicitly true', () => {
        expect(() => createEntraIdProvisioner({ connection: OPTED_IN })).not.toThrow();
    });
});

describe('probeIdentifier', () => {
    it('reports FREE, naming only the namespaces it could actually consult', async () => {
        // `mailNickname` and `proxyAddresses` are declared collision namespaces
        // Graph will not filter on, so a create can still fail on them.
        // Claiming them here would let an old artefact be re-read as having
        // promised more than it checked.
        const { p } = build([[/^GET .*\/users\?\$filter/, { status: 200, body: { value: [] } }]]);

        const r = await p.probeIdentifier('joiner@corp.example');

        expect(r.kind).toBe('free');
        if (r.kind !== 'free') throw new Error('narrowing');
        expect(r.namespacesChecked).toStrictEqual(['userPrincipalName', 'mail']);
        expect(p.collisionNamespaces).toContain('mailNickname');
    });

    it('reports TAKEN when an account already holds it', async () => {
        const { p } = build([
            [/^GET .*\/users\?\$filter/, { status: 200, body: { value: [{ id: 'obj-9' }] } }],
        ]);

        const r = await p.probeIdentifier('taken@corp.example');

        expect(r.kind).toBe('taken');
        if (r.kind !== 'taken') throw new Error('narrowing');
        expect(r.externalUserId).toBe('obj-9');
    });

    it('reports UNKNOWN — not free — when Graph does not answer', async () => {
        // The assertion the three-valued probe exists for. Treating an unread
        // namespace as available is the positive negative this subsystem has
        // been bitten by before.
        const { p } = build([[/^GET .*\/users\?\$filter/, { status: 503 }]]);

        const r = await p.probeIdentifier('who@corp.example');

        expect(r.kind).toBe('unknown');
        if (r.kind !== 'unknown') throw new Error('narrowing');
        expect(r.namespacesUnavailable.length).toBeGreaterThan(0);
    });

    it('escapes a quote rather than letting it break the OData filter', async () => {
        const { p, calls } = build([[/^GET .*\/users\?\$filter/, { status: 200, body: { value: [] } }]]);

        await p.probeIdentifier("o'brien@corp.example");

        expect(decodeURIComponent(calls[0].url)).toContain("o''brien");
    });
});

describe('createBlockedAccount', () => {
    it('creates SIGN-IN BLOCKED — the recoverable half is last', async () => {
        // An account nobody can sign into is recoverable by a human; one anyone
        // can sign into with no entitlements is not observable.
        const { p, calls } = build([[/^POST .*\/users$/, { status: 201, body: { id: 'new-1' } }]]);

        const r = await p.createBlockedAccount({
            identifier: 'joiner@corp.example', displayName: 'A Joiner', employeeId: 'emp-1',
        });

        expect(r.kind).toBe('applied');
        // Selected by METHOD, not by index: the policy preflight now runs
        // first, and an assertion keyed to call order would have to move every
        // time a step is added ahead of it.
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.body).toMatchObject({ accountEnabled: false });
    });

    it('does not put a predictable password on a real account', async () => {
        // Graph requires a passwordProfile even for a blocked account. It is
        // never signed in with — the credential is the pass minted two steps
        // later — but predictability here would be a predictable password on a
        // real account for the window between the create and the enable.
        const pw = (cs: Array<{ method: string; body: unknown }>) =>
            (cs.find((c) => c.method === 'POST')?.body as { passwordProfile: { password: string } })
                .passwordProfile.password;

        const { p, calls } = build([[/^POST .*\/users$/, { status: 201, body: { id: 'new-1' } }]]);
        await p.createBlockedAccount({ identifier: 'a@corp.example', displayName: 'A', employeeId: 'e' });
        const first = pw(calls);

        const { p: p2, calls: c2 } = build([[/^POST .*\/users$/, { status: 201, body: { id: 'new-2' } }]]);
        await p2.createBlockedAccount({ identifier: 'b@corp.example', displayName: 'B', employeeId: 'f' });
        const second = pw(c2);

        expect(first).not.toBe(second);
        expect(first.length).toBeGreaterThan(20);
    });

    it('names the permission on a 403 rather than reporting a generic failure', async () => {
        const { p } = build([[/^POST .*\/users$/, { status: 403 }]]);

        const r = await p.createBlockedAccount({ identifier: 'a@corp.example', displayName: 'A', employeeId: 'e' });

        expect(r.kind).toBe('refused');
        if (r.kind !== 'refused') throw new Error('narrowing');
        expect(r.detail).toContain('User.ReadWrite.All');
    });

    it('is INDETERMINATE on a 5xx — the account may exist', async () => {
        // Saying refused would assert the directory is unchanged, which nobody
        // verified.
        const { p } = build([[/^POST .*\/users$/, { status: 502 }]]);

        const r = await p.createBlockedAccount({ identifier: 'a@corp.example', displayName: 'A', employeeId: 'e' });

        expect(r.kind).toBe('indeterminate');
    });

    it('is INDETERMINATE when Graph accepts but returns no id', async () => {
        // The account cannot be addressed for the three steps that follow.
        const { p } = build([[/^POST .*\/users$/, { status: 201, body: {} }]]);

        const r = await p.createBlockedAccount({ identifier: 'a@corp.example', displayName: 'A', employeeId: 'e' });

        expect(r.kind).toBe('indeterminate');
    });
});

describe('issueCredential — the refusal the whole finding turned on', () => {
    const ID = '00000000-0000-4000-8000-000000000001';

    it('mints a Temporary Access Pass, and does NOT hand the pass back', async () => {
        // The pass is a bearer credential for the joiner. This product's job is
        // to mint it into the directory, not to carry it around — an
        // administrator reads it from Entra.
        const { p } = build([
            [/^POST .*temporaryAccessPassMethods$/, { status: 201, body: { temporaryAccessPass: 'SECRETPASS' } }],
        ]);

        const r = await p.issueCredential(ID);

        expect(r.kind).toBe('applied');
        expect(JSON.stringify(r)).not.toContain('SECRETPASS');
    });

    it('REFUSES when the tenant’s policy declines a pass — and never falls back to a password', async () => {
        // THE ASSERTION THIS FILE EXISTS FOR. A password fallback would hang a
        // credential the tenant's own policy declined on an account this
        // product just created.
        const { p, calls } = build([
            [/^POST .*temporaryAccessPassMethods$/, { status: 400, body: { error: { code: 'policyNotEnabled', message: 'TAP is not enabled' } } }],
        ]);

        const r = await p.issueCredential(ID);

        expect(r.kind).toBe('refused');
        if (r.kind !== 'refused') throw new Error('narrowing');
        expect(r.detail).toMatch(/different security posture/i);
        // Nothing else was attempted — no second call setting a password.
        expect(calls).toHaveLength(1);
    });

    it('names Policy.Read.All on a 403', async () => {
        const { p } = build([[/^POST .*temporaryAccessPassMethods$/, { status: 403 }]]);

        const r = await p.issueCredential(ID);

        expect(r.kind).toBe('refused');
        if (r.kind !== 'refused') throw new Error('narrowing');
        expect(r.detail).toContain('Policy.Read.All');
    });
});

describe('enableAccount', () => {
    const ID = '00000000-0000-4000-8000-000000000002';

    it('REFUSES a directory-synced account — Graph would be reverted by the next sync', async () => {
        // The account would report enabled and then disable itself, with a
        // trail saying onboarding succeeded. The same refusal the writer makes
        // on the way down.
        const { p, calls } = build([[/^PATCH/, { status: 204 }]]);

        const r = await p.enableAccount(ID, { onPremisesSyncEnabled: true });

        expect(r.kind).toBe('refused');
        expect(calls).toHaveLength(0);
    });

    it('enables a cloud-only account', async () => {
        const { p, calls } = build([[/^PATCH .*\/users\//, { status: 204 }]]);

        const r = await p.enableAccount(ID, { onPremisesSyncEnabled: false });

        expect(r.kind).toBe('applied');
        expect(calls[0].body).toStrictEqual({ accountEnabled: true });
    });
});

describe('readAccountState', () => {
    const ID = '00000000-0000-4000-8000-000000000003';

    it('captures what the enable is about to change', async () => {
        const { p } = build([
            [/^GET .*\/users\//, { status: 200, body: { accountEnabled: false, onPremisesSyncEnabled: false } }],
        ]);

        const r = await p.readAccountState(ID);

        expect(r).toStrictEqual({
            kind: 'read',
            priorState: { provider: 'entra-id', accountEnabled: false, onPremisesSyncEnabled: false },
        });
    });

    it('REFUSES rather than defaulting when Graph omits accountEnabled', async () => {
        // The enable is derived from this value; a default would make the
        // capture a record of our assumption rather than of the directory.
        const { p } = build([[/^GET .*\/users\//, { status: 200, body: { id: ID } }]]);

        expect((await p.readAccountState(ID)).kind).toBe('refused');
    });
});

/**
 * The second gate: the policy is read BEFORE anything is created.
 *
 * `issueCredential` already refuses a declined pass, and that refusal is
 * correct — but it arrives THIRD, after an account exists and has been added
 * to its entitlement group. What it leaves is an account that exists, is
 * entitled, has no credential and cannot sign in. Recoverable, but only by a
 * human who first has to work out what happened.
 *
 * Asking first turns that into a refusal with nothing to clean up, and it is
 * the gate that names this credential specifically: `joinerWritesEnabled` says
 * the tenant wants joiner writes here, and this says their directory will
 * actually permit the credential those writes depend on.
 */
describe('the Temporary Access Pass preflight', () => {
    const INPUT = { identifier: 'joiner@corp.example', displayName: 'A Joiner', employeeId: 'emp-1' };

    it('REFUSES before creating when the policy declines a pass', async () => {
        const { p, calls } = build([
            [/TemporaryAccessPass$/, { status: 200, body: { state: 'disabled' } }],
            [/^POST .*\/users$/, { status: 201, body: { id: 'should-not-exist' } }],
        ]);

        const r = await p.createBlockedAccount(INPUT);

        expect(r.kind).toBe('refused');
        // THE ASSERTION THAT MATTERS: no account was created. A refusal that
        // still left a user behind would be the ordering bug this preflight
        // exists to remove.
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('REFUSES when the policy cannot be READ — an answer nobody got is not permission', async () => {
        // Same reasoning as `probeIdentifier` reporting an unread namespace as
        // unknown rather than free. The cost of erring the other way is an
        // account created for a credential the directory will not issue.
        const { p, calls } = build([
            [/TemporaryAccessPass$/, { status: 500 }],
            [/^POST .*\/users$/, { status: 201, body: { id: 'should-not-exist' } }],
        ]);

        const r = await p.createBlockedAccount(INPUT);

        expect(r.kind).toBe('refused');
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('REFUSES a NON-OK response even when its body parses as enabled', async () => {
        // The case that separates the status check from the parse guard. With
        // an empty body a 500 already refuses, because `JSON.parse('')` throws
        // and the catch reports unknown — so deleting the status check stayed
        // green and this assertion is what closes that. A proxy serving a
        // cached body, or an error envelope that happens to parse, would
        // otherwise read as permission.
        const { p, calls } = build([
            [/TemporaryAccessPass$/, { status: 500, body: { state: 'enabled' } }],
            [/^POST .*\/users$/, { status: 201, body: { id: 'should-not-exist' } }],
        ]);

        const r = await p.createBlockedAccount(INPUT);

        expect(r.kind).toBe('refused');
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('names Policy.Read.All when the policy read is forbidden', async () => {
        const { p } = build([
            [/TemporaryAccessPass$/, { status: 403 }],
            [/^POST .*\/users$/, { status: 201, body: { id: 'x' } }],
        ]);

        const r = await p.createBlockedAccount(INPUT);

        if (r.kind !== 'refused') throw new Error('narrowing');
        expect(r.detail).toContain('Policy.Read.All');
    });

    it('proceeds when the policy permits it — the preflight is a gate, not a wall', async () => {
        // The positive control. Without it, every assertion above could be
        // satisfied by a provisioner that never creates anything at all.
        const { p, calls } = build([[/^POST .*\/users$/, { status: 201, body: { id: 'new-1' } }]]);

        const r = await p.createBlockedAccount(INPUT);

        expect(r.kind).toBe('applied');
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('keeps the LATE refusal too — the two are not alternatives', async () => {
        // Defence in depth: a policy can change between the preflight and the
        // third step, and `issueCredential` must still refuse rather than fall
        // back.
        const { p } = build([
            [/^POST .*temporaryAccessPassMethods$/, { status: 400, body: { error: { code: 'policyNotEnabled' } } }],
        ]);

        const r = await p.issueCredential('00000000-0000-4000-8000-000000000001');

        expect(r.kind).toBe('refused');
    });
});

/**
 * The identifier must be a usable userPrincipalName — the Active Directory
 * finding, applied here before it could be found the same way (#2880).
 *
 * The first version of this guard was `!upn || !nickname`, which did not hold:
 * `'pj151326'.split('@')[0]` is `'pj151326'`, so a bare name passed both halves
 * and became the UPN verbatim. The proving run produced exactly that against a
 * real DC — created, entitled, ENABLED and impossible to sign in as. Graph is
 * no stricter about it than LDAP was.
 */
describe('the identifier must be a usable userPrincipalName', () => {
    it.each([
        ['pj151326', 'the exact value the proving run produced'],
        ['', 'empty'],
        ['@corp.example', 'no local part'],
        ['person@corp', 'a domain with no dot'],
        ['a@b@corp.example', 'two at-signs'],
    ])('REFUSES %s (%s), and creates nothing', async (identifier) => {
        const { p, calls } = build([[/^POST .*\/users$/, { status: 201, body: { id: 'should-not-exist' } }]]);

        const r = await p.createBlockedAccount({ identifier, displayName: 'Someone', employeeId: 'e' });

        expect(r.kind).toBe('refused');
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('derives mailNickname from the local part of a qualified UPN', async () => {
        const { p, calls } = build([[/^POST .*\/users$/, { status: 201, body: { id: 'new-1' } }]]);

        await p.createBlockedAccount({
            identifier: 'new.person@corp.example', displayName: 'New Person', employeeId: 'e',
        });

        const post = calls.find((c) => c.method === 'POST');
        expect(post?.body).toMatchObject({
            userPrincipalName: 'new.person@corp.example',
            mailNickname: 'new.person',
        });
    });
});
