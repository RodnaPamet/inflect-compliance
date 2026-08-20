/**
 * The Active Directory leaver writer: what it captures, and what it refuses.
 *
 * Two things are being protected here, and they fail in opposite directions.
 *
 * 1. A disable writes the WHOLE `userAccountControl` integer back, because LDAP
 *    has no bitwise-set. So a plain `replace` silently reverts any other bit
 *    that moved since the read. The write must therefore be a compare-and-swap
 *    against the value the JOURNAL committed — not against a fresh read, which
 *    would succeed while making the journal's claim false.
 *
 * 2. `DirectoryWriteError.definitivelyNotApplied` is a positive claim that the
 *    directory is unchanged, and the orchestrator settles the journal row FAILED
 *    on it. A wrong `true` files the row under the one outcome that both
 *    `findRestorableState` and `listUnsettledWrites` exclude — the captured
 *    prior state becomes unreachable AND nobody is told to look. So a proven
 *    refusal must set it and a lost response must not, and both halves are
 *    asserted explicitly below rather than implied.
 *
 * Everything runs against an injected fake client reached through the
 * provider's own factory, so the scheme + host gates are exercised rather than
 * bypassed. Nothing here opens a socket.
 */
import type { LdapClientLike, LdapModification, LdapClientOptions } from '@/app-layer/integrations/providers/active-directory';

const lookupMock = jest.fn();
jest.mock('node:dns', () => ({
    promises: { lookup: (...a: unknown[]) => lookupMock(...a) },
}));

import { ActiveDirectoryProvider, formatObjectGuid } from '@/app-layer/integrations/providers/active-directory';
import {
    createActiveDirectoryWriter,
    objectGuidFilter,
    AD_PRIOR_STATE_SCHEMA,
    type AdPriorState,
} from '@/app-layer/integrations/providers/active-directory/writer';
import { DirectoryWriteError } from '@/app-layer/usecases/identity-disable-account';

/** The bit under test. Spelled here so a change to the source constant is visible. */
const ACCOUNTDISABLE = 0x2;
/** A real-looking UAC: NORMAL_ACCOUNT (0x200) | DONT_EXPIRE_PASSWORD (0x10000). */
const ENABLED_UAC = 0x10200;

const GUID = 'aabbccdd-eeff-0011-2233-445566778899';
const GUID_BYTES = Buffer.from([
    0xdd, 0xcc, 0xbb, 0xaa, 0xff, 0xee, 0x11, 0x00, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
]);
const DN = 'CN=Jo Bloggs,OU=Staff,DC=corp,DC=example,DC=com';

const CONNECTION = {
    url: 'ldaps://dc.corp.example.com:636',
    baseDN: 'DC=corp,DC=example,DC=com',
    bindDN: 'CN=svc-inflect,OU=Service,DC=corp,DC=example,DC=com',
    bindPassword: 'read-only-pw',
};

function userEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        objectGUID: GUID_BYTES,
        distinguishedName: DN,
        userAccountControl: String(ENABLED_UAC),
        uSNChanged: '184023',
        whenChanged: '20260819103000.0Z',
        sAMAccountName: 'jbloggs',
        userPrincipalName: 'jo.bloggs@corp.example.com',
        ...overrides,
    };
}

interface FakeOptions {
    entries?: Array<Record<string, unknown>>;
    rootDse?: Record<string, unknown> | null;
    rootDseThrows?: boolean;
    /** Thrown by `modify` AFTER the call is recorded, so the CAS shape stays assertable. */
    modifyThrows?: unknown;
    /** Simulate a read-only client — the interface makes `modify` optional. */
    omitModify?: boolean;
}

function fakeAd(options: FakeOptions = {}) {
    const clientsBuilt: LdapClientOptions[] = [];
    const binds: Array<{ dn: string; password: string }> = [];
    const searches: Array<{ base: string; options: Record<string, unknown> }> = [];
    const modifies: Array<{ dn: string; changes: readonly LdapModification[] }> = [];
    let unbinds = 0;

    const createClient = (opts: LdapClientOptions): LdapClientLike => {
        clientsBuilt.push(opts);
        const client: LdapClientLike = {
            bind: async (dn, password) => {
                binds.push({ dn, password });
            },
            search: async (base, searchOptions) => {
                searches.push({ base, options: searchOptions });
                if (base === '') {
                    if (options.rootDseThrows) throw new Error('RootDSE unavailable');
                    if (options.rootDse === null) return { searchEntries: [] };
                    return {
                        searchEntries: [options.rootDse ?? { dnsHostName: 'dc01.corp.example.com' }],
                    };
                }
                return { searchEntries: options.entries ?? [userEntry()] };
            },
            unbind: async () => {
                unbinds += 1;
            },
        };
        if (!options.omitModify) {
            client.modify = async (dn, changes) => {
                modifies.push({ dn, changes });
                if (options.modifyThrows !== undefined) throw options.modifyThrows;
            };
        }
        return client;
    };

    return {
        createClient,
        clientsBuilt,
        binds,
        searches,
        modifies,
        get unbinds() {
            return unbinds;
        },
    };
}

function makeWriter(fake: ReturnType<typeof fakeAd>, connection: Record<string, unknown> = CONNECTION) {
    return createActiveDirectoryWriter({
        connection,
        provider: new ActiveDirectoryProvider({ createClient: fake.createClient }),
    });
}

/** An LDAP result-code error, the shape ldapts' `ResultCodeError` presents. */
function ldapError(code: number, message: string): Error & { code: number } {
    return Object.assign(new Error(message), { code });
}

beforeEach(() => {
    lookupMock.mockReset();
    // The DC resolves inside private space, which is the only case the write
    // path permits at all (see the egress test below).
    lookupMock.mockResolvedValue([{ address: '10.20.30.40', family: 4 }]);
});

describe('the capture', () => {
    it('reads the account and reports enabled from the stored userAccountControl', async () => {
        const fake = fakeAd();
        const writer = makeWriter(fake);

        const state = await writer.readState(GUID);

        expect(writer.provider).toBe('active-directory');
        expect(state.enabled).toBe(true);
        expect(state.priorState.userAccountControl).toBe(ENABLED_UAC);
    });

    it('reports NOT enabled when the stored integer already carries ACCOUNTDISABLE', async () => {
        // The orchestrator's already-disabled short-circuit depends on this
        // being the same read the capture came from. If it were computed from a
        // stale ConnectedIdentityAccount row, a second disable would journal a
        // prior state of "disabled" — the state a later restore would restore
        // TO, destroying the real one permanently.
        const fake = fakeAd({
            entries: [userEntry({ userAccountControl: String(ENABLED_UAC | ACCOUNTDISABLE) })],
        });
        const state = await makeWriter(fake).readState(GUID);

        expect(state.enabled).toBe(false);
        expect(state.priorState.userAccountControl).toBe(ENABLED_UAC | ACCOUNTDISABLE);
    });

    it('captures everything a restore needs to put back every bit, not just the disable bit', async () => {
        const fake = fakeAd();
        const state = await makeWriter(fake).readState(GUID);
        const prior = state.priorState as unknown as AdPriorState;

        expect(prior).toEqual({
            schema: AD_PRIOR_STATE_SCHEMA,
            provider: 'active-directory',
            // 1. The whole stored integer — the only thing a restore writes back.
            userAccountControl: ENABLED_UAC,
            // 2. objectGUID explicitly: externalUserId is only USUALLY the GUID.
            objectGUID: GUID,
            // 3. The DN as read, stale by design once offboarding moves the object.
            distinguishedName: DN,
            sAMAccountName: 'jbloggs',
            userPrincipalName: 'jo.bloggs@corp.example.com',
            // 4. Both change tokens: per-DC and replicated.
            uSNChanged: '184023',
            whenChanged: '20260819103000.0Z',
            // 5. Which DC answered — uSNChanged means nothing without it.
            capturedFromDc: 'dc01.corp.example.com',
            capturedAt: expect.any(String),
            adminCount: null,
        });
    });

    it('never captures the computed userAccountControl, which is not restorable', async () => {
        // msDS-User-Account-Control-Computed carries derived bits (LOCKOUT
        // 0x10, PASSWORD_EXPIRED 0x800000) that do not exist in the stored
        // value. Writing one back corrupts the account, so it is not requested
        // and not stored under any key.
        const fake = fakeAd();
        const state = await makeWriter(fake).readState(GUID);

        const requested = fake.searches.find((s) => s.base !== '')?.options.attributes as string[];
        expect(requested).toContain('userAccountControl');
        expect(requested.join(',')).not.toMatch(/computed/i);
        expect(JSON.stringify(state.priorState)).not.toMatch(/computed/i);
    });

    it('records objectGUID as null when the entry cannot yield one, instead of inventing it', async () => {
        // formatObjectGuid returns undefined when the raw bytes do not
        // round-trip — the case where normalizeAdEntry silently falls back to
        // the DN as externalUserId. A restore must be able to see that.
        const fake = fakeAd({ entries: [userEntry({ objectGUID: undefined })] });
        const state = await makeWriter(fake).readState(DN);

        expect((state.priorState as unknown as AdPriorState).objectGUID).toBeNull();
        expect(state.priorState.distinguishedName).toBe(DN);
    });

    it('resolves a GUID id by an objectGUID filter, and a DN id by a base-scoped read', async () => {
        const byGuid = fakeAd();
        await makeWriter(byGuid).readState(GUID);
        const guidSearch = byGuid.searches.find((s) => s.base !== '');
        expect(guidSearch?.base).toBe(CONNECTION.baseDN);
        expect(guidSearch?.options.filter).toBe(objectGuidFilter(GUID));

        const byDn = fakeAd();
        await makeWriter(byDn).readState(DN);
        const dnSearch = byDn.searches.find((s) => s.base !== '');
        expect(dnSearch?.base).toBe(DN);
        expect(dnSearch?.options.scope).toBe('base');
    });

    it('objectGuidFilter is the exact inverse of formatObjectGuid', async () => {
        // The mixed-endian byte order is easy to get subtly wrong, and getting
        // it wrong means the search matches nothing — or, worse, matches
        // something else.
        expect(formatObjectGuid(GUID_BYTES)).toBe(GUID);
        const escaped = objectGuidFilter(GUID)
            .replace('(objectGUID=', '')
            .replace(')', '')
            .split('\\')
            .filter(Boolean)
            .map((h) => Number.parseInt(h, 16));
        expect(Buffer.from(escaped)).toEqual(GUID_BYTES);
    });

    it('refuses rather than guessing when the id matches more than one account', async () => {
        const fake = fakeAd({ entries: [userEntry(), userEntry({ distinguishedName: 'CN=Other' })] });
        await expect(makeWriter(fake).readState(GUID)).rejects.toThrow(/Refusing to guess/);
    });

    it('refuses when userAccountControl is unreadable, rather than defaulting it', async () => {
        const fake = fakeAd({ entries: [userEntry({ userAccountControl: undefined })] });
        await expect(makeWriter(fake).readState(GUID)).rejects.toThrow(/no readable userAccountControl/);
    });

    it('records a null DC rather than failing when RootDSE will not answer', async () => {
        const fake = fakeAd({ rootDseThrows: true });
        const state = await makeWriter(fake).readState(GUID);
        expect((state.priorState as unknown as AdPriorState).capturedFromDc).toBeNull();
    });
});

describe('the write is a compare-and-swap, not a replace', () => {
    it('sends one ModifyRequest: delete the journalled value, add it with ACCOUNTDISABLE set', async () => {
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        await writer.disable(GUID, state);

        expect(fake.modifies).toHaveLength(1);
        expect(fake.modifies[0].dn).toBe(DN);
        expect(fake.modifies[0].changes).toEqual([
            { operation: 'delete', type: 'userAccountControl', values: [String(ENABLED_UAC)] },
            {
                operation: 'add',
                type: 'userAccountControl',
                values: [String(ENABLED_UAC | ACCOUNTDISABLE)],
            },
        ]);
        // A `replace` here is the whole defect: it would take whatever integer
        // we last saw and write it over whatever is there now.
        expect(fake.modifies[0].changes.some((c) => c.operation === 'replace')).toBe(false);
    });

    it('preserves every other bit — the new value differs from the old by exactly ACCOUNTDISABLE', async () => {
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        await writer.disable(GUID, state);

        const before = Number(fake.modifies[0].changes[0].values[0]);
        const after = Number(fake.modifies[0].changes[1].values[0]);
        expect(after ^ before).toBe(ACCOUNTDISABLE);
    });

    it('compares against the JOURNALLED value, not a fresh read taken inside disable()', async () => {
        // The journal row has already COMMITTED `prior` as "what this write
        // replaced". Re-reading would let the write succeed while making that
        // record a lie, and a restore months later would put back a value that
        // was never there.
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        const searchesAfterRead = fake.searches.length;

        await writer.disable(GUID, state);

        expect(fake.searches).toHaveLength(searchesAfterRead);
        expect(fake.modifies[0].changes[0].values).toEqual([String(state.priorState.userAccountControl)]);
    });

    it('holds ONE bound connection across readState and disable, and closes it on request', async () => {
        // A client per call would let the read and the write land on different
        // domain controllers — AD is multi-master with minutes of replication
        // lag, so the CAS would fail spuriously and uSNChanged (per-DC) would
        // not be comparable to anything.
        const fake = fakeAd();
        const writer = makeWriter(fake);

        await writer.readState(GUID);
        await writer.disable(GUID, await writer.readState(GUID));

        expect(fake.clientsBuilt).toHaveLength(1);
        expect(fake.binds).toHaveLength(1);
        expect(fake.unbinds).toBe(0);

        await writer.close();
        expect(fake.unbinds).toBe(1);
        // Idempotent: a batch that closes in a finally, twice, is not an error.
        await expect(writer.close()).resolves.toBeUndefined();
        expect(fake.unbinds).toBe(1);
    });

    it('binds with the dedicated write credential when one is configured', async () => {
        // Least privilege: the enumeration credential runs unattended against
        // thousands of users, and it is documented as read-only.
        const fake = fakeAd();
        const writer = makeWriter(fake, {
            ...CONNECTION,
            writeBindDN: 'CN=svc-inflect-write,OU=Service,DC=corp,DC=example,DC=com',
            writeBindPassword: 'write-pw',
        });

        await writer.readState(GUID);

        expect(fake.binds).toEqual([
            { dn: 'CN=svc-inflect-write,OU=Service,DC=corp,DC=example,DC=com', password: 'write-pw' },
        ]);
    });
});

describe('the write path refuses a directory host it cannot place inside private space', () => {
    it('refuses before any client is built, even with TLS verification on', async () => {
        // rejectUnauthorized proves the host is who its certificate says it is.
        // It does not prove the host is the CUSTOMER's domain controller — and
        // `url` is unvalidated tenant-admin config. An attacker-chosen LDAP
        // server answers the disable with success, the journal settles APPLIED,
        // and the audit trail says the leaver was offboarded while the real
        // account is untouched.
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const fake = fakeAd();

        await expect(makeWriter(fake).readState(GUID)).rejects.toThrow(/private address space/);
        expect(fake.clientsBuilt).toEqual([]);
        expect(fake.binds).toEqual([]);
    });

    it('still goes through the provider factory, so ldap:// is refused there', async () => {
        const fake = fakeAd();
        const writer = makeWriter(fake, { ...CONNECTION, url: 'ldap://dc.corp.example.com:389' });

        await expect(writer.readState(GUID)).rejects.toThrow(/ldaps:\/\//);
        expect(fake.clientsBuilt).toEqual([]);
    });
});

describe('definitivelyNotApplied — a proven refusal sets it, a lost response does not', () => {
    /** Run a disable whose modify fails in a given way, and hand back the error. */
    async function disableFailingWith(thrown: unknown, entryOverrides: Record<string, unknown> = {}) {
        const fake = fakeAd({ modifyThrows: thrown, entries: [userEntry(entryOverrides)] });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        try {
            await writer.disable(GUID, state);
            throw new Error('expected the disable to reject');
        } catch (err) {
            return { err, fake };
        }
    }

    it('is TRUE for a proven refusal and FALSE for a lost response — the pair, side by side', async () => {
        // This is the assertion the whole class of bug reduces to. A wrong
        // `true` settles the journal row FAILED, which findRestorableState
        // (APPLIED / INDETERMINATE) and listUnsettledWrites (PENDING /
        // INDETERMINATE) both exclude: the capture becomes unreachable and
        // nobody is told to look.
        const proven = await disableFailingWith(ldapError(50, 'insufficient access rights'));
        const lost = await disableFailingWith(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

        expect(proven.err).toBeInstanceOf(DirectoryWriteError);
        expect((proven.err as DirectoryWriteError).definitivelyNotApplied).toBe(true);

        expect(lost.err).toBeInstanceOf(DirectoryWriteError);
        expect((lost.err as DirectoryWriteError).definitivelyNotApplied).toBe(false);
    });

    it.each([
        ['a CAS miss — the value moved (result 16)', ldapError(16, 'no such attribute')],
        ['the object moved or was deleted (result 32)', ldapError(32, 'no such object')],
        ['insufficient access rights (result 50)', ldapError(50, 'insufficient access')],
        ['the DC is unwilling to perform it (result 53)', ldapError(53, 'unwilling to perform')],
        ['a constraint violation (result 19)', ldapError(19, 'constraint violation')],
        ['invalid credentials (result 49)', ldapError(49, 'invalid credentials')],
    ])('proves nothing was applied: %s', async (_label, thrown) => {
        const { err } = await disableFailingWith(thrown);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });

    it.each([
        ['a timeout', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
        ['a reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
        ['a broken pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
        ['an abort', new DOMException('The operation was aborted.', 'AbortError')],
        ['a bare error with no code at all', new Error('socket hang up')],
        ['a thrown non-Error', 'something fell over'],
        ['LDAP "busy" (51), which only PROBABLY means unprocessed', ldapError(51, 'busy')],
        ['LDAP "unavailable" (52)', ldapError(52, 'unavailable')],
        ['LDAP "other" (80)', ldapError(80, 'other')],
        ['a result code from the future nobody has taught this code about', ldapError(4242, 'who knows')],
    ])('does NOT claim the directory is unchanged: %s', async (_label, thrown) => {
        const { err } = await disableFailingWith(thrown);
        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(false);
        expect((err as Error).message).toMatch(/UNKNOWN/);
    });

    it('is not fooled by a DOM legacy code that collides with an LDAP result code', async () => {
        // This one was a live defect. `new DOMException(msg, 'AbortError').code`
        // is 20, and LDAP result 20 is attributeOrValueExists — a PROVEN
        // refusal. So an aborted request, the archetypal lost response, read as
        // proof the directory was untouched: the row settles FAILED, the
        // capture becomes unreachable, and nobody is told to look. A numeric
        // `code` is not by itself evidence that a domain controller answered.
        const abort = new DOMException('The operation was aborted.', 'AbortError');
        expect(abort.code).toBe(20);

        const { err } = await disableFailingWith(abort);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(false);

        // …while an actual LDAP 20 from the DC still counts as proven.
        const real = await disableFailingWith(ldapError(20, 'attribute or value exists'));
        expect((real.err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });

    it('explains a CAS miss as a value that moved, and does not suggest overwriting it', async () => {
        const { err } = await disableFailingWith(ldapError(16, 'no such attribute'));
        expect((err as Error).message).toMatch(/compare-and-swap did not match/);
        expect((err as Error).message).toMatch(/nothing was written/i);
    });

    it('names the narrow delegated right on result 50, and warns off Domain Admins', async () => {
        // An operator told only "needs write access" grants Account Operators
        // or Domain Admins to the unattended sync credential. That is the worst
        // available outcome of shipping this writer.
        const { err } = await disableFailingWith(ldapError(50, 'insufficient access'));
        const message = (err as Error).message;

        expect(message).toMatch(/Write permission on the userAccountControl property/);
        expect(message).toMatch(/NOT Account Operators and NOT Domain Admins/);
        // No separate write bind was configured, so the read-only enumeration
        // account is what tried the write — say so.
        expect(message).toMatch(/READ-ONLY/);
    });

    it('names AdminSDHolder when the target carries adminCount, because delegation cannot help there', async () => {
        // The provider's own DEFAULT_ADMIN_GROUPS are all AD protected groups.
        // SDProp overwrites their ACLs from the AdminSDHolder template roughly
        // hourly, discarding OU-level delegation — so this writer fails on
        // exactly the privileged leavers whose offboarding matters most, and it
        // looks like flakiness unless it is named.
        const { err } = await disableFailingWith(ldapError(50, 'insufficient access'), { adminCount: '1' });
        const message = (err as Error).message;

        expect(message).toMatch(/AdminSDHolder/);
        expect(message).toMatch(/adminCount=1/);
        expect(message).toMatch(/do NOT escalate the service account to Domain Admin/);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
    });
});

describe('refusals taken before anything is sent', () => {
    it('refuses a prior-state capture this writer did not produce, and sends nothing', async () => {
        // beginWrite rejects only an EMPTY priorState, so a thin
        // `{ disabled: false }` would be journalled happily and is
        // unrestorable — and gives the CAS nothing to compare against.
        const fake = fakeAd();
        const writer = makeWriter(fake);

        const err = await writer
            .disable(GUID, { enabled: true, priorState: { disabled: false } })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/unconditional replace/);
        expect(fake.modifies).toEqual([]);
    });

    it('refuses a capture that is already disabled — that prior state is what a restore would restore TO', async () => {
        const fake = fakeAd({
            entries: [userEntry({ userAccountControl: String(ENABLED_UAC | ACCOUNTDISABLE) })],
        });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        const err = await writer.disable(GUID, state).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/restore would restore TO/);
        expect(fake.modifies).toEqual([]);
    });

    it('refuses a client that cannot modify, rather than reporting a success it never attempted', async () => {
        const fake = fakeAd({ omitModify: true });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        const err = await writer.disable(GUID, state).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/cannot perform a modify/);
    });

    it('refuses a capture taken from a different domain controller than this connection reached', async () => {
        // A CAS across two multi-master replicas is not a comparison: the
        // comparand may not have replicated here, or a later change may not
        // have — and the second case would revert something this DC has not
        // seen.
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        const foreign = {
            enabled: true,
            priorState: { ...state.priorState, capturedFromDc: 'dc07.branch.corp.example.com' },
        };

        const err = await writer.disable(GUID, foreign).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/multi-master/);
        expect(fake.modifies).toEqual([]);
    });
});
