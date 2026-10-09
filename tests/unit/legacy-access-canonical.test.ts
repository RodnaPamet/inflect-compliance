/**
 * The canonical schema, the mapping rules, the fingerprint and the payload hash.
 *
 * Behaviour, not shape: every test here asks what the module DOES with an input a
 * real legacy table could produce, and the denylist and hash tests in particular
 * are the ones that would go green-and-useless if somebody widened an assertion.
 */
import {
    CANONICAL_FIELDS,
    DENIED_COLUMN_PATTERN,
    IDENTITY_BEARING_FIELDS,
    LegacyMappingError,
    PAYLOAD_HASH_ALGORITHM_VERSION,
    assertMappingUsable,
    canonicaliseAccount,
    computeColumnSetFingerprint,
    computePayloadHash,
    createPayloadHasher,
    isDeniedColumn,
    mapStatusValue,
    projectedColumns,
    type CanonicalAccount,
    type StoredMapping,
} from '@/lib/legacy-access/canonical';

const baseMapping = (over: Partial<StoredMapping> = {}): StoredMapping => ({
    version: 1,
    columnSetFingerprint: 'a'.repeat(64),
    fields: { accountKey: 'LOGIN', email: 'EMAIL_ADDR' },
    entitlements: { kind: 'none' },
    confirmedAt: '2026-10-09T00:00:00.000Z',
    confirmedByUserId: 'u1',
    ...over,
});

const account = (over: Partial<CanonicalAccount> = {}): CanonicalAccount => ({
    accountKey: 'jsmith',
    username: null,
    displayName: null,
    givenName: null,
    familyName: null,
    email: null,
    employeeNumber: null,
    department: null,
    title: null,
    managerRef: null,
    status: 'ACTIVE',
    lastLoginAt: null,
    createdAt: null,
    expiresAt: null,
    entitlements: [],
    isPrivileged: null,
    accountType: 'HUMAN',
    ...over,
});

const problemsOf = (m: StoredMapping): readonly string[] => {
    try {
        assertMappingUsable(m);
        return [];
    } catch (e) {
        if (e instanceof LegacyMappingError) return e.problems;
        throw e;
    }
};

describe('canonical field set', () => {
    it('is sorted, which is what makes the hash key order a property of the constant', () => {
        expect([...CANONICAL_FIELDS]).toEqual([...CANONICAL_FIELDS].slice().sort());
    });

    it('does not count accountKey as identity-bearing, or the "at least one" rule is vacuous', () => {
        // If accountKey were in this set, every mapping that passes rule 1 would
        // pass rule 2 for free, and a key-only mapping — which reconciliation can
        // do nothing with — would be accepted.
        expect(IDENTITY_BEARING_FIELDS).not.toContain('accountKey');
    });
});

describe('column denylist', () => {
    // One case per alternative in the pattern, because a regex is exactly the
    // kind of thing that loses a branch in an edit nobody reviews closely.
    it.each([
        ['PASSWORD', true],
        ['USER_PASSWD', true],
        ['pwd', true],
        ['PASSWORD_HASH', true],
        ['pw_salt', true],
        ['CLIENT_SECRET', true],
        ['api_token', true],
        ['PIN_CODE', true],
        ['SSN', true],
        ['EGN', true],
        ['ЕГН', true],
        ['NATIONAL_ID', true],
        ['national id', true],
        ['IBAN', true],
        ['CARD_NUMBER', true],
        ['Password Expiry', true],
        // Not denied: the ordinary columns a mapping exists to name.
        ['LOGIN', false],
        ['EMAIL_ADDR', false],
        ['DISPLAY_NAME', false],
        ['EMP_NO', false],
        ['DEPT', false],
        ['ROLE_1', false],
    ])('%s → denied=%s', (column, denied) => {
        expect(isDeniedColumn(column)).toBe(denied);
    });

    it('matches the Cyrillic ЕГН by its own codepoints, not by looking like EGN', () => {
        // U+0415 U+0413 U+041D. A Latin-only pattern would miss it entirely, and a
        // Bulgarian deployment's legacy table is the expected case here.
        expect('ЕГН').not.toBe('EGN');
        expect([...'ЕГН'].map((c) => c.codePointAt(0))).toEqual([0x415, 0x413, 0x41d]);
        expect(DENIED_COLUMN_PATTERN.test('ЕГН')).toBe(true);
    });
});

describe('assertMappingUsable', () => {
    it('accepts a mapping that names a key and one identity-bearing field', () => {
        expect(problemsOf(baseMapping())).toEqual([]);
    });

    it('refuses a mapping with no accountKey', () => {
        const problems = problemsOf(baseMapping({ fields: { email: 'EMAIL_ADDR' } }));
        expect(problems.join(' ')).toContain('accountKey is not mapped');
    });

    it('refuses a key-only mapping — there is nothing to reconcile against', () => {
        const problems = problemsOf(baseMapping({ fields: { accountKey: 'LOGIN' } }));
        expect(problems.join(' ')).toContain('no identity-bearing field is mapped');
    });

    it('does not accept department or title as identity-bearing', () => {
        // Two people in the same department with the same title are not the same
        // person, so these are identity CONTEXT and must not satisfy the rule.
        const problems = problemsOf(
            baseMapping({ fields: { accountKey: 'LOGIN', department: 'DEPT', title: 'TITLE' } })
        );
        expect(problems.join(' ')).toContain('no identity-bearing field is mapped');
    });

    it('reports EVERY problem at once, not the first', () => {
        const problems = problemsOf(baseMapping({ fields: { department: 'PASSWORD' } }));
        // No key, no identity field, AND a denied column: three, in one response,
        // so an administrator is not made to rediscover the list by trial.
        expect(problems).toHaveLength(3);
    });

    it('refuses a denylisted column named by fields', () => {
        const problems = problemsOf(
            baseMapping({ fields: { accountKey: 'LOGIN', email: 'EMAIL_ADDR', title: 'PWD_EXPIRY' } })
        );
        expect(problems.join(' ')).toContain('never-request denylist');
    });

    it('refuses a denylisted column named by the ENTITLEMENT layout', () => {
        // A denied column reached through the entitlement layout is just as
        // requested as one reached through `fields` — the projection is built
        // from both.
        const problems = problemsOf(
            baseMapping({ entitlements: { kind: 'long', column: 'TOKEN_SCOPE' } })
        );
        expect(problems.join(' ')).toContain('entitlement column "TOKEN_SCOPE"');
    });

    it('refuses one column mapped to two canonical fields', () => {
        // Not a harmless alias: it makes two independent signals into one fact
        // counted twice, and email + employeeNumber are both STRONG.
        const problems = problemsOf(
            baseMapping({ fields: { accountKey: 'LOGIN', email: 'ID', employeeNumber: 'ID' } })
        );
        expect(problems.join(' ')).toContain('mapped to more than one canonical field');
        expect(problems.join(' ')).toContain('email, employeeNumber');
    });

    it('treats a blank column as absent, which is the likelier operator error', () => {
        const problems = problemsOf(baseMapping({ fields: { accountKey: '   ', email: 'E' } }));
        expect(problems.join(' ')).toContain('accountKey is not mapped');
    });
});

describe('projectedColumns', () => {
    it('is the union of field and entitlement columns, sorted and deduplicated', () => {
        const m = baseMapping({
            fields: { accountKey: 'LOGIN', email: 'EMAIL', displayName: 'NAME' },
            entitlements: { kind: 'wide', columns: ['ROLE_2', 'ROLE_1', 'NAME'] },
        });
        expect(projectedColumns(m)).toEqual(['EMAIL', 'LOGIN', 'NAME', 'ROLE_1', 'ROLE_2']);
    });

    it('never includes a column the mapping does not name', () => {
        expect(projectedColumns(baseMapping())).toEqual(['EMAIL_ADDR', 'LOGIN']);
    });
});

describe('computeColumnSetFingerprint', () => {
    it('ignores column ORDER — reordering is not a schema change', () => {
        expect(computeColumnSetFingerprint(['A', 'B', 'C']))
            .toBe(computeColumnSetFingerprint(['C', 'A', 'B']));
    });

    it('ignores CASE', () => {
        expect(computeColumnSetFingerprint(['Login', 'EMAIL']))
            .toBe(computeColumnSetFingerprint(['LOGIN', 'email']));
    });

    it('CHANGES when a column is added', () => {
        expect(computeColumnSetFingerprint(['A', 'B']))
            .not.toBe(computeColumnSetFingerprint(['A', 'B', 'C']));
    });

    it('CHANGES when a column is removed', () => {
        expect(computeColumnSetFingerprint(['A', 'B', 'C']))
            .not.toBe(computeColumnSetFingerprint(['A', 'B']));
    });

    it('CHANGES when a column is renamed — the dangerous drift', () => {
        // `EMP_NO` → `EMPLOYEE_ID` with something else inheriting the old name is
        // the case a positional remap would map onto the wrong canonical field.
        expect(computeColumnSetFingerprint(['LOGIN', 'EMP_NO']))
            .not.toBe(computeColumnSetFingerprint(['LOGIN', 'EMPLOYEE_ID']));
    });
});

describe('mapStatusValue', () => {
    it.each([
        ['A', 'ACTIVE'], ['Y', 'ACTIVE'], ['1', 'ACTIVE'], ['active', 'ACTIVE'],
        ['I', 'DISABLED'], ['N', 'DISABLED'], ['0', 'DISABLED'],
        ['LOCKD', 'LOCKED'], ['L', 'LOCKED'], ['suspended', 'LOCKED'],
        ['E', 'EXPIRED'], ['expired', 'EXPIRED'],
    ])('%s → %s', (raw, expected) => {
        expect(mapStatusValue(raw)).toBe(expected);
    });

    it('maps an UNRECOGNISED value to UNKNOWN, never to ACTIVE or DISABLED', () => {
        // The asymmetry matters. Read as ACTIVE it is campaign noise; read as
        // DISABLED it REMOVES a live account from the campaign, which is the
        // failure recertification exists to prevent. UNKNOWN reaches a human.
        expect(mapStatusValue('PENDING_REVIEW')).toBe('UNKNOWN');
        expect(mapStatusValue('')).toBe('UNKNOWN');
        expect(mapStatusValue(null)).toBe('UNKNOWN');
        expect(mapStatusValue(42)).toBe('UNKNOWN');
    });

    it('lets a per-connection override win over the default fold', () => {
        expect(mapStatusValue('A', { A: 'LOCKED' })).toBe('LOCKED');
    });
});

describe('payload hash', () => {
    it('is independent of the order accounts arrive in', () => {
        const a = account({ accountKey: 'aaa' });
        const b = account({ accountKey: 'bbb' });
        expect(computePayloadHash([a, b])).toBe(computePayloadHash([b, a]));
    });

    it('is independent of ENTITLEMENT order — they are a set', () => {
        const a = account({ entitlements: ['admin', 'reader'] });
        const b = account({ entitlements: ['reader', 'admin'] });
        expect(computePayloadHash([a])).toBe(computePayloadHash([b]));
    });

    it('CHANGES when any canonical value changes', () => {
        const base = computePayloadHash([account()]);
        expect(computePayloadHash([account({ email: 'j@x.test' })])).not.toBe(base);
        expect(computePayloadHash([account({ status: 'DISABLED' })])).not.toBe(base);
        expect(computePayloadHash([account({ entitlements: ['admin'] })])).not.toBe(base);
        expect(computePayloadHash([account({ accountType: 'SERVICE' })])).not.toBe(base);
        expect(computePayloadHash([account({ isPrivileged: true })])).not.toBe(base);
    });

    it('CHANGES when an account is added or removed', () => {
        const one = computePayloadHash([account({ accountKey: 'a' })]);
        const two = computePayloadHash([account({ accountKey: 'a' }), account({ accountKey: 'b' })]);
        expect(one).not.toBe(two);
    });

    it('treats a null field and an absent field identically', () => {
        // Required for recomputability: a stored NULL and a never-set field are
        // the same row read back, so they must hash the same.
        const withNull = computePayloadHash([account({ title: null })]);
        const withUndefined = computePayloadHash([account({ title: undefined as unknown as null })]);
        expect(withNull).toBe(withUndefined);
    });

    it('serialises a date as ISO with milliseconds, which is what a stored DateTime reads back as', () => {
        const d = new Date('2026-03-04T05:06:07.008Z');
        expect(canonicaliseAccount(account({ createdAt: d })))
            .toContain('"createdAt":"2026-03-04T05:06:07.008Z"');
    });

    it('emits keys in sorted order with accountKey first', () => {
        const json = canonicaliseAccount(account({ email: 'e', username: 'u' }));
        // `entitlements` is present because an empty ARRAY is not null — only
        // null and undefined are omitted. That distinction is load-bearing: an
        // account with no entitlements and an account whose entitlement column
        // was never mapped are different facts, and the first must still hash.
        expect(Object.keys(JSON.parse(json)))
            .toEqual(['accountKey', 'accountType', 'email', 'entitlements', 'status', 'username']);
    });

    it('omits null fields rather than emitting them', () => {
        const parsed = JSON.parse(canonicaliseAccount(account()));
        expect(parsed).not.toHaveProperty('email');
        expect(Object.keys(parsed).sort()).toEqual(['accountKey', 'accountType', 'entitlements', 'status']);
    });

    it('the incremental hasher agrees with the batch function', () => {
        // The two must never diverge: the verifier pages through the hasher and
        // compares against a value the pull produced with the batch form.
        const accounts = ['a', 'b', 'c'].map((k) => account({ accountKey: k, email: `${k}@x.test` }));
        const h = createPayloadHasher();
        for (const a of accounts) h.update(a);
        expect(h.digest()).toBe(computePayloadHash(accounts));
    });

    it('the incremental hasher REFUSES out-of-order accounts', () => {
        // A verifier paging in the wrong order would otherwise report a sound
        // snapshot as corrupt, which is the one failure mode a verification tool
        // must not have.
        const h = createPayloadHasher();
        h.update(account({ accountKey: 'bbb' }));
        expect(() => h.update(account({ accountKey: 'aaa' }))).toThrow(/ascending accountKey order/);
    });

    it('records an algorithm version, so a later canonicalisation fix cannot condemn old snapshots', () => {
        expect(PAYLOAD_HASH_ALGORITHM_VERSION).toBe(1);
    });
});
