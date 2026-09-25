/**
 * The live AD provisioner (#2750): the order, the encodings, and the refusals.
 *
 * Every test here is about a property that is invisible if you only check
 * "did it succeed" — an account created ENABLED works fine until someone signs
 * into it with no entitlements.
 */

// The create sequence is journalled before every step. Mocked so the four
// failure tests below can assert WHICH settle verb each failure earns —
// `failed` (we know nothing changed) and `indeterminate` (we do not) are
// different files: the restore path and the operator sweep both read the
// second, and neither reads the first.
const settles: Array<{ action: string; settled: string }> = [];
jest.mock('@/app-layer/usecases/identity-write-journal', () => ({
    beginWrite: jest.fn(async (_ctx: unknown, input: { action: string }) => ({
        journalId: `j-${input.action}`,
        applied: jest.fn(async () => { settles.push({ action: input.action, settled: 'applied' }); }),
        failed: jest.fn(async () => { settles.push({ action: input.action, settled: 'failed' }); }),
        reverted: jest.fn(async () => { settles.push({ action: input.action, settled: 'reverted' }); }),
        indeterminate: jest.fn(async () => {
            settles.push({ action: input.action, settled: 'indeterminate' });
        }),
    })),
}));

import {
    AlreadyExistsError,
    ConstraintViolationError,
    InsufficientAccessError,
    UnwillingToPerformError,
} from 'ldapts';

import {
    createActiveDirectoryProvisioner,
    encodeUnicodePwd,
    escapeFilterValue,
    AD_COLLISION_NAMESPACES,
} from '@/app-layer/integrations/providers/active-directory/provisioner';
import { createDirectoryAccount } from '@/app-layer/usecases/identity-create-account';

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

interface FakeAdOptions {
    entries?: Array<Record<string, unknown>>;
    addThrows?: Error;
    searchThrows?: Error;
    /**
     * Keyed by the FIRST modification's attribute type, which is what makes
     * each of the three modify steps independently failable: `member` is the
     * group add, `unicodePwd` the credential, `userAccountControl` the enable.
     */
    modifyThrows?: Record<string, Error>;
}

function fakeAd(opts: FakeAdOptions = {}) {
    const adds: Recorded[] = [];
    const modifies: Recorded[] = [];
    const client = {
        isBound: true,
        bind: async () => {},
        unbind: async () => {},
        search: async () => {
            if (opts.searchThrows) throw opts.searchThrows;
            return {
                searchEntries:
                    opts.entries ?? [
                    {
                        distinguishedName: 'CN=New Person,OU=Employees,DC=corp,DC=example,DC=test',
                        objectGUID: GUID_BYTES,
                        // 514 = NORMAL_ACCOUNT | ACCOUNTDISABLE — exactly what
                        // `createBlockedAccount` writes, so it is what the
                        // enable's capture legitimately reads back (#2840).
                        userAccountControl: 514,
                    },
                ],
            };
        },
        add: async (dn: string, attributes: Record<string, unknown>) => {
            if (opts.addThrows) throw opts.addThrows;
            adds.push({ dn, attributes });
        },
        modify: async (dn: string, changes: unknown[]) => {
            const type = (changes[0] as { type?: string } | undefined)?.type ?? '';
            const boom = opts.modifyThrows?.[type];
            if (boom) throw boom;
            modifies.push({ dn, changes });
        },
    };
    const provider = {
        makeClient: async () => client,
    } as never;
    return { client, adds, modifies, provider };
}

const make = (f: ReturnType<typeof fakeAd>, over: Record<string, unknown> = {}) =>
    createActiveDirectoryProvisioner({
        // `joinerWritesEnabled` (#2841) is the CREATE opt-in, and it is
        // deliberately not on the connection form while `JOINER_MAX_MODE` is
        // `DRY_RUN` — so in production this constructor refuses for every
        // connection, and these tests set the key directly to reach the
        // behaviour they are about. That the refusal is real, and that the
        // leaver's grant does not substitute for it, is proved in
        // `active-directory-write-direction.test.ts`.
        connection: { joinerWritesEnabled: true, ...CONNECTION, ...over },
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

    it('a displayName cannot choose the OU — RFC 4514, not a comma replace', async () => {
        const f = fakeAd();
        // The payload: a TRAILING BACKSLASH before the comma the old code added.
        // Old behaviour was `.replace(/,/g, '\\,')`, which escaped the comma and
        // left the backslash alone, so `Mallory\` became `CN=Mallory\\,OU=...`
        // — `\\` is an escaped backslash, the comma goes live, and the RDN ends
        // exactly where the attacker wanted. Everything after it is their DN.
        const r = await make(f).createBlockedAccount({
            identifier: 'mallory@corp.example.test',
            displayName: 'Mallory\\',
            employeeId: 'emp-evil',
        });
        expect(r.kind).toBe('applied');
        const dn = f.adds[0].dn;

        // Split on commas that are NOT escaped. Everything after the first one
        // is the parent DN — which OU the account actually lands in.
        const parentOf = (d: string) => d.split(/(?<!\\)(?:\\\\)*,/).slice(1).join(',');

        // POSITIVE CONTROL: the exact DN the old `.replace(/,/g, '\\,')` emitted
        // for this displayName. It left the trailing backslash alone, so the
        // comma it wrote became an ESCAPED one — the CN value swallows
        // `OU=Employees` as text and the account is created one level up, in
        // the domain root. Nothing errors; it just lands somewhere nobody
        // delegated, outside the leaver pass's scope.
        //
        // Written as a LITERAL, not by re-running the old expression: CodeQL
        // flags that expression wherever it appears (js/incomplete-sanitization,
        // correctly — it is the bug), and a security dashboard carrying an
        // alert everyone knows to ignore is how real ones get ignored. The old
        // implementation is gone, so this string can never drift from it.
        const oldDn = `CN=Mallory\\,${CONNECTION.createOU}`;
        expect(parentOf(oldDn)).toBe('DC=corp,DC=example,DC=test');
        expect(parentOf(oldDn)).not.toBe(CONNECTION.createOU);

        // The fix: the backslash is escaped, so the separator stays a separator.
        expect(parentOf(dn)).toBe(CONNECTION.createOU);
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

    it('refuses a creation OU outside the connection base DN — #2843 finding 51, the create half', async () => {
        // `assignGroup` got this check; the create never had one. An account
        // created outside `baseDN` sits in a naming context nobody delegated
        // AND outside what the leaver pass is scoped to — so the pass that
        // provisions it could never be the pass that offboards it.
        const f = fakeAd();
        const r = await make(f, {
            createOU: 'OU=Contractors,DC=other,DC=example,DC=test',
        }).createBlockedAccount({
            identifier: 'a.new@corp.example.test',
            displayName: 'A New',
            employeeId: 'e-1',
        });

        expect(r.kind).toBe('refused');
        expect(r.kind === 'refused' && r.detail).toMatch(/not under this connection's base DN/i);
    });

    it('names the consequence, not just the rule', async () => {
        const f = fakeAd();
        const r = await make(f, {
            createOU: 'OU=Contractors,DC=other,DC=example,DC=test',
        }).createBlockedAccount({
            identifier: 'a.new@corp.example.test',
            displayName: 'A New',
            employeeId: 'e-1',
        });

        expect(r.kind === 'refused' && r.detail).toMatch(/never offboarded|cannot later find/i);
    });

    it('allows an OU that IS under the base DN — the control', async () => {
        // Without this, a check that refused every OU would satisfy both
        // assertions above and make creates impossible.
        const f = fakeAd();
        const r = await make(f, {
            createOU: 'OU=Employees,DC=corp,DC=example,DC=test',
        }).createBlockedAccount({
            identifier: 'a.new@corp.example.test',
            displayName: 'A New',
            employeeId: 'e-1',
        });

        expect(r.kind === 'refused' && /base DN/i.test(r.detail)).toBe(false);
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

    // ── #2840. This block replaced a test that asserted the DEFECT as the
    // contract: "enables by writing 512, the account back to a normal user".
    // Writing 512 is exactly what destroys every other flag on the account, so
    // the old test would have gone red on the fix and green on the bug.

    it('CLEARS the disable bit and preserves every other flag', async () => {
        // 0x10202 = NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD | ACCOUNTDISABLE.
        // The old unconditional replace returned 512 here, silently dropping
        // DONT_EXPIRE_PASSWORD — a password policy change nobody asked for and
        // nothing recorded.
        const f = fakeAd();
        const prior = 0x10202;
        await make(f).enableAccount(GUID, { userAccountControl: prior });
        const changes = f.modifies.at(-1)!.changes as Array<{ type: string; values: string[] }>;
        expect(changes[0]).toMatchObject({
            type: 'userAccountControl',
            values: [String(prior & ~0x2)],
        });
        // Said positively as well as by arithmetic: DONT_EXPIRE_PASSWORD survives.
        expect(Number(changes[0].values[0]) & 0x10000).toBe(0x10000);
        expect(Number(changes[0].values[0]) & 0x2).toBe(0);
    });

    it('REFUSES to enable without a captured prior state — no invented base value', async () => {
        // The whole point. An enable that defaults its base is the
        // unconditional replace wearing a read-modify-write's clothes.
        const f = fakeAd();
        const r = await make(f).enableAccount(GUID, {});
        expect(r.kind).toBe('refused');
        expect(r.detail).toMatch(/captured userAccountControl/i);
        expect(f.modifies).toHaveLength(0);
    });

    it('writes nothing when the account is already enabled', async () => {
        const f = fakeAd();
        const r = await make(f).enableAccount(GUID, { userAccountControl: 0x200 });
        expect(r.kind).toBe('applied');
        expect(f.modifies).toHaveLength(0);
    });

    it('captures userAccountControl so the journal holds the value the write uses', async () => {
        const f = fakeAd({
            entries: [
                {
                    distinguishedName: 'CN=New Person,OU=Employees,DC=corp,DC=example,DC=com',
                    userAccountControl: 514,
                },
            ],
        });
        const r = await make(f).readAccountState(GUID);
        expect(r.kind).toBe('read');
        expect(r.kind === 'read' && r.priorState).toEqual({ userAccountControl: 514 });
    });

    it('reports INDETERMINATE when userAccountControl cannot be read, never a default', async () => {
        // "We could not read it" must not collapse into a number. A capture
        // that guesses is one a later restore would write back as fact.
        const f = fakeAd({
            entries: [{ distinguishedName: 'CN=New Person,OU=Employees,DC=corp,DC=example,DC=com' }],
        });
        const r = await make(f).readAccountState(GUID);
        expect(r.kind).toBe('indeterminate');
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

    // ── #2843 finding 51. Every other DN in the provisioner comes from
    // `dnFor()`, a baseDN-scoped search, so it is contained by construction.
    // `groupId` arrives from the entitlement map and reached `c.modify()`
    // unchecked — which is precisely why the exception was easy to miss.

    it('REFUSES a group in another naming context, and writes nothing', async () => {
        const f = fakeAd();
        const r = await make(f).assignGroup(GUID, 'CN=Admins,OU=Groups,DC=other,DC=forest');
        expect(r.kind).toBe('refused');
        expect(r.detail).toMatch(/base DN/i);
        // The write must not have been attempted at all.
        expect(f.modifies).toHaveLength(0);
    });

    it('ADMITS the configuration partition — a documented limit of a suffix test', async () => {
        // I wrote this expecting a refusal and it is wrong to expect one.
        // `CN=Configuration,DC=corp,DC=example,DC=test` is a SEPARATE naming
        // context in AD, but textually it is a suffix of the domain DN, so a
        // containment test built on suffixes cannot tell the two apart — and
        // this one says it is a suffix test, deliberately, because AD compares
        // DN components case-insensitively and a real parse buys nothing here.
        //
        // Asserted rather than deleted so the boundary is recorded: this check
        // stops a group in ANOTHER FOREST OR DOMAIN, which is the reachable
        // case (the entitlement map is operator-supplied). It does not stop a
        // cross-partition DN inside the same domain. Excluding CN=Configuration
        // and CN=Schema by name would be a stronger claim than a suffix test
        // can honestly make, and the leaver writer accepts the same limit for
        // the account it disables.
        const f = fakeAd();
        const r = await make(f).assignGroup(
            GUID,
            'CN=Enterprise Admins,CN=Users,CN=Configuration,DC=corp,DC=example,DC=test',
        );
        expect(r.kind).toBe('applied');
    });

    it('accepts a contained group whose RDN carries an escaped comma', async () => {
        // The positive control: without it, a check that refused EVERYTHING
        // would satisfy both refusal tests above while breaking every real
        // assignment.
        //
        // It does NOT prove `splitDn`'s escaped-comma handling, and I first
        // wrote that it did. Replacing `splitDn` with a naive `split(',')`
        // leaves this green — the escape sits in the LEADING RDN, and the
        // suffix comparison only ever looks at the trailing components, so
        // mangling the head changes nothing about containment. The escape
        // handling is real and defensive, but it is not reachable through this
        // seam, and a comment claiming otherwise would be the kind of assertion
        // that reads as proof and is not.
        const f = fakeAd();
        const r = await make(f).assignGroup(
            GUID,
            'CN=Engineering\\, Platform,OU=Groups,DC=corp,DC=example,DC=test',
        );
        expect(r.kind).toBe('applied');
        expect(f.modifies).toHaveLength(1);
    });

    it('refuses the base DN itself — a naming context is not a group', async () => {
        const f = fakeAd();
        const r = await make(f).assignGroup(GUID, 'DC=corp,DC=example,DC=test');
        expect(r.kind).toBe('refused');
        expect(f.modifies).toHaveLength(0);
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

describe('AD provisioner — a probe that cannot look answers UNKNOWN, never free', () => {
    it('a directory the probe cannot reach yields unknown, naming both namespaces', async () => {
        // Not a hypothetical: a bind refusal, an unresolvable host or a dropped
        // socket all arrive here. Before #2750 the live arm was the ONE
        // implementation that could not honour the seam's own contract — it
        // threw, so a caller had to invent an answer, and the only answers on
        // offer were "free" (a create straight into a collision) and a crashed
        // pass.
        const f = fakeAd({ searchThrows: new Error('ECONNREFUSED 192.168.56.10:636') });
        const p = await make(f).probeIdentifier('new.person@corp.example.test');

        expect(p.kind).toBe('unknown');
        expect(p.kind).not.toBe('free');
        if (p.kind === 'unknown') {
            expect(p.namespacesUnavailable).toEqual([...AD_COLLISION_NAMESPACES]);
        }
    });
});

/**
 * THE FOUR STEPS, EACH FAILING ALONE, ON ERRORS ldapts ACTUALLY THROWS.
 *
 * `new Error('boom')` would exercise none of what matters here. A real
 * `ResultCodeError` carries a numeric `code`, and that number is the entire
 * basis for the one decision the caller cannot make for itself: did the
 * directory CHANGE? A result code inside a response means the DC parsed the
 * request and declined it — nothing was written. No result code at all means
 * the answer was lost, and the write may well have landed.
 *
 * So each test pairs a real error class with the `PARTIAL_*` state it must
 * produce AND the journal verb it must earn, because the two are not the same
 * assertion: every failure of step 2 is `PARTIAL_NO_GROUP` whether refused or
 * indeterminate, and only the journal distinguishes a row a human must chase
 * from one nobody needs to.
 */
describe('AD provisioner — each of the four steps fails independently', () => {
    const CTX = { tenantId: 't-1', userId: 'u-1' } as never;
    const GROUP = 'CN=Engineering,OU=Groups,DC=corp,DC=example,DC=test';
    const CANDIDATE = {
        identifier: 'new.person@corp.example.test',
        displayName: 'New Person',
        employeeId: 'emp-1',
    };

    function drive(f: ReturnType<typeof fakeAd>) {
        const disableCreated = jest.fn(async () => {});
        return {
            disableCreated,
            run: () =>
                createDirectoryAccount(CTX, {
                    provisioner: make(f),
                    candidate: CANDIDATE,
                    groupId: GROUP,
                    mode: 'AUTOMATIC',
                    disableCreated,
                }),
        };
    }

    const settledFor = (action: string) =>
        settles.filter((s) => s.action === action).map((s) => s.settled);

    beforeEach(() => {
        settles.length = 0;
    });

    it('all four land — and the account is BLOCKED from create until the LAST step', async () => {
        // The positive control for every failure below: without it, a sequence
        // that silently stopped after step 1 would satisfy several of them.
        const f = fakeAd();
        const { run, disableCreated } = drive(f);
        const outcome = await run();

        // No HRIS write-back is wired (#2716), which is the correct terminal
        // state for a complete create today.
        expect(outcome.kind).toBe('PARTIAL_NO_HRIS_WRITEBACK');
        expect(disableCreated).not.toHaveBeenCalled();

        // 514 at CREATE. An account created at 512 can be signed into before it
        // holds entitlements or a credential — the one ordering mistake the
        // whole sequence exists to prevent.
        expect(f.adds[0].attributes?.userAccountControl).toBe('514');

        // And the order is decision 3: group, then credential, then unblock.
        // The enable is LAST because every earlier partial then leaves the
        // person unable to sign in, which is the failure you want.
        const order = f.modifies.map((m) => (m.changes as Array<{ type: string }>)[0].type);
        expect(order).toEqual(['member', 'unicodePwd', 'userAccountControl']);
    });

    it('step 1 — InsufficientAccess (50) is REFUSED: nothing created, nothing to undo', async () => {
        const f = fakeAd({ addThrows: new InsufficientAccessError() });
        const { run, disableCreated } = drive(f);
        const outcome = await run();

        expect(outcome.kind).toBe('REFUSED');
        // A rollback here would disable an id we never created.
        expect(disableCreated).not.toHaveBeenCalled();
        expect(settledFor('CREATE_ACCOUNT')).toEqual(['failed']);
    });

    it('step 1 — AlreadyExists (68) is REFUSED: the race the probe cannot close', async () => {
        // The probe asked and the directory said free; between that answer and
        // the add, somebody else claimed the name. Reporting this as
        // INDETERMINATE — which this module did until #2750 — leaves a human to
        // establish by hand what the DC already stated plainly.
        const f = fakeAd({ addThrows: new AlreadyExistsError() });
        const outcome = await drive(f).run();

        expect(outcome.kind).toBe('REFUSED');
        expect(outcome.kind).not.toBe('INDETERMINATE');
    });

    it('step 1 — a lost response is INDETERMINATE, because an account may exist', async () => {
        // THE CONTROL FOR THE TWO ABOVE. A socket error carries a STRING code,
        // never an LDAP result, so nothing here can be read as proof the
        // directory was untouched. Retrying blindly makes a duplicate.
        const f = fakeAd({
            addThrows: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        });
        const { run, disableCreated } = drive(f);
        const outcome = await run();

        expect(outcome.kind).toBe('INDETERMINATE');
        expect(disableCreated).not.toHaveBeenCalled();
        expect(settledFor('CREATE_ACCOUNT')).toEqual(['indeterminate']);
    });

    it('step 2 — a refused group add leaves PARTIAL_NO_GROUP, rolled back', async () => {
        const f = fakeAd({ modifyThrows: { member: new InsufficientAccessError() } });
        const { run, disableCreated } = drive(f);
        const outcome = await run();

        expect(outcome.kind).toBe('PARTIAL_NO_GROUP');
        if (outcome.kind !== 'PARTIAL_NO_GROUP') throw new Error('narrowing');
        // The account exists and is sign-in blocked — the least useful account
        // possible and the safest. Rollback disables what we made.
        expect(outcome.rolledBack).toBe(true);
        expect(disableCreated).toHaveBeenCalledWith(GUID);
        expect(settledFor('ASSIGN_GROUP')).toEqual(['failed']);
    });

    it('step 2 — a LOST group add is the same state but a different journal row', async () => {
        // The discriminating pair. Both are PARTIAL_NO_GROUP, so the terminal
        // state alone cannot tell an operator whether the membership may have
        // landed. The journal verb is what does.
        const f = fakeAd({
            modifyThrows: { member: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
        });
        const outcome = await drive(f).run();

        expect(outcome.kind).toBe('PARTIAL_NO_GROUP');
        expect(settledFor('ASSIGN_GROUP')).toEqual(['indeterminate']);
    });

    it('step 3 — ConstraintViolation (19) on the password leaves PARTIAL_NO_CREDENTIAL', async () => {
        // What a domain password policy actually returns: the generated value
        // failed complexity or history. Declined, nothing written, and a
        // configuration problem rather than a mystery.
        const f = fakeAd({ modifyThrows: { unicodePwd: new ConstraintViolationError() } });
        const { run, disableCreated } = drive(f);
        const outcome = await run();

        expect(outcome.kind).toBe('PARTIAL_NO_CREDENTIAL');
        if (outcome.kind !== 'PARTIAL_NO_CREDENTIAL') throw new Error('narrowing');
        expect(outcome.rolledBack).toBe(true);
        // Step 2 had already landed, so this is an account that exists and is
        // entitled but that nobody can sign into.
        expect(settledFor('ASSIGN_GROUP')).toEqual(['applied']);
        expect(disableCreated).toHaveBeenCalledWith(GUID);
    });

    it('step 4 — UnwillingToPerform (53) on the enable is named as an ENABLE failure', async () => {
        const f = fakeAd({ modifyThrows: { userAccountControl: new UnwillingToPerformError() } });
        const outcome = await drive(f).run();

        expect(outcome.kind).toBe('PARTIAL_NO_CREDENTIAL');
        if (outcome.kind !== 'PARTIAL_NO_CREDENTIAL') throw new Error('narrowing');
        // Shares the terminal state with step 3 because the person likewise
        // cannot sign in — so the DETAIL has to say which half is missing, or
        // an operator reissues a credential that already exists.
        expect(outcome.detail).toContain('could not be enabled');
        expect(outcome.rolledBack).toBe(true);
    });

    it('a refusal reports the LDAP result code, so the remedy is nameable', async () => {
        const f = fakeAd({ modifyThrows: { member: new InsufficientAccessError() } });
        const outcome = await drive(f).run();

        if (outcome.kind !== 'PARTIAL_NO_GROUP') throw new Error('narrowing');
        // 50 is insufficientAccessRights: the write bind lacks the delegation.
        // Without the number an operator cannot tell it from a wrong group DN.
        expect(outcome.detail).toContain('LDAP result 50');
    });
});
