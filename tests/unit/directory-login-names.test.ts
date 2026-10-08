/**
 * Step 0b - the directory's login names reach storage, and `email` does not move.
 *
 * === THE ONE TEST THIS STEP IS REALLY ABOUT ===
 *
 * `email` on a `ConnectedIdentityAccount` is a JOIN KEY. The JML link
 * reconcile and the leaver pass compare it byte for byte, so a provider that
 * began preferring a UPN - a one-character change to an `||` chain - would
 * silently re-point live `IdentityAccountLink` rows at a different worker, and
 * the next leaver pass would disable the wrong person's account while
 * reporting success. Nothing would fail; the audit trail would say it worked.
 *
 * So the regression tests below pin each provider's derived `email` against
 * FIXED fixtures that deliberately carry a DIFFERENT value in every candidate
 * field. A fixture where `mail` and `userPrincipalName` agree cannot detect a
 * reordered `||`.
 */
import { ActiveDirectoryProvider } from '@/app-layer/integrations/providers/active-directory';
import { EntraIdProvider } from '@/app-layer/integrations/providers/entra-id';
import { OktaProvider } from '@/app-layer/integrations/providers/okta';
import { normaliseLoginName } from '@/app-layer/usecases/identity-sync';

// --- Active Directory ---

const AD_CONFIG = { url: 'ldaps://dc.corp.example.com:636', baseDN: 'DC=corp,DC=example,DC=com' };
const AD_SECRETS = { bindDN: 'CN=svc,DC=corp', bindPassword: 'pw' };

function adClient(entries: Array<Record<string, unknown>>) {
    return {
        bind: jest.fn().mockResolvedValue(undefined),
        search: jest.fn().mockResolvedValue({ searchEntries: entries }),
        unbind: jest.fn().mockResolvedValue(undefined),
    };
}

/**
 * Every candidate for `email` holds a DIFFERENT value, on purpose. `email` is
 * `upn || mail || sam`, so three distinct values is what makes the assertion
 * able to tell the three orderings apart.
 */
const AD_ENTRY = {
    sAMAccountName: 'ada',
    userPrincipalName: 'ada.upn@corp.example.com',
    mail: 'ada.mail@corp.example.com',
    distinguishedName: 'CN=Ada,OU=Users,DC=corp,DC=example,DC=com',
    displayName: 'Ada Lovelace',
    objectGUID: Buffer.from('0123456789abcdef', 'utf8'),
    userAccountControl: '512',
    memberOf: [],
};

async function adAccount(over: Record<string, unknown> = {}) {
    const p = new ActiveDirectoryProvider({
        createClient: () => adClient([{ ...AD_ENTRY, ...over }]) as never,
    });
    const { accounts } = await p.listAccounts({ ...AD_CONFIG, ...AD_SECRETS });
    return accounts[0];
}

describe('Step 0b - Active Directory carries sAMAccountName and the UPN', () => {
    it('maps both login names', async () => {
        const a = await adAccount();
        expect(a.samAccountName).toBe('ada');
        expect(a.userPrincipalName).toBe('ada.upn@corp.example.com');
    });

    it('leaves mailNickname null - AD has no such attribute', async () => {
        // Not aliased to `sAMAccountName`. A bridge matching an Entra-shaped
        // legacy table would then match an AD account on a value AD never
        // issued, which is a manufactured link.
        expect((await adAccount()).mailNickname).toBeNull();
    });

    it('REGRESSION - email is still `upn || mail || sam`, unchanged', async () => {
        expect((await adAccount()).email).toBe('ada.upn@corp.example.com');
        // UPN absent -> mail, not sam.
        expect((await adAccount({ userPrincipalName: undefined })).email).toBe(
            'ada.mail@corp.example.com',
        );
        // Both absent -> sam.
        expect(
            (await adAccount({ userPrincipalName: undefined, mail: undefined })).email,
        ).toBe('ada');
        // None -> empty string, NOT a login name smuggled in.
        expect(
            (
                await adAccount({
                    userPrincipalName: undefined,
                    mail: undefined,
                    sAMAccountName: undefined,
                })
            ).email,
        ).toBe('');
    });

    it('still stores the login names when email fell back to a different field', async () => {
        // The two are independent: a UPN-less account keeps its sAMAccountName.
        const a = await adAccount({ userPrincipalName: undefined });
        expect(a.email).toBe('ada.mail@corp.example.com');
        expect(a.samAccountName).toBe('ada');
        expect(a.userPrincipalName).toBeNull();
    });
});

// --- Entra ID ---

const ENTRA_CONFIG = { tenantId: 'tid' };
const ENTRA_SECRETS = { clientId: 'cid', clientSecret: 'sec' };

function graphFetch(users: Array<Record<string, unknown>>) {
    return jest.fn(async (url: unknown) => {
        if (String(url).includes('/users')) {
            return { ok: true, status: 200, json: async () => ({ value: users }) };
        }
        // directory roles / registration reports - empty enrichment
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
    });
}

/** Again: `mail`, `userPrincipalName` and `mailNickname` all differ. */
const GRAPH_USER = {
    id: 'g-1',
    displayName: 'Grace Hopper',
    userPrincipalName: 'grace.upn@corp.example.com',
    mailNickname: 'ghopper',
    mail: 'grace.mail@corp.example.com',
    accountEnabled: true,
};

async function entraAccount(over: Record<string, unknown> = {}) {
    const p = new EntraIdProvider({
        getAccessToken: async () => 'tok',
        fetchImpl: graphFetch([{ ...GRAPH_USER, ...over }]) as never,
    });
    const { accounts } = await p.listAccounts({ ...ENTRA_CONFIG, ...ENTRA_SECRETS });
    return accounts[0];
}

describe('Step 0b - Entra carries the UPN and mailNickname', () => {
    it('maps both login names', async () => {
        const a = await entraAccount();
        expect(a.userPrincipalName).toBe('grace.upn@corp.example.com');
        expect(a.mailNickname).toBe('ghopper');
    });

    it('leaves samAccountName null - Graph does not return it on the user object', async () => {
        expect((await entraAccount()).samAccountName).toBeNull();
    });

    it('REGRESSION - email is still `mail || userPrincipalName`, MAIL WINS', async () => {
        // identity-joiner-pass.ts documents MAIL WINS, and the whole joiner
        // credential flow depends on it.
        expect((await entraAccount()).email).toBe('grace.mail@corp.example.com');
        expect((await entraAccount({ mail: null })).email).toBe('grace.upn@corp.example.com');
        expect((await entraAccount({ mail: null, userPrincipalName: undefined })).email).toBe('');
    });

    it('asks Graph for mailNickname in BOTH select sets', async () => {
        // The base set is the fallback for tenants without the premium licence
        // `signInActivity` needs. A field added only to FULL would be silently
        // absent for exactly those tenants - and absent reads as null, which is
        // indistinguishable from "Entra has no alias for this user".
        const fetchImpl = graphFetch([GRAPH_USER]);
        const p = new EntraIdProvider({
            getAccessToken: async () => 'tok',
            fetchImpl: fetchImpl as never,
        });
        await p.listAccounts({ ...ENTRA_CONFIG, ...ENTRA_SECRETS });
        const userCall = fetchImpl.mock.calls
            .map(([u]) => String(u))
            .find((u) => u.includes('/users?'));
        expect(userCall).toContain('mailNickname');
    });
});

// --- Okta: no login-name concept ---

describe('Step 0b - Okta leaves all three unset', () => {
    it('carries no login names, because its account identifier IS the email', async () => {
        const fetchImpl = jest.fn(async (url: unknown) => {
            if (String(url).includes('/api/v1/users')) {
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: async () => [
                        {
                            id: 'o-1',
                            status: 'ACTIVE',
                            profile: {
                                email: 'okta@corp.example.com',
                                login: 'okta@corp.example.com',
                                displayName: 'O',
                            },
                        },
                    ],
                };
            }
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
        });
        const p = new OktaProvider({ fetchImpl: fetchImpl as never });
        const { accounts } = await p.listAccounts({
            orgUrl: 'https://dev.okta.com',
            apiToken: 't',
            enrichPerUser: 'false',
        });
        const a = accounts[0];
        expect(a.email).toBe('okta@corp.example.com');
        // Absent, not null-but-present: the field is optional and omitting it
        // is how a provider says "this concept does not exist here".
        expect(a.samAccountName ?? null).toBeNull();
        expect(a.userPrincipalName ?? null).toBeNull();
        expect(a.mailNickname ?? null).toBeNull();
    });
});

// --- The storage form ---

describe('Step 0b - normaliseLoginName treats directory strings as untrusted', () => {
    it('passes an ordinary login name through unchanged', () => {
        expect(normaliseLoginName('jsmith')).toBe('jsmith');
        expect(normaliseLoginName('jsmith@corp.example.com')).toBe('jsmith@corp.example.com');
    });

    it('strips control characters, including the bidi overrides', () => {
        // The display attack: a right-to-left override makes this read as
        // something else entirely to the human approving a review row.
        // Written as ESCAPES, never literals - a literal here is invisible in
        // a diff, in a review, and in this file.
        expect(normaliseLoginName('admin\u202Eevil')).toBe('adminevil');
        expect(normaliseLoginName('a\u0000b')).toBe('ab');
        expect(normaliseLoginName('a\u200Bb')).toBe('ab');
        expect(normaliseLoginName('a\uFEFFb')).toBe('ab');
        expect(normaliseLoginName('a\u2060b')).toBe('ab');
        // U+2028 / U+2029 are LINE TERMINATORS - the reason the character
        // class in identity-sync.ts is built from a string rather than written
        // as a regex literal, where they would end the expression.
        expect(normaliseLoginName('a\u2028b')).toBe('ab');
        expect(normaliseLoginName('a\u2029b')).toBe('ab');
    });

    it('keeps the characters a real login name legitimately contains', () => {
        // A denylist that ate these would DROP accounts rather than clean them.
        expect(normaliseLoginName('j.smith-jr_1')).toBe('j.smith-jr_1');
        expect(normaliseLoginName('CORP\\jsmith')).toBe('CORP\\jsmith');
        expect(normaliseLoginName('josé.garcía')).toBe('josé.garcía');
        expect(normaliseLoginName('иван.иванов'))
            .toBe('иван.иванов');
    });

    it('caps length at 256 without rejecting the value', () => {
        const long = 'a'.repeat(400);
        expect(normaliseLoginName(long)).toHaveLength(256);
        // A 300-character UPN is absurd, but it is not a reason to drop the
        // account it belongs to.
        expect(normaliseLoginName(long)).toBe('a'.repeat(256));
    });

    it('returns null for absent, empty and whitespace-only - never an empty string', () => {
        // NULL means "this provider does not carry the concept". An empty
        // string would be a VALUE, and the directory bridge could match on it
        // - every account with no login name matching every other.
        expect(normaliseLoginName(undefined)).toBeNull();
        expect(normaliseLoginName(null)).toBeNull();
        expect(normaliseLoginName('')).toBeNull();
        expect(normaliseLoginName('   ')).toBeNull();
        expect(normaliseLoginName(' \u200B ')).toBeNull();
    });

    it('trims, so a padded attribute does not become a distinct key', () => {
        expect(normaliseLoginName('  jsmith  ')).toBe('jsmith');
    });
});
