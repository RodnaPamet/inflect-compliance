/**
 * Coverage wave E batch 3 — `providers/active-directory/index.ts`.
 *
 * The LDAP client is injectable via `deps.createClient`, so the bind + search
 * path runs with no domain controller.
 *
 * Three exported helpers carry real encoding risk and are tested directly:
 *   • `formatObjectGuid` — AD stores objectGUID MIXED-ENDIAN (first three
 *     groups little-endian, last two big-endian). Getting this wrong produces
 *     a stable but WRONG external id, which silently breaks account matching
 *     across syncs.
 *   • `fileTimeToDate` — Windows FILETIME is 100-ns ticks since 1601, well
 *     beyond Number precision, hence BigInt. The 0 and 0x7FFF… "never"
 *     sentinels must read as null, not as 1601 (which would make every such
 *     admin look maximally dormant).
 *   • `cnOf` — DN escaping.
 */
import {
    ActiveDirectoryProvider,
    formatObjectGuid,
    fileTimeToDate,
    cnOf,
} from '@/app-layer/integrations/providers/active-directory';

/** A stub ldapts-like client. */
function ldapClient(over: Record<string, unknown> = {}) {
    return {
        bind: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue({ searchEntries: [] }),
        unbind: jest.fn().mockResolvedValue(undefined),
        ...over,
    };
}

const CONFIG = {
    url: 'ldaps://dc.corp.example.com:636',
    baseDN: 'DC=corp,DC=example,DC=com',
};
const SECRETS = { bindDN: 'CN=svc,DC=corp', bindPassword: 'pw' };

// `createClient` is declared synchronous — `(opts) => LdapClientLike` — so it
// must return the client, not a promise of one.
const provider = (client = ldapClient()) => ({
    p: new ActiveDirectoryProvider({ createClient: () => client as never }),
    client,
});

const adEntry = (over: Record<string, unknown> = {}) => ({
    sAMAccountName: 'ada',
    userPrincipalName: 'ada@corp.example.com',
    distinguishedName: 'CN=Ada,OU=Users,DC=corp,DC=example,DC=com',
    displayName: 'Ada Lovelace',
    userAccountControl: '512',
    ...over,
});

describe('formatObjectGuid', () => {
    // Bytes 0..15; AD reverses the first 4, then 2, then 2.
    const buf = Buffer.from([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
        0x0d, 0x0e, 0x0f, 0x10,
    ]);
    const expected = '04030201-0605-0807-090a-0b0c0d0e0f10';

    it('decodes a Buffer with the mixed-endian layout', () => {
        expect(formatObjectGuid(buf)).toBe(expected);
    });

    it('accepts the value wrapped in an array (ldapts multi-value form)', () => {
        expect(formatObjectGuid([buf])).toBe(expected);
    });

    it('accepts a binary string and an array-wrapped binary string', () => {
        const s = buf.toString('binary');
        expect(formatObjectGuid(s)).toBe(expected);
        expect(formatObjectGuid([s])).toBe(expected);
    });

    it('returns undefined for anything that is not exactly 16 bytes', () => {
        expect(formatObjectGuid(Buffer.alloc(15))).toBeUndefined();
        expect(formatObjectGuid(Buffer.alloc(17))).toBeUndefined();
        expect(formatObjectGuid(undefined)).toBeUndefined();
        expect(formatObjectGuid(null)).toBeUndefined();
        expect(formatObjectGuid(42)).toBeUndefined();
        expect(formatObjectGuid([])).toBeUndefined();
    });

    it('zero-pads each byte', () => {
        expect(formatObjectGuid(Buffer.alloc(16))).toBe(
            '00000000-0000-0000-0000-000000000000',
        );
    });
});

describe('fileTimeToDate', () => {
    it('converts a real FILETIME to the corresponding date', () => {
        // 1601-01-01 + 11644473600s = 1970-01-01; add a day in 100-ns ticks.
        // BigInt(...) rather than `n` literals — the tsconfig target is below
        // ES2020, the same reason the source module spells them this way.
        const ticks =
            (BigInt('11644473600000') + BigInt('86400000')) * BigInt('10000');
        expect(fileTimeToDate(String(ticks))).toEqual(new Date('1970-01-02T00:00:00.000Z'));
    });

    it('treats 0 and the never-sentinel as no last logon', () => {
        expect(fileTimeToDate('0')).toBeNull();
        expect(fileTimeToDate('9223372036854775807')).toBeNull();
    });

    it('treats a negative tick count as no last logon', () => {
        expect(fileTimeToDate('-5')).toBeNull();
    });

    it('returns null for absent or unparseable values', () => {
        expect(fileTimeToDate(undefined)).toBeNull();
        expect(fileTimeToDate(null)).toBeNull();
        expect(fileTimeToDate('')).toBeNull();
        expect(fileTimeToDate('not-a-number')).toBeNull();
    });

    it('accepts the array-wrapped form', () => {
        // BigInt(...) rather than `n` literals — the tsconfig target is below
        // ES2020, the same reason the source module spells them this way.
        const ticks =
            (BigInt('11644473600000') + BigInt('86400000')) * BigInt('10000');
        expect(fileTimeToDate([String(ticks)])).toEqual(
            new Date('1970-01-02T00:00:00.000Z'),
        );
    });
});

describe('cnOf', () => {
    it('extracts the leading CN', () => {
        expect(cnOf('CN=Domain Admins,CN=Users,DC=corp')).toBe('Domain Admins');
    });

    it('is case-insensitive on the attribute name', () => {
        expect(cnOf('cn=Ada,DC=corp')).toBe('Ada');
    });

    it('unescapes backslash-escaped characters', () => {
        expect(cnOf('CN=Smith\\, John,DC=corp')).toBe('Smith, John');
    });

    it('returns null when the DN does not start with CN=', () => {
        expect(cnOf('OU=Users,DC=corp')).toBeNull();
        expect(cnOf('')).toBeNull();
    });
});

describe('ActiveDirectoryProvider — descriptor', () => {
    it('declares live validation and the shared identity checks', () => {
        const p = new ActiveDirectoryProvider();
        expect(p.id).toBe('active-directory');
        expect(p.liveValidation).toBe(true);
        expect(p.supportedChecks).toEqual([
            'mfa_enforced',
            'no_dormant_admins',
            'admin_count_within_threshold',
            'sso_enforced',
        ]);
        expect(p.configSchema.secretFields.map((f) => f.key)).toEqual([
            'bindDN',
            'bindPassword',
        ]);
    });
});

describe('ActiveDirectoryProvider.validateConnection', () => {
    it('rejects missing fields in order', async () => {
        const { p } = provider();
        expect((await p.validateConnection({}, SECRETS)).error).toBe(
            'An LDAPS URL is required.',
        );
        expect(
            (await p.validateConnection({ url: 'ldaps://dc', baseDN: '' }, SECRETS)).error,
        ).toBe('A base DN is required.');
        expect(
            (await p.validateConnection(CONFIG, { bindPassword: 'pw' })).error,
        ).toBe('A bind DN (service account) is required.');
        expect((await p.validateConnection(CONFIG, { bindDN: 'CN=svc' })).error).toBe(
            'A bind password is required.',
        );
    });

    it('refuses plaintext ldap:// — TLS is mandatory', async () => {
        const { p } = provider();
        expect(
            (await p.validateConnection({ ...CONFIG, url: 'ldap://dc' }, SECRETS)).error,
        ).toBe('The URL must use ldaps:// (LDAP over TLS).');
    });

    it('binds and probes the base DN, then unbinds', async () => {
        const { p, client } = provider();

        expect(await p.validateConnection(CONFIG, SECRETS)).toEqual({ valid: true });

        expect(client.bind).toHaveBeenCalledWith('CN=svc,DC=corp', 'pw');
        const [base, opts] = client.search.mock.calls[0];
        expect(base).toBe('DC=corp,DC=example,DC=com');
        expect(opts.scope).toBe('base');
        expect(opts.sizeLimit).toBe(1);
        expect(client.unbind).toHaveBeenCalled();
    });

    it('reports a failed bind and still unbinds', async () => {
        const client = ldapClient({
            bind: jest.fn().mockRejectedValue(new Error('invalid credentials')),
        });
        const { p } = provider(client);

        const res = await p.validateConnection(CONFIG, SECRETS);

        expect(res).toEqual({
            valid: false,
            error: 'Active Directory connection failed: invalid credentials',
        });
        expect(client.unbind).toHaveBeenCalled();
    });

    it('stringifies a non-Error bind failure', async () => {
        const client = ldapClient({ bind: jest.fn().mockRejectedValue('nope') });
        const { p } = provider(client);
        expect((await p.validateConnection(CONFIG, SECRETS)).error).toBe(
            'Active Directory connection failed: nope',
        );
    });

    it('verifies TLS by default and skips it only when opted in FOR AN INTERNAL HOST', async () => {
        // The opt-in half of this changed. Skipping certificate verification is
        // now permitted only when the host is internal, because that check is
        // what would otherwise make a redirected bind fail loudly — and the url
        // is tenant-admin config with no vendor allowlist to constrain it (an AD
        // host is customer infrastructure). The option's own justification is an
        // internal or enterprise CA, so it is bound to that condition rather
        // than to the operator asserting it.
        //
        // A private IP literal is used rather than a hostname because it needs
        // no DNS lookup; the resolution path is covered in
        // tests/unit/ad-tls-bypass-gating.test.ts.
        const createClient = jest.fn().mockReturnValue(ldapClient());
        const p = new ActiveDirectoryProvider({ createClient });
        const internal = { ...CONFIG, url: 'ldaps://10.10.0.5:636' };

        await p.validateConnection(internal, SECRETS);
        expect(createClient.mock.calls[0][0].tlsOptions.rejectUnauthorized).toBe(true);

        await p.validateConnection({ ...internal, allowSelfSignedTls: 'true' }, SECRETS);
        expect(createClient.mock.calls[1][0].tlsOptions.rejectUnauthorized).toBe(false);
    });
});

describe('ActiveDirectoryProvider.listAccounts', () => {
    it('uses an injected lister when provided', async () => {
        const listAccounts = jest.fn().mockResolvedValue([]);
        const p = new ActiveDirectoryProvider({ listAccounts });
        expect(await p.listAccounts(CONFIG)).toEqual({ accounts: [], complete: true });
    });

    it('binds, searches the subtree, and normalizes the entries', async () => {
        const client = ldapClient({
            search: jest.fn().mockResolvedValue({ searchEntries: [adEntry()] }),
        });
        const { p } = provider(client);

        const res = await p.listAccounts({ ...CONFIG, ...SECRETS });

        expect(client.bind).toHaveBeenCalledWith('CN=svc,DC=corp', 'pw');
        expect(client.search.mock.calls[0][1].scope).toBe('sub');
        expect(res.accounts).toHaveLength(1);
        expect(res.complete).toBe(true);
    });

    it('drops entries with no resolvable external id', async () => {
        const client = ldapClient({
            search: jest.fn().mockResolvedValue({
                searchEntries: [
                    {
                        sAMAccountName: undefined,
                        distinguishedName: undefined,
                        objectGUID: undefined,
                    },
                ],
            }),
        });
        const { p } = provider(client);
        expect((await p.listAccounts({ ...CONFIG, ...SECRETS })).accounts).toEqual([]);
    });
});

describe('ActiveDirectoryProvider — entry normalization', () => {
    const one = async (over: Record<string, unknown>, config: Record<string, unknown> = {}) => {
        const client = ldapClient({
            search: jest.fn().mockResolvedValue({ searchEntries: [adEntry(over)] }),
        });
        const { p } = provider(client);
        const res = await p.listAccounts({ ...CONFIG, ...SECRETS, ...config });
        return res.accounts[0];
    };

    it('prefers the objectGUID as the external id, falling back to the DN', async () => {
        const guid = Buffer.alloc(16, 1);
        expect((await one({ objectGUID: guid })).externalUserId).toBe(
            formatObjectGuid(guid),
        );
        expect((await one({})).externalUserId).toBe(
            'CN=Ada,OU=Users,DC=corp,DC=example,DC=com',
        );
    });

    it('drops an entry carrying neither an objectGUID nor a DN', async () => {
        // `dn` defaults to '' rather than undefined, so the `?? sam` rung of
        // the id chain is unreachable — such an entry resolves to an empty id
        // and is filtered out. Documented here because the fallback chain
        // reads as though sAMAccountName were a third option; it isn't.
        const client = ldapClient({
            search: jest
                .fn()
                .mockResolvedValue({ searchEntries: [adEntry({ distinguishedName: undefined })] }),
        });
        const { p } = provider(client);
        expect((await p.listAccounts({ ...CONFIG, ...SECRETS })).accounts).toEqual([]);
    });

    it('prefers the UPN for email, then mail, then sAMAccountName', async () => {
        expect((await one({})).email).toBe('ada@corp.example.com');
        expect(
            (await one({ userPrincipalName: undefined, mail: 'ada@other.com' })).email,
        ).toBe('ada@other.com');
        expect(
            (await one({ userPrincipalName: undefined, mail: undefined })).email,
        ).toBe('ada');
    });

    it('falls back to sAMAccountName for the display name', async () => {
        expect((await one({ displayName: undefined })).displayName).toBe('ada');
    });

    it('reads the ACCOUNTDISABLE bit out of userAccountControl', async () => {
        // 512 = normal account; 514 = normal + ACCOUNTDISABLE (0x2).
        expect((await one({ userAccountControl: '512' })).status).toBe('ACTIVE');
        expect((await one({ userAccountControl: '514' })).status).toBe('SUSPENDED');
    });

    it('treats an unparseable or absent UAC as not disabled', async () => {
        expect((await one({ userAccountControl: 'abc' })).status).toBe('ACTIVE');
        expect((await one({ userAccountControl: undefined })).status).toBe('ACTIVE');
    });

    it('derives isAdmin from direct group membership against the default groups', async () => {
        expect(
            (await one({ memberOf: ['CN=Domain Admins,CN=Users,DC=corp'] })).isAdmin,
        ).toBe(true);
        expect((await one({ memberOf: ['CN=Sales,DC=corp'] })).isAdmin).toBe(false);
        expect((await one({})).isAdmin).toBe(false);
    });

    it('matches admin groups case-insensitively', async () => {
        expect(
            (await one({ memberOf: ['CN=DOMAIN ADMINS,DC=corp'] })).isAdmin,
        ).toBe(true);
    });

    it('honours a custom admin-group list', async () => {
        expect(
            (
                await one(
                    { memberOf: ['CN=Ops Leads,DC=corp'] },
                    { adminGroups: 'Ops Leads, Other' },
                )
            ).isAdmin,
        ).toBe(true);
        // …and the defaults no longer apply once overridden.
        expect(
            (
                await one(
                    { memberOf: ['CN=Domain Admins,DC=corp'] },
                    { adminGroups: 'Ops Leads' },
                )
            ).isAdmin,
        ).toBe(false);
    });

    it('exposes the group CNs and skips unparseable DNs', async () => {
        const a = await one({
            memberOf: ['CN=Sales,DC=corp', 'OU=NotACn,DC=corp'],
        });
        expect(a.groups).toEqual(['Sales']);
    });

    it('accepts a single-string memberOf as well as an array', async () => {
        expect((await one({ memberOf: 'CN=Sales,DC=corp' })).groups).toEqual(['Sales']);
    });

    it('reports MFA and SSO as unknown — on-prem AD carries neither attribute', async () => {
        const a = await one({});
        expect(a.mfaEnrolled).toBeNull();
        expect(a.ssoEnrolled).toBeNull();
    });

    it('converts lastLogonTimestamp from FILETIME', async () => {
        // BigInt(...) rather than `n` literals — the tsconfig target is below
        // ES2020, the same reason the source module spells them this way.
        const ticks =
            (BigInt('11644473600000') + BigInt('86400000')) * BigInt('10000');
        expect((await one({ lastLogonTimestamp: String(ticks) })).lastActiveAt).toEqual(
            new Date('1970-01-02T00:00:00.000Z'),
        );
        expect((await one({})).lastActiveAt).toBeNull();
    });
});
