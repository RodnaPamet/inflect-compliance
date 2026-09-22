/**
 * The live AD provisioner (#2750): the order, the encodings, and the refusals.
 *
 * Every test here is about a property that is invisible if you only check
 * "did it succeed" — an account created ENABLED works fine until someone signs
 * into it with no entitlements.
 */
import {
    createActiveDirectoryProvisioner,
    encodeUnicodePwd,
    escapeFilterValue,
    AD_COLLISION_NAMESPACES,
} from '@/app-layer/integrations/providers/active-directory/provisioner';

const CONNECTION = {
    // A private IP, not a hostname: `assertPrivateLdapHost` does a real DNS
    // lookup and refuses anything it cannot resolve to a private address. That
    // refusal is deliberate — a create issued to an attacker-chosen LDAP server
    // answers success and the journal records an account that does not exist.
    url: 'ldaps://192.168.56.10:636',
    baseDN: 'DC=corp,DC=example,DC=test',
    createOU: 'OU=Employees,DC=corp,DC=example,DC=test',
    writeBindDN: 'CN=svc-write,OU=Service,DC=corp,DC=example,DC=test',
    writeBindPassword: 'pw',
};
const GUID = '9d8b6065-231c-4c0c-a494-83ce83326f08';
const GUID_BYTES = Buffer.from('65608b9d1c230c4ca49483ce83326f08', 'hex');

interface Recorded { dn: string; attributes?: Record<string, unknown>; changes?: unknown[] }

function fakeAd(opts: { entries?: Array<Record<string, unknown>>; addThrows?: Error } = {}) {
    const adds: Recorded[] = [];
    const modifies: Recorded[] = [];
    const client = {
        isBound: true,
        bind: async () => {},
        unbind: async () => {},
        search: async () => ({
            searchEntries:
                opts.entries ?? [{ distinguishedName: 'CN=New Person,OU=Employees,DC=corp,DC=example,DC=test', objectGUID: GUID_BYTES }],
        }),
        add: async (dn: string, attributes: Record<string, unknown>) => {
            if (opts.addThrows) throw opts.addThrows;
            adds.push({ dn, attributes });
        },
        modify: async (dn: string, changes: unknown[]) => { modifies.push({ dn, changes }); },
    };
    const provider = {
        makeClient: async () => client,
    } as never;
    return { client, adds, modifies, provider };
}

const make = (f: ReturnType<typeof fakeAd>, over: Record<string, unknown> = {}) =>
    createActiveDirectoryProvisioner({
        connection: { ...CONNECTION, ...over },
        provider: f.provider,
        generatePassword: () => 'Str0ngPassw0rd!',
    });

describe('AD provisioner — created BLOCKED, which is the whole safety argument', () => {
    it('creates with userAccountControl 514, never 512', async () => {
        const f = fakeAd();
        const r = await make(f).createBlockedAccount({
            identifier: 'new.person@corp.example.test',
            displayName: 'New Person',
            employeeId: 'emp-1',
        });
        expect(r.kind).toBe('applied');
        // 514 = NORMAL_ACCOUNT (512) + ACCOUNTDISABLE (2). An account created
        // at 512 is signed-in-able before it has entitlements or a credential —
        // the one ordering mistake this sequence exists to prevent.
        expect(f.adds[0].attributes?.userAccountControl).toBe('514');
    });

    it('returns the directory objectGUID — everything downstream addresses by it', async () => {
        const f = fakeAd();
        const r = await make(f).createBlockedAccount({
            identifier: 'new.person@corp.example.test', displayName: 'New Person', employeeId: 'e',
        });
        expect(r).toMatchObject({ kind: 'applied', externalUserId: GUID });
    });

    it('caps sAMAccountName at 20 characters, which AD enforces', async () => {
        const f = fakeAd();
        await make(f).createBlockedAccount({
            identifier: 'an.extremely.long.identifier.indeed@corp.example.test',
            displayName: 'Long Name', employeeId: 'e',
        });
        expect(String(f.adds[0].attributes?.sAMAccountName).length).toBeLessThanOrEqual(20);
    });

    it('REFUSES without a creation OU rather than guessing one', async () => {
        const f = fakeAd();
        const r = await make(f, { createOU: '' }).createBlockedAccount({
            identifier: 'x@corp.example.test', displayName: 'X', employeeId: 'e',
        });
        // Guessing would put an account somewhere nobody delegated, and
        // possibly outside what the leaver pass is scoped to — so it could
        // never be disabled again.
        expect(r.kind).toBe('refused');
        expect(f.adds).toEqual([]);
    });

    it('a failed create is INDETERMINATE, not refused', async () => {
        // The distinction is the whole retry contract: "refused" means nothing
        // happened and you may retry; "indeterminate" means an account may
        // exist, and retrying blindly makes a duplicate.
        const f = fakeAd({ addThrows: new Error('server said no') });
        const r = await make(f).createBlockedAccount({
            identifier: 'x@corp.example.test', displayName: 'X', employeeId: 'e',
        });
        expect(r.kind).toBe('indeterminate');
    });
});

describe('AD provisioner — the encodings AD actually requires', () => {
    it('unicodePwd is the password QUOTED and UTF-16LE encoded', async () => {
        const encoded = encodeUnicodePwd('hunter2');
        expect(Buffer.isBuffer(encoded)).toBe(true);
        expect(encoded.toString('utf16le')).toBe('"hunter2"');
        // A plain string is rejected by AD, and the quotes are part of the
        // format rather than decoration.
        expect(encoded.toString('utf16le').startsWith('"')).toBe(true);
    });

    it('sets pwdLastSet to 0 so the password must change at first logon', async () => {
        const f = fakeAd();
        await make(f).issueCredential(GUID);
        const changes = f.modifies.at(-1)!.changes as Array<{ type: string; values: string[] }>;
        const pls = changes.find((c) => c.type === 'pwdLastSet');
        // 0 forces the change; -1 means the opposite and there is no boolean.
        expect(pls?.values).toEqual(['0']);
    });

    it('NEVER returns or logs the password it set', async () => {
        const f = fakeAd();
        const r = await make(f).issueCredential(GUID);
        expect(r.kind).toBe('applied');
        // A credential this code could hand back is one it could leak. The
        // person changes it at first logon; nothing needs to know it.
        expect(JSON.stringify(r)).not.toContain('Str0ngPassw0rd');
    });

    it('enables by writing 512, the account back to a normal user', async () => {
        const f = fakeAd();
        await make(f).enableAccount(GUID);
        const changes = f.modifies.at(-1)!.changes as Array<{ type: string; values: string[] }>;
        expect(changes[0]).toMatchObject({ type: 'userAccountControl', values: ['512'] });
    });
});

describe('AD provisioner — group membership lives on the GROUP', () => {
    it('modifies the group, not the user', async () => {
        const f = fakeAd();
        const GROUP = 'CN=Engineering,OU=Groups,DC=corp,DC=example,DC=test';
        const r = await make(f).assignGroup(GUID, GROUP);
        expect(r.kind).toBe('applied');
        // In AD the `member` attribute is on the group. Writing `memberOf` on
        // the user silently does nothing — it is computed, not stored.
        expect(f.modifies.at(-1)!.dn).toBe(GROUP);
        const changes = f.modifies.at(-1)!.changes as Array<{ type: string }>;
        expect(changes[0].type).toBe('member');
    });
});

describe('AD provisioner — the probe asks about both namespaces', () => {
    it('declares sAMAccountName and userPrincipalName', () => {
        expect([...AD_COLLISION_NAMESPACES]).toEqual(['sAMAccountName', 'userPrincipalName']);
    });

    it('reports free when nothing matches', async () => {
        const f = fakeAd({ entries: [] });
        const p = await make(f).probeIdentifier('new.person@corp.example.test');
        expect(p.kind).toBe('free');
        // Narrowed, not asserted through: `namespacesChecked` exists only on
        // the `free` variant. The union is deliberately shaped that way —
        // `taken` names WHICH namespace collided and `unknown` names which
        // could not be consulted, so no single field spans all three.
        if (p.kind === 'free') {
            expect(p.namespacesChecked).toEqual([...AD_COLLISION_NAMESPACES]);
        }
    });

    it('reports taken when something matches — never "unknown" like the snapshot arm', async () => {
        const f = fakeAd();
        const p = await make(f).probeIdentifier('taken@corp.example.test');
        // This is the entire point of a live arm: the snapshot provisioner
        // answers `unknown` to every probe because a stored enumeration cannot
        // answer a create-time uniqueness question.
        expect(p.kind).toBe('taken');
        // And it says WHICH namespace collided — the two have different
        // remedies, so "taken" alone would not be actionable.
        if (p.kind === 'taken') {
            expect(AD_COLLISION_NAMESPACES).toContain(p.namespace as never);
        }
    });

    it('escapes filter metacharacters so an identifier cannot alter the query', () => {
        expect(escapeFilterValue('a*b(c)')).not.toContain('*');
        expect(escapeFilterValue('a*b(c)')).not.toContain('(');
    });
});
