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
    /**
     * RootDSE answers consumed IN ORDER, the last repeating.
     *
     * This is what lets a test model the thing the writer's whole
     * compare-and-swap rests on: `ldaps://dc.corp.example.com` resolves to every
     * DC in the domain, so a socket that is re-opened underneath ldapts can come
     * back attached to a different replica. A single fixed answer cannot express
     * that, which is why the affinity refusal was previously unreachable except
     * by hand-forging a capture.
     */
    rootDseSequence?: Array<Record<string, unknown> | null>;
    /**
     * Drives `LdapClientLike.isBound` — ldapts' tell for a transparently
     * re-established socket. Absent models a client that cannot report, which is
     * every other fake in this file.
     */
    isBound?: () => boolean;
    /** Thrown by `modify` AFTER the call is recorded, so the CAS shape stays assertable. */
    modifyThrows?: unknown;
    /** Simulate a read-only client — the interface makes `modify` optional. */
    omitModify?: boolean;
    /** Every bind rejects with this. Models a rotated service-account password. */
    bindRejects?: unknown;
    /** Per-attempt control: return an error to reject, or null to let it succeed. */
    bindRejectsUntil?: () => unknown;
}

function fakeAd(options: FakeOptions = {}) {
    const clientsBuilt: LdapClientOptions[] = [];
    const binds: Array<{ dn: string; password: string }> = [];
    const searches: Array<{ base: string; options: Record<string, unknown> }> = [];
    const modifies: Array<{ dn: string; changes: readonly LdapModification[] }> = [];
    let unbinds = 0;

    let rootDseReads = 0;

    const createClient = (opts: LdapClientOptions): LdapClientLike => {
        clientsBuilt.push(opts);
        const client: LdapClientLike = {
            bind: async (dn, password) => {
                // Recorded BEFORE the rejection, so a test can count the binds
                // a directory actually received — which is the whole point when
                // the hazard is a lockout counter on the other side.
                binds.push({ dn, password });
                if (options.bindRejects) throw options.bindRejects;
                const e = options.bindRejectsUntil?.();
                if (e) throw e;
            },
            get isBound() {
                return options.isBound?.();
            },
            search: async (base, searchOptions) => {
                searches.push({ base, options: searchOptions });
                if (base === '') {
                    if (options.rootDseThrows) throw new Error('RootDSE unavailable');
                    if (options.rootDseSequence) {
                        const seq = options.rootDseSequence;
                        const answer = seq[Math.min(rootDseReads, seq.length - 1)];
                        rootDseReads += 1;
                        return { searchEntries: answer === null ? [] : [answer] };
                    }
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
        const accountReads = () => fake.searches.filter((s) => s.base !== '').length;
        const readsAfterRead = accountReads();

        await writer.disable(GUID, state);

        // Counting ACCOUNT reads specifically. `disable` does take one more
        // round trip — a RootDSE base search confirming which domain controller
        // is answering the socket it is about to write through — and that one is
        // required, not incidental: without it the affinity check compares
        // `capturedFromDc` against the variable it was copied from. What must
        // never happen is a re-read of the ACCOUNT, which would let the write
        // succeed while making the journal's committed claim false.
        expect(accountReads()).toBe(readsAfterRead);
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

    it('says what is actually being refused — a write, not a TLS downgrade', async () => {
        // The write path asserts the private-host condition UNCONDITIONALLY,
        // while the read path asserts it only when `allowSelfSignedTls` is on.
        // Both used one message, written for the read case, so an operator whose
        // disable was refused here was told the product was "refusing to disable
        // TLS verification" — which is not happening; verification is ON — and
        // went looking for a TLS toggle already in the safe position instead of
        // for the network path the refusal is about.
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const fake = fakeAd();

        const err = await makeWriter(fake).readState(GUID).catch((e: unknown) => e);
        const message = (err as Error).message;

        expect(message).toMatch(/private address space/);
        expect(message).not.toMatch(/disable TLS verification/i);
        expect(message).toMatch(/Refusing to write to an Active Directory host/);
        expect(message).toMatch(/VPN or private link/);
    });

    it('leaves the TLS-bypass wording where it belongs — on the self-signed path', async () => {
        // The two refusals share one condition on purpose (two spellings of one
        // host check is how a future edit relaxes it on one path while everyone
        // reads the other). Only the copy differs, and it has to keep differing.
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

        const err = await new ActiveDirectoryProvider()
            .makeClient({ url: CONNECTION.url, allowSelfSignedTls: true })
            .catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/Refusing to disable TLS verification/);
        expect((err as Error).message).toMatch(/private address space/);
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

describe('the base DN is the scope this writer is entitled to', () => {
    const FOREIGN_DN = 'CN=Someone Else,OU=Staff,DC=other,DC=example,DC=com';

    it('refuses a DN-shaped account id that does not lie beneath the configured base DN', async () => {
        // `externalUserId` is the objectGUID only USUALLY: `normalizeAdEntry`
        // falls back to the DN whenever the raw 16 bytes will not format, so the
        // DN shape is a real stored identifier. The GUID branch is contained by
        // construction — it is a filtered search UNDER baseDN — but the DN
        // branch reads whatever DN it is handed, base-scoped, anywhere in the
        // directory including other naming contexts.
        const fake = fakeAd();

        const err = await makeWriter(fake).readState(FOREIGN_DN).catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/does not lie beneath the base DN/);
        expect((err as Error).message).toContain(CONNECTION.baseDN);
        // Refused BEFORE the read, not after it: an object outside the scope an
        // operator configured is not one to go and look at first.
        expect(fake.searches.filter((s) => s.base !== '')).toEqual([]);
        expect(fake.modifies).toEqual([]);
    });

    it('accepts a DN-shaped id that does lie beneath it', async () => {
        const fake = fakeAd();
        const state = await makeWriter(fake).readState(DN);
        expect(state.enabled).toBe(true);
        expect(fake.searches.find((s) => s.base !== '')?.base).toBe(DN);
    });

    it('re-checks the DN the ModifyRequest is addressed to, which came back out of the journal', async () => {
        // The DN that reaches `c.modify(...)` is read from
        // `IdentityWriteJournal.priorStateJson` — a plaintext column that has
        // been through Postgres since the read — so it is not necessarily the DN
        // this process resolved. This is the only check between a tampered or
        // foreign capture and a ModifyRequest addressed anywhere in the tree.
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        const err = await writer
            .disable(GUID, {
                enabled: true,
                priorState: { ...state.priorState, distinguishedName: FOREIGN_DN },
            })
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/does not lie beneath the base DN/);
        expect(fake.modifies).toEqual([]);
    });

    it('is not confused by an escaped comma inside a common name', async () => {
        // `CN=Bloggs\, Jo,OU=Staff,DC=corp,...` is three components, not four.
        // A naive split would make an ordinary surname look like an out-of-scope
        // DN and refuse a perfectly legitimate account.
        const escapedDn = 'CN=Bloggs\, Jo,OU=Staff,DC=corp,DC=example,DC=com';
        const fake = fakeAd({ entries: [userEntry({ distinguishedName: escapedDn })] });

        const state = await makeWriter(fake).readState(escapedDn);
        expect(state.priorState.distinguishedName).toBe(escapedDn);
    });
});

describe('the connect budget — not rate limiting, a lockout defence', () => {
    // connect() memoises SUCCESS only: a rejected bind leaves nothing behind, so
    // without a budget every candidate in a batch re-runs the whole connect
    // path. A rotated service-account password then produces one rejected simple
    // bind PER CANDIDATE, in seconds, unattended, nightly — and domains commonly
    // lock out at five.
    it('stops after three failed binds instead of one per candidate', async () => {
        const fake = fakeAd({ bindRejects: new Error('49 - invalid credentials') });
        const writer = makeWriter(fake);

        for (let i = 0; i < 50; i += 1) {
            await writer.readState(GUID).catch(() => undefined);
        }

        expect(fake.binds.length).toBe(3);
    });

    it('says the failure is the CONNECTION, not the account', async () => {
        const fake = fakeAd({ bindRejects: new Error('49 - invalid credentials') });
        const writer = makeWriter(fake);
        for (let i = 0; i < 3; i += 1) await writer.readState(GUID).catch(() => undefined);

        const err = await writer.readState(GUID).catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/failure of the CONNECTION, not of any one account/);
        // Quotes what actually failed. The same counter catches a blank baseDN,
        // and telling that operator their bind is being locked out would send
        // them to the wrong screen entirely.
        expect((err as Error).message).toContain('invalid credentials');
    });

    it('does not latch on a single blip that then recovers', async () => {
        let n = 0;
        const fake = fakeAd({
            bindRejectsUntil: () => (n++ < 2 ? new Error('transient') : null),
        });
        const writer = makeWriter(fake);

        await writer.readState(GUID).catch(() => undefined);
        await writer.readState(GUID).catch(() => undefined);
        await expect(writer.readState(GUID)).resolves.toBeDefined();
    });

    it('counts a failed RE-bind too — that path never goes through connect()', async () => {
        // session() re-binds directly when ldapts reports the socket was
        // re-established. Same credential, same lockout counter on the other
        // side — so a writer whose socket keeps dropping would otherwise spend
        // the whole budget invisibly, one bad password at a time, forever.
        let n = 0;
        const fake = fakeAd({
            isBound: () => false,
            bindRejectsUntil: () => (n++ === 0 ? null : new Error('49 - invalid credentials')),
        });
        const writer = makeWriter(fake);

        for (let i = 0; i < 10; i += 1) {
            await writer.readState(GUID).catch(() => undefined);
        }

        // One good bind, then three rejected ones, then the latch. Without the
        // re-bind accounting this climbs with every call.
        expect(fake.binds.length).toBe(4);
    });

    it('starts again after close() — the latch describes one connection', async () => {
        const fake = fakeAd({ bindRejects: new Error('49 - invalid credentials') });
        const writer = makeWriter(fake);
        for (let i = 0; i < 4; i += 1) await writer.readState(GUID).catch(() => undefined);
        expect(fake.binds.length).toBe(3);

        await writer.close();
        await writer.readState(GUID).catch(() => undefined);

        // By the next scheduled run a rotated credential may well be corrected.
        expect(fake.binds.length).toBe(4);
    });
});

describe('one connection, one domain controller — enforced rather than asserted', () => {
    const DC01 = { dnsHostName: 'dc01.corp.example.com' };
    const DC02 = { dnsHostName: 'dc02.corp.example.com' };

    it('confirms the DC on the socket it is about to write through, not the one recorded at bind time', async () => {
        // THE defect this suite exists for. `capturedFromDc` was copied from
        // `boundDc`, and the refusal then compared `capturedFromDc` against
        // `boundDc` — the same variable, so equal by construction. The check
        // existed, read convincingly, and could not fire: the only way to reach
        // it was to hand-forge a capture, which is what its original test did.
        //
        // Here the socket answers dc01 for the read and dc02 for the write, with
        // no reconnect signal at all — the case a client that cannot report
        // `isBound` leaves entirely to this check.
        const fake = fakeAd({ rootDseSequence: [DC01, DC02] });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        expect(state.priorState.capturedFromDc).toBe('dc01.corp.example.com');

        const err = await writer.disable(GUID, state).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DirectoryWriteError);
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/multi-master/);
        expect((err as Error).message).toContain('dc01.corp.example.com');
        expect((err as Error).message).toContain('dc02.corp.example.com');
        expect(fake.modifies).toEqual([]);
    });

    it('re-binds deliberately when ldapts reports the socket was re-established', async () => {
        // `autoRebind` is deliberately OFF — an auto-replayed bind would let a
        // write proceed silently on a socket to an unknown replica. The cost of
        // leaving it off is that after a transparent reconnect the session is
        // ANONYMOUS, so the modify comes back result 50 and the writer's own
        // copy for that code sends an operator to widen a delegation that was
        // never the problem. Re-binding here is what closes that.
        let reconnected = false;
        const fake = fakeAd({ rootDseSequence: [DC01], isBound: () => !reconnected });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        reconnected = true;

        await writer.disable(GUID, state);

        expect(fake.binds).toHaveLength(2);
        // Same DC either side, positively confirmed — so a reconnect is not by
        // itself a reason to refuse. Over-tightening here would fail a batch for
        // an idle-timeout the directory did not even notice.
        expect(fake.modifies).toHaveLength(1);
    });

    it('refuses when the re-established socket landed on a different replica', async () => {
        let reconnected = false;
        const fake = fakeAd({ rootDseSequence: [DC01, DC02], isBound: () => !reconnected });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        reconnected = true;

        const err = await writer.disable(GUID, state).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/multi-master/);
        expect(fake.modifies).toEqual([]);
    });

    it('refuses a reconnect it cannot place, rather than writing on no evidence at all', async () => {
        // A RootDSE that will not answer is tolerated on the READ — the capture
        // records null and says so, costing the change token its comparability.
        // Tolerating it HERE would mean writing with neither of the two pieces
        // of evidence that the read and the write share a domain controller.
        let reconnected = false;
        const fake = fakeAd({ rootDseThrows: true, isBound: () => !reconnected });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        expect(state.priorState.capturedFromDc).toBeNull();
        reconnected = true;

        const err = await writer.disable(GUID, state).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/could not be confirmed/);
        expect(fake.modifies).toEqual([]);
    });

    it('still writes on an unidentifiable DC when the connection never broke', async () => {
        // The other half of the previous test, and the reason it is worded as
        // "re-established AND unconfirmable" rather than just "unconfirmable".
        // A directory whose RootDSE is restricted is an ordinary deployment, not
        // a fault, and refusing every disable in it would be a regression
        // dressed as rigour.
        const fake = fakeAd({ rootDseThrows: true });
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        await writer.disable(GUID, state);

        expect(fake.modifies).toHaveLength(1);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// The refusal rails, one branch at a time.
//
// Everything above establishes that the happy path is a compare-and-swap and
// that a proven refusal is distinguishable from a lost response. What follows
// is the other half of a writer that disables accounts in someone else's
// directory: every path on which it must decline, and — just as load-bearing —
// the neighbouring paths on which it must NOT, because a writer that refuses
// everything stops offboarding for a whole customer just as silently as one
// that writes to the wrong object.
// ─────────────────────────────────────────────────────────────────────────────

describe('userAccountControl is read as an integer or not at all', () => {
    // Every decision this writer makes is a bit test on this one value,
    // including the one deciding whether the account is already disabled — the
    // guard that stops a second disable journalling "disabled" as the prior
    // state. A value that cannot be read as a non-negative integer is therefore
    // not something to coerce past, and each of these shapes arrives from a
    // real directory or a real LDAP client.
    it.each<[string, unknown]>([
        ['an empty string', ''],
        ['whitespace only', '   '],
        ['a non-numeric string', 'not-a-number'],
        ['a negative integer, which no UAC ever is', '-514'],
        ['an empty multi-value attribute', []],
    ])('refuses to disable an account whose UAC arrives as %s', async (_label, value) => {
        const fake = fakeAd({ entries: [userEntry({ userAccountControl: value })] });

        await expect(makeWriter(fake).readState(GUID)).rejects.toThrow(
            /no readable userAccountControl/,
        );
        // Refused at the capture, so nothing downstream ever sees a defaulted
        // integer to compare-and-swap against.
        expect(fake.modifies).toEqual([]);
    });

    it.each<[string, unknown]>([
        ['a single-element array, which is how ldapts returns most attributes', [String(ENABLED_UAC)]],
        ['a Buffer, which is how it returns anything it thinks is binary', Buffer.from(String(ENABLED_UAC))],
    ])('reads the stored integer when it arrives as %s', async (_label, value) => {
        const fake = fakeAd({ entries: [userEntry({ userAccountControl: value })] });
        const writer = makeWriter(fake);

        const state = await writer.readState(GUID);
        expect(state.enabled).toBe(true);
        expect(state.priorState.userAccountControl).toBe(ENABLED_UAC);

        // And the CAS comparand is that same integer, spelled decimal — not the
        // array or the Buffer it arrived in, which would match nothing on the
        // wire and turn every disable into a spurious result 16.
        await writer.disable(GUID, state);
        expect(fake.modifies[0].changes[0].values).toEqual([String(ENABLED_UAC)]);
    });
});

describe('the capture records an absent attribute as null, never as undefined', () => {
    it('nulls every optional attribute the directory did not return', async () => {
        // priorState is JSON-serialised into IdentityWriteJournal.priorStateJson.
        // `undefined` does not survive that round trip — the key vanishes — and a
        // restore reading a capture with no `uSNChanged` KEY cannot tell "this
        // writer never captured one" from "an older schema never had one".
        const fake = fakeAd({
            entries: [
                {
                    objectGUID: GUID_BYTES,
                    distinguishedName: DN,
                    userAccountControl: String(ENABLED_UAC),
                },
            ],
        });

        const prior = (await makeWriter(fake).readState(GUID)).priorState as unknown as AdPriorState;

        expect(prior.sAMAccountName).toBeNull();
        expect(prior.userPrincipalName).toBeNull();
        expect(prior.uSNChanged).toBeNull();
        expect(prior.whenChanged).toBeNull();
        expect(prior.adminCount).toBeNull();
        // Present as KEYS, so the round trip preserves the distinction.
        expect(Object.keys(JSON.parse(JSON.stringify(prior)))).toEqual(
            expect.arrayContaining(['sAMAccountName', 'uSNChanged', 'whenChanged', 'adminCount']),
        );
    });

    it('records an unparseable adminCount as null rather than NaN', async () => {
        // NaN serialises to `null` in JSON anyway, but it compares false against
        // everything on the way there — including the `=== 0` test that decides
        // whether an operator is told about AdminSDHolder.
        const fake = fakeAd({ entries: [userEntry({ adminCount: 'yes' })] });
        const prior = (await makeWriter(fake).readState(GUID)).priorState as unknown as AdPriorState;
        expect(prior.adminCount).toBeNull();
    });
});

describe('the DN a ModifyRequest would be addressed to', () => {
    it('falls back to a DN-shaped account id when the entry carried no distinguishedName', async () => {
        // `normalizeAdEntry` stores the DN as externalUserId whenever the raw
        // GUID bytes will not format, so a DN-shaped id is a real stored
        // identifier — and a directory that answers a base-scoped read without
        // echoing the DN back has still told us exactly where the object is.
        const fake = fakeAd({ entries: [userEntry({ distinguishedName: undefined })] });

        const state = await makeWriter(fake).readState(DN);

        expect(state.priorState.distinguishedName).toBe(DN);
    });

    it('refuses when neither the entry nor the id yields a DN, instead of writing nowhere', async () => {
        // A GUID id cannot stand in for a DN, and a ModifyRequest needs one.
        const fake = fakeAd({ entries: [userEntry({ distinguishedName: undefined })] });

        await expect(makeWriter(fake).readState(GUID)).rejects.toThrow(
            /no distinguishedName[\s\S]*nowhere to be addressed/,
        );
        expect(fake.modifies).toEqual([]);
    });
});

describe('an account the directory does not return', () => {
    it('says the account is gone and names the base DN it looked under', async () => {
        // The likeliest cause is not deletion but an object moved out of the
        // configured scope during offboarding — which looks identical from here
        // and has a completely different remedy.
        const fake = fakeAd({ entries: [] });

        const err = await makeWriter(fake).readState(GUID).catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/has no account matching/);
        expect((err as Error).message).toContain(CONNECTION.baseDN);
        expect((err as Error).message).toMatch(/Nothing was written/);
        expect(fake.modifies).toEqual([]);
    });

    it('refuses an empty account id without searching for it', async () => {
        const fake = fakeAd();

        await expect(makeWriter(fake).readState('   ')).rejects.toThrow(/empty account id/);
        expect(fake.searches.filter((s) => s.base !== '')).toEqual([]);
    });

    it('refuses an id that normalises to no DN components at all', async () => {
        // ',,,' is not a GUID, so it takes the DN branch — and a naive
        // containment test on an empty component list would find the base DN's
        // suffix in nothing and read as "contained".
        const fake = fakeAd();

        const err = await makeWriter(fake).readState(',,,').catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/does not lie beneath the base DN/);
        expect(fake.searches.filter((s) => s.base !== '')).toEqual([]);
    });

    it('reads an escaped comma inside a common name as one component, not two', async () => {
        // `CN=Bloggs\, Jo,OU=Staff,…` is THREE components. Written as a plain
        // TypeScript string literal `'\,'` is just a comma and the escape never
        // reaches the parser, so this spells it with String.raw — the backslash
        // has to survive into the DN for the walk to have anything to skip.
        const escapedDn = String.raw`CN=Bloggs\, Jo,OU=Staff,DC=corp,DC=example,DC=com`;
        expect(escapedDn).toContain('\\');
        const fake = fakeAd({ entries: [userEntry({ distinguishedName: escapedDn })] });

        const state = await makeWriter(fake).readState(escapedDn);

        expect(state.priorState.distinguishedName).toBe(escapedDn);
        expect(fake.searches.find((s) => s.base !== '')?.base).toBe(escapedDn);
    });

    it('refuses a DN whose last component is a dangling escape rather than normalising it away', async () => {
        // A trailing backslash escapes the end of the string. Fail-closed is the
        // only safe reading: the alternative is deciding, on a malformed DN,
        // that it probably meant the one that IS in scope.
        const fake = fakeAd();
        const dangling = `${DN}\\`;

        const err = await makeWriter(fake).readState(dangling).catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/does not lie beneath the base DN/);
        expect(fake.searches.filter((s) => s.base !== '')).toEqual([]);
    });
});

describe('a connection that was never configured never reaches the directory', () => {
    /**
     * A connection row with the key ABSENT, which is what the older ones are.
     * Blanking the value takes a different path through the same coercion, and
     * the absent one is the path a connection provisioned before this writer
     * existed actually takes.
     */
    function connectionWithout(key: string): Record<string, unknown> {
        const copy: Record<string, unknown> = { ...CONNECTION };
        delete copy[key];
        return copy;
    }

    it.each<[string, Record<string, unknown>, RegExp]>([
        ['no URL at all', connectionWithout('url'), /needs an LDAPS URL/],
        ['no base DN at all', connectionWithout('baseDN'), /needs a base DN/],
        ['a base DN of nothing but whitespace', { ...CONNECTION, baseDN: '  ' }, /needs a base DN/],
        ['no bind password at all', connectionWithout('bindPassword'), /needs bind credentials/],
        ['no bind DN at all', connectionWithout('bindDN'), /needs bind credentials/],
        [
            // The half-configured write bind is the dangerous one: falling back
            // to the read credential here would quietly attempt the write as the
            // account the setup guide asks operators to provision READ-ONLY, and
            // the result 50 that follows would send them to widen it.
            'a write bind DN with no write password',
            { ...CONNECTION, writeBindDN: 'CN=svc-write,DC=corp,DC=example,DC=com', writeBindPassword: '' },
            /needs bind credentials/,
        ],
    ])('refuses %s before a socket is opened or a credential offered', async (_label, connection, message) => {
        const fake = fakeAd();

        await expect(makeWriter(fake, connection).readState(GUID)).rejects.toThrow(message);
        expect(fake.clientsBuilt).toEqual([]);
        expect(fake.binds).toEqual([]);
    });

    it('latches after three config failures without ever spending a bind, and does not cry lockout', async () => {
        // The connect budget is one counter over two very different failures.
        // Telling an operator with a blank base DN that their bind is being
        // locked out sends them to the wrong screen entirely, so the refusal
        // quotes what actually failed instead of interpreting it.
        const fake = fakeAd();
        const writer = makeWriter(fake, { ...CONNECTION, baseDN: '' });

        for (let i = 0; i < 3; i += 1) await writer.readState(GUID).catch(() => undefined);
        const err = await writer.readState(GUID).catch((e: unknown) => e);

        expect((err as Error).message).toMatch(/failure of the CONNECTION, not of any one account/);
        expect((err as Error).message).toContain('needs a base DN');
        expect((err as Error).message).not.toMatch(/lock(ed)? ?out/i);
        expect(fake.binds).toEqual([]);
    });

    it('quotes a non-Error bind rejection rather than rendering it as [object Object]', async () => {
        const fake = fakeAd({ bindRejects: 'the directory hung up' });
        const writer = makeWriter(fake);

        for (let i = 0; i < 3; i += 1) await writer.readState(GUID).catch(() => undefined);
        const err = await writer.readState(GUID).catch((e: unknown) => e);

        expect((err as Error).message).toContain('the directory hung up');
    });

    it('opens ONE socket for two overlapping callers, not one each', async () => {
        // Two sockets to `ldaps://dc.corp.example.com` are two sockets to
        // possibly two different replicas — the exact split every later refusal
        // is defending against, arriving before any of them can look.
        const fake = fakeAd();
        const writer = makeWriter(fake);

        const [a, b] = await Promise.all([writer.readState(GUID), writer.readState(GUID)]);

        expect(a.enabled).toBe(true);
        expect(b.enabled).toBe(true);
        expect(fake.clientsBuilt).toHaveLength(1);
        expect(fake.binds).toHaveLength(1);
    });
});

describe('the provider factory the writer builds its client through', () => {
    it('defaults to the real Active Directory provider, whose ldaps:// gate still applies', async () => {
        // No provider injected — the production shape. The scheme check lives in
        // that factory precisely because it is the only way a client is built, so
        // a writer that quietly built its own would bind in clear text with the
        // service-account password on the wire.
        const writer = createActiveDirectoryWriter({
            connection: { ...CONNECTION, url: 'ldap://dc.corp.example.com:389' },
        });

        await expect(writer.readState(GUID)).rejects.toThrow(/ldaps:\/\//);
    });
});

describe('which DC answered, when the RootDSE is only partly forthcoming', () => {
    it('falls back to serverName when dnsHostName is not published', async () => {
        const fake = fakeAd({ rootDse: { serverName: 'CN=DC01,CN=Servers,CN=Site,DC=corp' } });

        const prior = (await makeWriter(fake).readState(GUID)).priorState as unknown as AdPriorState;

        expect(prior.capturedFromDc).toBe('CN=DC01,CN=Servers,CN=Site,DC=corp');
    });

    it.each<[string, Record<string, unknown> | null]>([
        ['the RootDSE names neither', {}],
        ['the RootDSE returns no entry at all', null],
    ])('records a null DC when %s, rather than a guess', async (_label, rootDse) => {
        const fake = fakeAd({ rootDse });

        const prior = (await makeWriter(fake).readState(GUID)).priorState as unknown as AdPriorState;

        // Null costs uSNChanged its comparability, and the capture says so
        // honestly instead of naming a DC nobody confirmed.
        expect(prior.capturedFromDc).toBeNull();
    });
});

describe('a capture this writer will not compare-and-swap against', () => {
    /** A genuine capture, then one field bent out of shape. */
    async function disableWithCapture(
        mutate: (prior: Record<string, unknown>) => Record<string, unknown>,
    ) {
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);
        const err = await writer
            .disable(GUID, { enabled: true, priorState: mutate({ ...state.priorState }) })
            .catch((e: unknown) => e);
        return { err, fake };
    }

    it.each<[string, (prior: Record<string, unknown>) => Record<string, unknown>]>([
        [
            // A capture from the Entra writer replayed against AD. The schema
            // tag alone is not enough: two providers could share one.
            'it was produced by a different provider',
            (p: Record<string, unknown>) => ({ ...p, provider: 'entra-id' }),
        ],
        [
            'the journalled userAccountControl is a string, not a number',
            (p: Record<string, unknown>) => ({ ...p, userAccountControl: String(ENABLED_UAC) }),
        ],
        [
            'the journalled userAccountControl is negative',
            (p: Record<string, unknown>) => ({ ...p, userAccountControl: -1 }),
        ],
        [
            'the journalled userAccountControl is beyond safe-integer precision',
            (p: Record<string, unknown>) => ({ ...p, userAccountControl: Number.MAX_SAFE_INTEGER + 2 }),
        ],
        [
            'the journalled DN is blank',
            (p: Record<string, unknown>) => ({ ...p, distinguishedName: '   ' }),
        ],
    ])('refuses, and sends nothing, when %s', async (_label, mutate) => {
        const { err, fake } = await disableWithCapture(mutate);

        expect(err).toBeInstanceOf(DirectoryWriteError);
        // Nothing was sent, so this is one of the few refusals that genuinely
        // proves the directory is unchanged.
        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/unconditional replace/);
        expect(fake.modifies).toEqual([]);
    });

    it('refuses when the orchestrator says the account was already disabled, even if the capture looks enabled', async () => {
        // `enabled` and the captured integer are two views of one read, so a
        // disagreement means one of them is stale — and the direction that
        // matters is the one where a second disable journals "disabled" as the
        // prior state, which a later restore would then restore TO.
        const fake = fakeAd();
        const writer = makeWriter(fake);
        const state = await writer.readState(GUID);

        const err = await writer
            .disable(GUID, { enabled: false, priorState: state.priorState })
            .catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/restore would restore TO/);
        expect(fake.modifies).toEqual([]);
    });
});

describe('a capture replayed onto a connection this process opened later', () => {
    const DC01 = { dnsHostName: 'dc01.corp.example.com' };

    it('writes when the new connection is positively answered by the same DC', async () => {
        // The same-socket test cannot pass here — the map that answers it is
        // per-writer and the capture came from a different one — so this is the
        // case the DC identity exists to rescue. Refusing it would strand every
        // capture the moment a batch reconnects.
        const fake = fakeAd();
        const captured = await makeWriter(fake).readState(GUID);
        expect(captured.priorState.capturedFromDc).toBe('dc01.corp.example.com');

        const second = makeWriter(fake);
        await second.disable(GUID, captured);

        expect(fake.clientsBuilt).toHaveLength(2);
        expect(fake.modifies).toHaveLength(1);
        expect(fake.modifies[0].changes[0].values).toEqual([String(ENABLED_UAC)]);
    });

    it('refuses when the capture names a DC and the new connection cannot, naming both sides', async () => {
        // The mirror of the case below, and the likelier one in the field: the
        // capture is perfectly good and it is the connection in hand that cannot
        // say who is answering it. Both refusals print the same sentence, so both
        // halves of it have to be right.
        const fake = fakeAd({ rootDseSequence: [DC01, null] });
        const captured = await makeWriter(fake).readState(GUID);
        expect(captured.priorState.capturedFromDc).toBe('dc01.corp.example.com');

        const second = makeWriter(fake);
        const err = await second.disable(GUID, captured).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/could not be confirmed/);
        expect((err as Error).message).toContain('capture from dc01.corp.example.com');
        expect((err as Error).message).toContain('now an unidentified DC');
        expect(fake.modifies).toEqual([]);
    });

    it('refuses when the capture names no DC and the new connection does, naming both sides', async () => {
        // Neither piece of evidence is available: not the socket session (a
        // different writer), and not the DC identity (the capture has none). A
        // null DC is tolerable on the READ, where it only costs the change token
        // its comparability; tolerating it here would mean writing with nothing
        // at all tying the read and the write to one replica.
        const fake = fakeAd({ rootDseSequence: [null, DC01] });
        const captured = await makeWriter(fake).readState(GUID);
        expect(captured.priorState.capturedFromDc).toBeNull();

        const second = makeWriter(fake);
        const err = await second.disable(GUID, captured).catch((e: unknown) => e);

        expect((err as DirectoryWriteError).definitivelyNotApplied).toBe(true);
        expect((err as Error).message).toMatch(/could not be confirmed/);
        expect((err as Error).message).toContain('capture from an unidentified DC');
        expect((err as Error).message).toContain('now dc01.corp.example.com');
        expect(fake.modifies).toEqual([]);
    });
});

describe('the operator copy on a denial names the right runbook page', () => {
    async function disableFailingWith(
        thrown: unknown,
        entryOverrides: Record<string, unknown> = {},
        connection: Record<string, unknown> = CONNECTION,
    ) {
        const fake = fakeAd({ modifyThrows: thrown, entries: [userEntry(entryOverrides)] });
        const writer = makeWriter(fake, connection);
        const state = await writer.readState(GUID);
        return (await writer.disable(GUID, state).catch((e: unknown) => e)) as DirectoryWriteError;
    }

    it('does not blame the read-only enumeration account when a dedicated write bind was used', async () => {
        // The READ-ONLY note is a remedy: "configure writeBindDN". Printing it at
        // an operator who already did tells them to fix something that is
        // already fixed, and hides the real answer — the delegation on the OU.
        const err = await disableFailingWith(ldapError(50, 'insufficient access'), {}, {
            ...CONNECTION,
            writeBindDN: 'CN=svc-inflect-write,OU=Service,DC=corp,DC=example,DC=com',
            writeBindPassword: 'write-pw',
        });

        expect(err.message).toMatch(/Write permission on the userAccountControl property/);
        expect(err.message).not.toMatch(/READ-ONLY/);
        expect(err.message).not.toMatch(/no separate write bind/);
        expect(err.definitivelyNotApplied).toBe(true);
    });

    it('stays quiet about AdminSDHolder when the account explicitly carries adminCount=0', async () => {
        // adminCount=0 is an ordinary account that was once told about, not a
        // protected one. Naming SDProp here sends an operator to the AdminSDHolder
        // template for a plain missing delegation.
        const err = await disableFailingWith(ldapError(50, 'insufficient access'), { adminCount: '0' });

        expect(err.message).toMatch(/Write permission on the userAccountControl property/);
        expect(err.message).not.toMatch(/AdminSDHolder/);
    });

    it('says the objectGUID was not captured when a moved object cannot be re-resolved by one', async () => {
        // Result 32 means the DN is gone, and the remedy is to re-resolve by
        // GUID — which is exactly what a capture with a null objectGUID cannot
        // do. Printing "undefined" there reads as a bug in the tool rather than
        // as the fact it is.
        const fake = fakeAd({
            modifyThrows: ldapError(32, 'no such object'),
            entries: [userEntry({ objectGUID: undefined })],
        });
        const writer = makeWriter(fake);
        const state = await writer.readState(DN);
        expect((state.priorState as unknown as AdPriorState).objectGUID).toBeNull();

        const err = (await writer.disable(DN, state).catch((e: unknown) => e)) as DirectoryWriteError;

        expect(err.message).toMatch(/no longer exists at that DN/);
        expect(err.message).toContain('not captured');
        expect(err.definitivelyNotApplied).toBe(true);
    });

    it.each<[string, unknown]>([
        [
            // A DOMException that crossed a boundary and arrived as a plain
            // error keeps the name and the legacy numeric code but loses the
            // prototype — so the instanceof check cannot catch it, and the name
            // is all that is left standing between an aborted request and a
            // journal row that claims the directory is unchanged.
            'a plain error wearing a DOM name and a colliding legacy code',
            Object.assign(new Error('the request timed out'), { name: 'TimeoutError', code: 20 }),
        ],
        [
            'a non-integer numeric code, which no LDAP result is',
            Object.assign(new Error('odd'), { code: 16.5 }),
        ],
    ])('does not read %s as proof the directory was untouched', async (_label, thrown) => {
        const err = await disableFailingWith(thrown);

        expect(err.definitivelyNotApplied).toBe(false);
        expect(err.message).toMatch(/UNKNOWN/);
    });
});

describe('the bind identities the orchestrator must refuse to disable', () => {
    it('surfaces the read bind when that is the only credential configured', async () => {
        const fake = fakeAd();
        const ids = makeWriter(fake).selfAccountIds;
        expect(Array.from(new Set(ids))).toEqual([CONNECTION.bindDN]);
    });

    it('surfaces BOTH binds when a dedicated write credential is configured', async () => {
        // A dedicated write bind does not make the READ bind expendable: the
        // nightly sync authenticates as it, and disabling it lets every link go
        // stale until each later leaver pass refuses NO_FRESH_LINKS — offboarding
        // stops for everyone, quietly, and the account that did it looks like an
        // ordinary leaver in the report.
        const fake = fakeAd();
        const writeDn = 'CN=svc-inflect-write,OU=Service,DC=corp,DC=example,DC=com';

        const ids = makeWriter(fake, {
            ...CONNECTION,
            writeBindDN: writeDn,
            writeBindPassword: 'write-pw',
        }).selfAccountIds;

        expect(ids).toContain(writeDn);
        expect(ids).toContain(CONNECTION.bindDN);
    });

    it('lists nothing it was not given, rather than empty strings', async () => {
        // An empty entry here would be compared against every candidate's UPN and
        // objectGUID by the orchestrator's self-account guard, which is a
        // comparison that should never accidentally match.
        const fake = fakeAd();
        const bare: Record<string, unknown> = { ...CONNECTION };
        delete bare.bindDN;

        expect(makeWriter(fake, bare).selfAccountIds).toEqual([]);
    });
});
