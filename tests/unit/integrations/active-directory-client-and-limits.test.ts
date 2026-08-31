/**
 * Branch + function coverage for `providers/active-directory/index.ts`.
 *
 * `tests/unit/integrations/active-directory-provider.test.ts` drives the
 * provider through an INJECTED `createClient`, which is exactly the seam that
 * makes the real one unexercised: `lazyLdaptsClient` — the adapter that every
 * unattended sync and every offboarding write actually runs through — was
 * reached by no test at all. Its whole job is translation (plain data in, the
 * library's `Change`/`Attribute` classes out) and a live `isBound` getter, and
 * a translation nobody checks is a translation that can be silently wrong.
 *
 * The rest of this file covers the enumeration limits: the MAX_USERS cap is
 * what marks a sync KNOWN-PARTIAL, and per CLAUDE.md a partial sync must NOT
 * drive deprovisioning — `complete: false` is the entire mechanism.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));

const mockLdaptsInstance: Record<string, unknown> = {};
const mockClientCtor = jest.fn(() => mockLdaptsInstance);

jest.mock('ldapts', () => ({
    Client: mockClientCtor,
    // Constructor functions rather than classes so the arguments the adapter
    // builds are inspectable as plain data.
    Change: function MockChange(this: Record<string, unknown>, opts: Record<string, unknown>) {
        this.kind = 'Change';
        Object.assign(this, opts);
    },
    Attribute: function MockAttribute(this: Record<string, unknown>, opts: Record<string, unknown>) {
        this.kind = 'Attribute';
        Object.assign(this, opts);
    },
}));

import { ActiveDirectoryProvider, assertPrivateLdapHost } from '@/app-layer/integrations/providers/active-directory';

const CONFIG = { url: 'ldaps://dc.corp.example.com:636', baseDN: 'DC=corp,DC=example,DC=com' };
const SECRETS = { bindDN: 'CN=svc,DC=corp', bindPassword: 'pw' };

function ldapClient(over: Record<string, unknown> = {}) {
    return {
        bind: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue({ searchEntries: [] }),
        unbind: jest.fn().mockResolvedValue(undefined),
        ...over,
    };
}

const adEntry = (over: Record<string, unknown> = {}) => ({
    sAMAccountName: 'ada',
    userPrincipalName: 'ada@corp.example.com',
    distinguishedName: 'CN=Ada,OU=Users,DC=corp,DC=example,DC=com',
    displayName: 'Ada Lovelace',
    userAccountControl: '512',
    ...over,
});

beforeEach(() => {
    mockLogger.warn.mockClear();
    mockClientCtor.mockClear();
    for (const key of Object.keys(mockLdaptsInstance)) delete mockLdaptsInstance[key];
    Object.assign(mockLdaptsInstance, {
        bind: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue({ searchEntries: [{ dn: 'CN=Ada' }] }),
        modify: jest.fn().mockResolvedValue(undefined),
        unbind: jest.fn().mockResolvedValue(undefined),
        isBound: false,
    });
});

/** The mocked ldapts spies, typed for assertion without a cast to any. */
const spy = (name: string) => mockLdaptsInstance[name] as jest.Mock;

describe('the real ldapts adapter (no injected client)', () => {
    it('constructs the library client with the TLS + timeout options the factory decided', async () => {
        const p = new ActiveDirectoryProvider();

        await p.makeClient(CONFIG);

        expect(mockClientCtor).toHaveBeenCalledWith({
            url: 'ldaps://dc.corp.example.com:636',
            tlsOptions: { rejectUnauthorized: true },
            timeout: 30_000,
            connectTimeout: 15_000,
        });
    });

    it('forwards bind, search and unbind, and returns the library search entries', async () => {
        const client = await new ActiveDirectoryProvider().makeClient(CONFIG);

        await client.bind('CN=svc,DC=corp', 'pw');
        const result = await client.search('DC=corp', { scope: 'sub', filter: '(objectClass=user)' });
        await client.unbind();

        expect(spy('bind')).toHaveBeenCalledWith('CN=svc,DC=corp', 'pw');
        expect(spy('search')).toHaveBeenCalledWith('DC=corp', { scope: 'sub', filter: '(objectClass=user)' });
        expect(result).toEqual({ searchEntries: [{ dn: 'CN=Ada' }] });
        expect(spy('unbind')).toHaveBeenCalled();
    });

    it('translates a plain LdapModification into the library Change/Attribute pair', async () => {
        // The interface speaks plain data precisely so callers and test fakes
        // stay free of `ldapts`. This adapter is the single place that
        // translation happens, so it is the single place it can be wrong — and
        // the value it writes is the ACCOUNTDISABLE bit on a real directory.
        const client = await new ActiveDirectoryProvider().makeClient(CONFIG);

        await client.modify!('CN=Ada,DC=corp', [
            { operation: 'replace', type: 'userAccountControl', values: ['514'] },
        ]);

        expect(spy('modify')).toHaveBeenCalledWith('CN=Ada,DC=corp', [
            {
                kind: 'Change',
                operation: 'replace',
                modification: { kind: 'Attribute', type: 'userAccountControl', values: ['514'] },
            },
        ]);
    });

    it('copies the values array rather than handing the caller readonly array to the library', async () => {
        const client = await new ActiveDirectoryProvider().makeClient(CONFIG);
        const values = ['514'];

        await client.modify!('CN=Ada,DC=corp', [{ operation: 'replace', type: 'userAccountControl', values }]);

        const changes = spy('modify').mock.calls[0][1] as Array<{ modification: { values: string[] } }>;
        expect(changes[0].modification.values).toEqual(values);
        expect(changes[0].modification.values).not.toBe(values);
    });

    it('exposes isBound as a LIVE getter, not a boolean snapshotted at construction', async () => {
        // The adapter object is built once and reused for the life of the
        // connection. A copied boolean would freeze the answer at construction
        // time — i.e. always report the state before the first bind — and the
        // writer's compare-and-swap rests on noticing a transparent reconnect.
        const client = await new ActiveDirectoryProvider().makeClient(CONFIG);
        expect(client.isBound).toBe(false);

        mockLdaptsInstance.isBound = true;
        expect(client.isBound).toBe(true);

        mockLdaptsInstance.isBound = false;
        expect(client.isBound).toBe(false);
    });

    it('is not reached at all when a client factory is injected', async () => {
        const injected = ldapClient();
        const p = new ActiveDirectoryProvider({ createClient: () => injected as never });
        expect(await p.makeClient(CONFIG)).toBe(injected);
        expect(mockClientCtor).not.toHaveBeenCalled();
    });
});

describe('assertPrivateLdapHost', () => {
    it('refuses a URL it cannot parse rather than proceeding on an unknown host', async () => {
        // Reached through the real factory: the scheme test is a regex, so a
        // mistyped IPv6 literal passes it and only `new URL` notices.
        const p = new ActiveDirectoryProvider();
        await expect(p.makeClient({ url: 'ldaps://[bad', allowSelfSignedTls: true })).rejects.toThrow(
            'Active Directory URL is malformed.',
        );
        expect(mockClientCtor).not.toHaveBeenCalled();
    });

    it('words the refusal for what the caller is actually doing', async () => {
        // The condition is deliberately identical for both purposes; only the
        // copy changes. A write refusal that talks about disabling TLS sends
        // the operator hunting for a toggle already in the safe position.
        const tls = await assertPrivateLdapHost('ldaps://8.8.8.8:636', 'tls-bypass').catch((e: Error) => e.message);
        const write = await assertPrivateLdapHost('ldaps://8.8.8.8:636', 'directory-write').catch(
            (e: Error) => e.message,
        );

        expect(tls).toContain('Refusing to disable TLS verification');
        expect(tls).toContain('Self-signed certificates are supported for internal directory hosts only.');
        expect(write).toContain('Refusing to write to an Active Directory host');
        expect(write).toContain('TLS verification is already ON for this write');
        expect(write).not.toContain('Refusing to disable TLS verification');
    });

    it('defaults to the tls-bypass wording when no purpose is given', async () => {
        await expect(assertPrivateLdapHost('ldaps://8.8.8.8:636')).rejects.toThrow(
            /^Refusing to disable TLS verification/,
        );
    });

    it('accepts a private IP literal without any resolution', async () => {
        await expect(assertPrivateLdapHost('ldaps://10.1.2.3:636', 'directory-write')).resolves.toBeUndefined();
    });
});

describe('allowSelfSignedTls — only the explicit opt-in disables verification', () => {
    const internal = { ...CONFIG, url: 'ldaps://10.10.0.5:636' };
    const build = async (over: Record<string, unknown>) => {
        const createClient = jest.fn().mockReturnValue(ldapClient());
        const p = new ActiveDirectoryProvider({ createClient });
        await p.makeClient({ ...internal, ...over });
        return createClient.mock.calls[0][0].tlsOptions.rejectUnauthorized as boolean;
    };

    it('honours a real boolean true as well as the string form', async () => {
        expect(await build({ allowSelfSignedTls: true })).toBe(false);
        expect(await build({ allowSelfSignedTls: 'TRUE' })).toBe(false);
    });

    it('keeps verification on for an empty string, an absent flag, and anything else truthy-looking', async () => {
        expect(await build({ allowSelfSignedTls: '' })).toBe(true);
        expect(await build({})).toBe(true);
        expect(await build({ allowSelfSignedTls: 'yes' })).toBe(true);
        expect(await build({ allowSelfSignedTls: 1 })).toBe(true);
        expect(await build({ allowSelfSignedTls: null })).toBe(true);
    });
});

describe('ActiveDirectoryProvider — enumeration limits (H3 known-partial)', () => {
    const entries = (n: number) =>
        Array.from({ length: n }, (_, i) =>
            adEntry({ distinguishedName: `CN=User${i},OU=Users,DC=corp,DC=example,DC=com` }),
        );

    const enumerate = async (n: number) => {
        const client = ldapClient({ search: jest.fn().mockResolvedValue({ searchEntries: entries(n) }) });
        const p = new ActiveDirectoryProvider({ createClient: () => client as never });
        return p.listAccounts({ ...CONFIG, ...SECRETS });
    };

    it('reports a complete enumeration below the cap and warns about nothing', async () => {
        const res = await enumerate(4999);
        expect(res.accounts).toHaveLength(4999);
        expect(res.complete).toBe(true);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('treats a result AT the cap as partial — the DC may have had more to send', async () => {
        const res = await enumerate(5000);
        expect(res.accounts).toHaveLength(5000);
        expect(res.complete).toBe(false);
    });

    it('truncates past the cap, marks the sync partial, and says so', async () => {
        // `complete: false` is what stops the deprovision reconcile treating
        // the users it never enumerated as departed.
        const res = await enumerate(5001);
        expect(res.accounts).toHaveLength(5000);
        expect(res.complete).toBe(false);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Active Directory enumeration hit MAX_USERS cap; sync marked partial (no deprovision reconcile)',
            expect.objectContaining({ cap: 5000 }),
        );
    });

    it('survives an unbind that fails — a dead socket must not fail a completed sync', async () => {
        const client = ldapClient({
            search: jest.fn().mockResolvedValue({ searchEntries: [adEntry()] }),
            unbind: jest.fn().mockRejectedValue(new Error('socket already closed')),
        });
        const p = new ActiveDirectoryProvider({ createClient: () => client as never });

        const res = await p.listAccounts({ ...CONFIG, ...SECRETS });

        expect(res.accounts).toHaveLength(1);
        expect(client.unbind).toHaveBeenCalled();
    });

    it('still unbinds when the search itself throws, and lets the error out', async () => {
        const client = ldapClient({ search: jest.fn().mockRejectedValue(new Error('sizeLimit exceeded')) });
        const p = new ActiveDirectoryProvider({ createClient: () => client as never });

        await expect(p.listAccounts({ ...CONFIG, ...SECRETS })).rejects.toThrow('sizeLimit exceeded');
        expect(client.unbind).toHaveBeenCalled();
    });
});

describe('ActiveDirectoryProvider — admin-group parsing and entry fallbacks', () => {
    const one = async (over: Record<string, unknown>, config: Record<string, unknown> = {}) => {
        const client = ldapClient({
            search: jest.fn().mockResolvedValue({ searchEntries: [adEntry(over)] }),
        });
        const p = new ActiveDirectoryProvider({ createClient: () => client as never });
        return (await p.listAccounts({ ...CONFIG, ...SECRETS, ...config })).accounts[0];
    };

    it('accepts the admin-group list in its array form as well as a comma string', async () => {
        expect((await one({ memberOf: ['CN=Ops Leads,DC=corp'] }, { adminGroups: ['Ops Leads'] })).isAdmin).toBe(true);
    });

    it('ignores blank entries and surrounding whitespace in the group list', async () => {
        expect((await one({ memberOf: ['CN=Ops Leads,DC=corp'] }, { adminGroups: ' , Ops Leads , ' })).isAdmin).toBe(
            true,
        );
        // A list of nothing but separators must not silently fall back to the
        // defaults — it is an explicit "no group counts as admin".
        expect((await one({ memberOf: ['CN=Domain Admins,DC=corp'] }, { adminGroups: ' , , ' })).isAdmin).toBe(false);
    });

    it('leaves the email empty when the entry carries no UPN, mail or account name', async () => {
        const a = await one({ userPrincipalName: undefined, mail: undefined, sAMAccountName: undefined });
        expect(a.email).toBe('');
        expect(a.externalUserId).toBe('CN=Ada,OU=Users,DC=corp,DC=example,DC=com');
    });

    it('reports on-prem mastery as an OBSERVED false — this directory is where the account lives', async () => {
        // The one provider where `false` is an observation rather than an
        // assumption; the leaver write-target rail reads it.
        expect((await one({})).onPremisesSyncEnabled).toBe(false);
    });
});
