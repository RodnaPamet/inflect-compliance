/**
 * The ingestion fault table.
 *
 * Every refusal here is a WHOLE-PULL refusal, and that is what these tests are
 * really about: a row this module cannot key unambiguously must not be skipped,
 * because an account missing from a snapshot is an account nobody reviews — while
 * the review reports that everything in scope was looked at.
 */
import {
    LegacyIngestError,
    assertNoSchemaDrift,
    mapRows,
    storableColumns,
} from '@/lib/legacy-access/ingest';
import {
    ACCOUNT_KEY_MAX_LENGTH,
    computeColumnSetFingerprint,
    type StoredMapping,
} from '@/lib/legacy-access/canonical';

const COLUMNS = ['LOGIN', 'EMAIL_ADDR', 'DISPLAY_NAME', 'STATUS', 'CREATED', 'ROLE_1', 'ROLE_2'];

const mapping = (over: Partial<StoredMapping> = {}): StoredMapping => ({
    version: 3,
    columnSetFingerprint: computeColumnSetFingerprint(COLUMNS),
    fields: {
        accountKey: 'LOGIN',
        email: 'EMAIL_ADDR',
        displayName: 'DISPLAY_NAME',
        status: 'STATUS',
        createdAt: 'CREATED',
    },
    entitlements: { kind: 'wide', columns: ['ROLE_1', 'ROLE_2'] },
    confirmedAt: '2026-10-09T00:00:00.000Z',
    confirmedByUserId: 'u1',
    ...over,
});

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    LOGIN: 'jsmith',
    EMAIL_ADDR: 'j.smith@corp.test',
    DISPLAY_NAME: 'John Smith',
    STATUS: 'A',
    CREATED: '2024-01-15T00:00:00.000Z',
    ROLE_1: 'reader',
    ROLE_2: '',
    ...over,
});

const refusalOf = (fn: () => unknown): LegacyIngestError => {
    try {
        fn();
    } catch (e) {
        if (e instanceof LegacyIngestError) return e;
        throw e;
    }
    throw new Error('expected a LegacyIngestError, nothing was thrown');
};

describe('the happy path', () => {
    it('maps a row to canonical fields and collects wide entitlements', () => {
        const out = mapRows(mapping(), [row()], COLUMNS);
        expect(out.accounts).toHaveLength(1);
        expect(out.accounts[0]).toMatchObject({
            accountKey: 'jsmith',
            email: 'j.smith@corp.test',
            displayName: 'John Smith',
            status: 'ACTIVE',
            entitlements: ['reader'],
        });
        // The blank ROLE_2 contributes nothing rather than an empty entitlement.
        expect(out.accounts[0].entitlements).toEqual(['reader']);
        expect(out.accounts[0].createdAt?.toISOString()).toBe('2024-01-15T00:00:00.000Z');
        expect(out.overshared).toEqual([]);
    });

    it('keeps NO unmapped column, even when the server sends it', () => {
        const extra = [...COLUMNS, 'COST_CENTRE'];
        const out = mapRows(
            { ...mapping(), columnSetFingerprint: computeColumnSetFingerprint(extra) },
            [row({ COST_CENTRE: '4412' })],
            extra
        );
        // The value appears nowhere on the canonical account — not under its own
        // name, not folded into another field, not in a blob.
        expect(JSON.stringify(out.accounts)).not.toContain('4412');
        expect(JSON.stringify(out.accounts)).not.toContain('COST_CENTRE');
        expect(out.overshared).toEqual(['COST_CENTRE']);
    });

    it('resolves a column whose CASE changed between pulls', () => {
        // Case is not a schema change; the fingerprint folds it, so lookup must too.
        const out = mapRows(mapping(), [{ login: 'jsmith', email_addr: 'a@b.test' }], COLUMNS);
        expect(out.accounts[0]).toMatchObject({ accountKey: 'jsmith', email: 'a@b.test' });
    });
});

describe('SCHEMA_DRIFT', () => {
    it('refuses when the observed column set differs from the mapping fingerprint', () => {
        const err = refusalOf(() => assertNoSchemaDrift(mapping(), [...COLUMNS, 'NEW_COL']));
        expect(err.refusal).toBe('SCHEMA_DRIFT');
        expect(err.detail).toContain('re-confirm the mapping');
    });

    it('does NOT refuse for reordered or re-cased columns', () => {
        expect(() => assertNoSchemaDrift(mapping(), [...COLUMNS].reverse())).not.toThrow();
        expect(() => assertNoSchemaDrift(mapping(), COLUMNS.map((c) => c.toLowerCase())))
            .not.toThrow();
    });

    it('refuses a RENAMED column — the drift a best-effort remap would get wrong', () => {
        const renamed = COLUMNS.map((c) => (c === 'EMAIL_ADDR' ? 'EMAIL_ADDRESS' : c));
        expect(() => assertNoSchemaDrift(mapping(), renamed)).toThrow(/SCHEMA_DRIFT/);
    });
});

describe('MISSING_ACCOUNT_KEY', () => {
    it('fails the whole pull rather than skipping the row', () => {
        const err = refusalOf(() =>
            mapRows(mapping(), [row(), row({ LOGIN: '' }), row({ LOGIN: 'c' })], COLUMNS)
        );
        expect(err.refusal).toBe('MISSING_ACCOUNT_KEY');
    });

    it('counts every unkeyable row, so the remedy is distinguishable from a typo', () => {
        // One is a typo in a mapping; four hundred is the wrong column. An
        // operator told only about the first row would fix the first row.
        const rows = [row({ LOGIN: '' }), row({ LOGIN: null }), row({ LOGIN: '  ' }), row()];
        const err = refusalOf(() => mapRows(mapping(), rows, COLUMNS));
        expect(err.detail).toContain('3 of 4 rows');
    });
});

describe('DUPLICATE_ACCOUNT_KEY and the long layout', () => {
    it('refuses a repeated key when the layout is not long', () => {
        const err = refusalOf(() => mapRows(mapping(), [row(), row()], COLUMNS));
        expect(err.refusal).toBe('DUPLICATE_ACCOUNT_KEY');
        expect(err.detail).toContain('not "long"');
    });

    it('ACCUMULATES entitlements across repeated keys when the layout IS long', () => {
        const long = mapping({ entitlements: { kind: 'long', column: 'ROLE_1' } });
        const out = mapRows(
            long,
            [row({ ROLE_1: 'reader' }), row({ ROLE_1: 'writer' }), row({ ROLE_1: 'admin' })],
            COLUMNS
        );
        expect(out.accounts).toHaveLength(1);
        expect([...out.accounts[0].entitlements].sort()).toEqual(['admin', 'reader', 'writer']);
    });

    it('tolerates an exactly-repeated long row — the rule is about contradiction', () => {
        const long = mapping({ entitlements: { kind: 'long', column: 'ROLE_1' } });
        const out = mapRows(long, [row({ ROLE_1: 'reader' }), row({ ROLE_1: 'reader' })], COLUMNS);
        expect(out.accounts[0].entitlements).toEqual(['reader']);
    });

    it('refuses CONTRADICTORY long rows about one account', () => {
        // A table contradicting itself about one person gives no reason to trust
        // what it says about the others — the same rule the roster side holds.
        const long = mapping({ entitlements: { kind: 'long', column: 'ROLE_1' } });
        const err = refusalOf(() =>
            mapRows(
                long,
                [row({ ROLE_1: 'reader' }), row({ ROLE_1: 'writer', EMAIL_ADDR: 'other@corp.test' })],
                COLUMNS
            )
        );
        expect(err.refusal).toBe('CONTRADICTORY_ROWS');
        expect(err.detail).toContain('email');
    });

    it('treats a null on one side as ABSENCE, not contradiction', () => {
        // A long layout's second row legitimately repeats only the key and role.
        const long = mapping({ entitlements: { kind: 'long', column: 'ROLE_1' } });
        const out = mapRows(
            long,
            [row({ ROLE_1: 'reader' }), { LOGIN: 'jsmith', ROLE_1: 'writer' }],
            COLUMNS
        );
        expect(out.accounts).toHaveLength(1);
        expect([...out.accounts[0].entitlements].sort()).toEqual(['reader', 'writer']);
    });
});

describe('AMBIGUOUS_COLUMN_CASE', () => {
    it('refuses a row carrying two columns that differ only by case', () => {
        // The contract already refuses EXACT duplicate column names; this is the
        // case-insensitive collision it cannot see, and resolving it silently
        // would pick whichever key Object.entries reached last.
        const err = refusalOf(() =>
            mapRows(mapping(), [{ LOGIN: 'a', login: 'b', EMAIL_ADDR: 'x@y.test' }], COLUMNS)
        );
        expect(err.refusal).toBe('AMBIGUOUS_COLUMN_CASE');
    });
});

describe('SECRET_SHAPED_VALUE', () => {
    it('refuses the pull when a mapped VALUE looks like a credential', () => {
        // The case the name-based denylist structurally cannot catch: a column
        // called DISPLAY_NAME holding a key, mapped in good faith.
        const err = refusalOf(() =>
            mapRows(
                mapping(),
                [row({ DISPLAY_NAME: 'AKIAIOSFODNN7EXAMPLE' })],  // pragma: allowlist secret -- the AWS docs example key, a synthetic input proving the egress scan fires
                COLUMNS
            )
        );
        expect(err.refusal).toBe('SECRET_SHAPED_VALUE');
    });

    it('names only the scanner RULE IDS, never the matched value', () => {
        const err = refusalOf(() =>
            mapRows(mapping(), [row({ DISPLAY_NAME: 'AKIAIOSFODNN7EXAMPLE' })], COLUMNS)  // pragma: allowlist secret -- the AWS docs example key, a synthetic input proving the egress scan fires
        );
        expect(err.detail).toContain('egr.api_key.aws_access_key');
        // The whole point: the thing that matched is by hypothesis a credential,
        // so it must not reach a log line, an audit row or an operator screen.
        expect(err.detail).not.toContain('AKIA');
        expect(err.message).not.toContain('AKIA');
    });

    it('does NOT refuse for a secret in a column the projection dropped', () => {
        // Dropping it is a complete remedy — nothing of that column is stored —
        // and refusing would let a misconfigured legacy server halt
        // recertification with data we correctly threw away.
        const extra = [...COLUMNS, 'NOTES'];
        const out = mapRows(
            { ...mapping(), columnSetFingerprint: computeColumnSetFingerprint(extra) },
            [row({ NOTES: 'AKIAIOSFODNN7EXAMPLE' })],  // pragma: allowlist secret -- the AWS docs example key, a synthetic input proving the egress scan fires
            extra
        );
        expect(out.accounts).toHaveLength(1);
        expect(JSON.stringify(out.accounts)).not.toContain('AKIA');
        expect(out.overshared).toEqual(['NOTES']);
    });
});

describe('oversharing', () => {
    it('a manifest declaring MORE columns than the projection is NOT oversharing', () => {
        // The regression this test exists for. A manifest declares the whole
        // table and a mapping deliberately names a subset, so
        // manifest-minus-projection is non-empty for every realistic mapping. An
        // earlier version computed oversharing that way and would have put a
        // permanent OVERSHARING banner, listing thirty columns, on every
        // connection — the same defect as a flag that never clears.
        const wide = [...COLUMNS, 'COST_CENTRE', 'CREATED_BY', 'PASSWORD_HASH'];
        const out = mapRows(
            { ...mapping(), columnSetFingerprint: computeColumnSetFingerprint(wide) },
            [row()],
            wide
        );
        expect(out.overshared).toEqual([]);
    });

    it('a ROW carrying an unrequested column IS oversharing, and its value is dropped', () => {
        const out = mapRows(mapping(), [row({ COST_CENTRE: 'CC-4412' })], COLUMNS);
        expect(out.overshared).toEqual(['COST_CENTRE']);
        expect(JSON.stringify(out.accounts)).not.toContain('CC-4412');
        // Not fatal: dropping it is a complete remedy, and refusing would let a
        // misconfigured legacy server halt recertification.
        expect(out.accounts).toHaveLength(1);
    });

    it('reports the column name with the casing the server actually sent', () => {
        // An operator comparing this against their own schema needs the real name.
        const out = mapRows(mapping(), [row({ Cost_Centre: 'x' })], COLUMNS);
        expect(out.overshared).toEqual(['Cost_Centre']);
    });

    it('reports a DECLARED denylisted column separately, and not as a fault', () => {
        // We never requested it, so nothing of it was read. It is still worth
        // surfacing: a table carrying PASSWORD_HASH beside the access rows is
        // worth an operator knowing about.
        const wide = [...COLUMNS, 'PASSWORD_HASH', 'COST_CENTRE'];
        const out = mapRows(
            { ...mapping(), columnSetFingerprint: computeColumnSetFingerprint(wide) },
            [row()],
            wide
        );
        expect(out.declaredDenied).toEqual(['PASSWORD_HASH']);
        expect(out.overshared).toEqual([]);
        expect(out.accounts).toHaveLength(1);
    });

    it('a denylisted column arriving in a ROW is dropped and counted as oversharing', () => {
        const out = mapRows(mapping(), [row({ PASSWORD_HASH: 'x'.repeat(40) })], COLUMNS);
        expect(out.overshared).toEqual(['PASSWORD_HASH']);
        // The part that matters: it reaches no account.
        expect(JSON.stringify(out.accounts)).not.toContain('x'.repeat(40));
    });
});

describe('date coercion', () => {
    it('counts an unparseable date instead of refusing', () => {
        const out = mapRows(mapping(), [row({ CREATED: 'not a date' })], COLUMNS);
        expect(out.unparsedDates).toBe(1);
        expect(out.accounts[0].createdAt).toBeNull();
    });

    it('does not count an EMPTY date cell as unparseable', () => {
        // Absent is not malformed, and conflating them would make the number
        // useless on any table with optional dates.
        const out = mapRows(mapping(), [row({ CREATED: '' })], COLUMNS);
        expect(out.unparsedDates).toBe(0);
    });
});

describe('storableColumns', () => {
    it('is exactly the mapping projection, for the database-side check', () => {
        expect([...storableColumns(mapping())].sort())
            .toEqual(['CREATED', 'DISPLAY_NAME', 'EMAIL_ADDR', 'LOGIN', 'ROLE_1', 'ROLE_2', 'STATUS']);
    });
});

/**
 * The defensive branches, which were the least-tested part of this module
 * (#3795). Measured before these: 69.5% branch coverage, and the uncovered
 * third was disproportionately the fail-closed half — three of the paths below
 * carry a written safety argument in the source with nothing behind it.
 *
 * `ingest.ts` is the roadmap's untrusted-input boundary: it turns a customer's
 * arbitrary spreadsheet into canonical rows. Its refusals and its coercions are
 * where a bad cell either stops or quietly becomes a confident wrong answer.
 */
const WIDE_COLUMNS = [
    'LOGIN', 'EMAIL_ADDR', 'DISPLAY_NAME', 'STATUS', 'CREATED',
    'ROLE_1', 'ROLE_2', 'PRIV', 'KIND', 'ROLES_CSV',
];

const wideMapping = (over: Partial<StoredMapping> = {}): StoredMapping => ({
    version: 3,
    columnSetFingerprint: computeColumnSetFingerprint(WIDE_COLUMNS),
    fields: {
        accountKey: 'LOGIN',
        email: 'EMAIL_ADDR',
        displayName: 'DISPLAY_NAME',
        status: 'STATUS',
        createdAt: 'CREATED',
        isPrivileged: 'PRIV',
        accountType: 'KIND',
    },
    entitlements: { kind: 'wide', columns: ['ROLE_1', 'ROLE_2'] },
    confirmedAt: '2026-10-09T00:00:00.000Z',
    confirmedByUserId: 'u1',
    ...over,
});

const wideRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    LOGIN: 'jsmith',
    EMAIL_ADDR: 'j.smith@corp.test',
    DISPLAY_NAME: 'John Smith',
    STATUS: 'A',
    CREATED: '2024-01-15T00:00:00.000Z',
    ROLE_1: 'reader',
    ROLE_2: '',
    PRIV: 'false',
    KIND: 'HUMAN',
    ROLES_CSV: '',
    ...over,
});

describe('a non-scalar cell is DROPPED, never stringified (#3795)', () => {
    // The source's own argument: stringifying "would store a blob nobody
    // classified, which is the thing the canonical schema exists to prevent."
    it.each([
        ['an object', { nested: 'value' }],
        ['an array', ['a', 'b']],
    ])('drops %s in a scalar cell rather than serialising it', (_label, cell) => {
        const out = mapRows(wideMapping(), [wideRow({ DISPLAY_NAME: cell })], WIDE_COLUMNS);

        expect(out.accounts[0]!.displayName).toBeNull();
        // The failure this guards is not "wrong value" but "a blob in the
        // column": assert the serialisations specifically, because a `String()`
        // or a `JSON.stringify` would both satisfy a mere not-equal check.
        expect(out.accounts[0]!.displayName).not.toBe('[object Object]');
        expect(out.accounts[0]!.displayName).not.toBe(JSON.stringify(cell));
    });

    it('still stores a real scalar, so the drop is about SHAPE not emptiness', () => {
        // The negative control. A reader that dropped everything would pass
        // every assertion above.
        const out = mapRows(wideMapping(), [wideRow({ DISPLAY_NAME: 'Jane Doe' })], WIDE_COLUMNS);
        expect(out.accounts[0]!.displayName).toBe('Jane Doe');
    });
});

describe('an unrecognised boolean is NULL, not false (#3795)', () => {
    // The source's own argument: `isPrivileged` "gates whether an account is
    // treated as high-risk in a review, so an unrecognised value becoming a
    // confident `false` would quietly downgrade it."
    it.each([['maybe'], ['PRIVILEGED?'], ['2'], ['oui']])(
        'reads %s as null — unknown is not a denial',
        (word) => {
            const out = mapRows(wideMapping(), [wideRow({ PRIV: word })], WIDE_COLUMNS);
            expect(out.accounts[0]!.isPrivileged).toBeNull();
        },
    );

    it('distinguishes null from false, which is the whole point', () => {
        // Without this pair the test above passes on an implementation that
        // returns null for EVERYTHING, which would lose the real `false`.
        const yes = mapRows(wideMapping(), [wideRow({ PRIV: 'TRUE' })], WIDE_COLUMNS);
        const no = mapRows(wideMapping(), [wideRow({ PRIV: 'no' })], WIDE_COLUMNS);
        const unknown = mapRows(wideMapping(), [wideRow({ PRIV: 'maybe' })], WIDE_COLUMNS);

        expect(yes.accounts[0]!.isPrivileged).toBe(true);
        expect(no.accounts[0]!.isPrivileged).toBe(false);
        expect(unknown.accounts[0]!.isPrivileged).toBeNull();
    });

    it('a non-scalar in the boolean cell is null too, not truthy', () => {
        // An object is truthy in JavaScript, so a naive `Boolean(cell)` would
        // read it as PRIVILEGED — the inverse of the downgrade above and worse.
        const out = mapRows(wideMapping(), [wideRow({ PRIV: { a: 1 } })], WIDE_COLUMNS);
        expect(out.accounts[0]!.isPrivileged).toBeNull();
    });
});

describe('an unknown account-type word is UNKNOWN (#3795)', () => {
    it.each([['contractor'], ['robot'], ['']])('maps %s to UNKNOWN', (word) => {
        const out = mapRows(wideMapping(), [wideRow({ KIND: word })], WIDE_COLUMNS);
        expect(out.accounts[0]!.accountType).toBe('UNKNOWN');
    });

    it('still maps the words it knows, including the synonyms', () => {
        for (const [word, expected] of [
            ['USER', 'HUMAN'],
            ['svc', 'SERVICE'],
            ['service-account', 'SERVICE'],
            ['GENERIC', 'SHARED'],
            ['builtin', 'SYSTEM'],
        ] as const) {
            const out = mapRows(wideMapping(), [wideRow({ KIND: word })], WIDE_COLUMNS);
            expect({ word, type: out.accounts[0]!.accountType }).toEqual({ word, type: expected });
        }
    });
});

describe('the delimited entitlements layout (#3795)', () => {
    // Exercised in ZERO files before this: `git ls-files tests | xargs grep -l
    // "'delimited'"` returned nothing. One of three layouts the mapping
    // supports, and the only one no test reached.
    const delimited = (delimiter = ',') =>
        wideMapping({ entitlements: { kind: 'delimited', column: 'ROLES_CSV', delimiter } });

    it('splits on the delimiter and trims each segment', () => {
        const out = mapRows(delimited(), [wideRow({ ROLES_CSV: 'reader, writer ,admin' })], WIDE_COLUMNS);
        expect(out.accounts[0]!.entitlements).toEqual(['reader', 'writer', 'admin']);
    });

    it('drops empty segments, so a trailing delimiter adds nothing', () => {
        const out = mapRows(delimited(), [wideRow({ ROLES_CSV: 'reader,,writer,' })], WIDE_COLUMNS);
        // An empty-string entitlement is a grant nobody holds; it would show up
        // in a review as a blank row to certify.
        expect(out.accounts[0]!.entitlements).toEqual(['reader', 'writer']);
    });

    it('an absent or non-scalar cell yields no entitlements, not a crash', () => {
        for (const cell of ['', '   ', undefined, { a: 1 }, ['x']]) {
            const out = mapRows(delimited(), [wideRow({ ROLES_CSV: cell })], WIDE_COLUMNS);
            expect(out.accounts[0]!.entitlements).toEqual([]);
        }
    });

    it('honours a multi-character delimiter', () => {
        const out = mapRows(delimited(' | '), [wideRow({ ROLES_CSV: 'reader | writer' })], WIDE_COLUMNS);
        expect(out.accounts[0]!.entitlements).toEqual(['reader', 'writer']);
    });
});

describe('an unparsable date is counted, not guessed (#3795)', () => {
    it.each([
        ['an invalid Date object', new Date('not a date')],
        ['a non-scalar cell', { when: 'yesterday' }],
        ['an unparsable string', 'last Tuesday'],
    ])('reports %s as unparsed and stores null', (_label, cell) => {
        const out = mapRows(wideMapping(), [wideRow({ CREATED: cell })], WIDE_COLUMNS);
        expect(out.accounts[0]!.createdAt).toBeNull();
        expect(out.unparsedDates).toBeGreaterThan(0);
    });

    it('a valid date is parsed and counted as parsed', () => {
        // The denominator: without this, an implementation that called
        // everything unparsed would satisfy the cases above.
        const out = mapRows(wideMapping(), [wideRow()], WIDE_COLUMNS);
        expect(out.accounts[0]!.createdAt).toBeInstanceOf(Date);
        expect(out.unparsedDates).toBe(0);
    });
});

describe("the 'none' entitlements layout (#3795)", () => {
    it('yields no entitlements and does not read any column', () => {
        const out = mapRows(
            wideMapping({ entitlements: { kind: 'none' } }),
            [wideRow({ ROLE_1: 'reader', ROLES_CSV: 'writer' })],
            WIDE_COLUMNS,
        );
        // Both candidate columns carry a value; `none` must ignore them rather
        // than fall through to a default layout.
        expect(out.accounts[0]!.entitlements).toEqual([]);
    });
});

describe('ROW_SCHEMA_INVALID names the FIELD and never the value (#3795)', () => {
    // This throw is the last line of defence: a value that survived every
    // coercion above and still fails the canonical schema. Its comment says the
    // Zod issue MESSAGES can quote the received value, so only the PATHS are
    // used — which makes this a leak test as much as a coverage one. A snapshot
    // refusal is surfaced to an operator and written to a job row.
    const tooLong = 'k'.repeat(600);

    it('refuses an over-long account key, naming the field', () => {
        const err = refusalOf(() =>
            mapRows(wideMapping(), [wideRow({ LOGIN: tooLong })], WIDE_COLUMNS),
        );
        expect(err.refusal).toBe('ROW_SCHEMA_INVALID');
        expect(err.message).toContain('accountKey');
    });

    it('takes only Zod PATHS from the issue list, never Zod messages', () => {
        // This is the property the comment above the throw is actually about,
        // and it is narrower than "no values in the message". Zod issue
        // messages can quote the received value; the code takes `is.path` only.
        //
        // I first asserted the message carried no part of the value at all,
        // and that FAILED — deliberately so, as it turns out: the template is
        // `account "${accountKey}" has values …`, and all THREE of this
        // module's row-level refusals name the account the same way
        // (ROW_SCHEMA_INVALID, DUPLICATE_ACCOUNT_KEY, CONTRADICTORY_ROWS).
        // Naming the account is how an operator finds the row. Asserting my own
        // preference here would have encoded it as the codebase's rule.
        //
        // The unbounded interpolation that observation left open was filed as
        // #3800 and is now bounded — see the describe at the end of this file.
        const err = refusalOf(() =>
            mapRows(wideMapping(), [wideRow({ LOGIN: tooLong })], WIDE_COLUMNS),
        );
        // The path is present...
        expect(err.message).toContain('accountKey');
        // ...and Zod's own prose for a max-length failure is not.
        expect(err.message).not.toMatch(/too long|at most|expected string to contain/i);
    });

    it('refuses an over-long entitlement too, naming entitlements', () => {
        // A second path to the same throw, through the delimited layout, so the
        // test does not depend on one field's bound.
        const err = refusalOf(() =>
            mapRows(
                wideMapping({ entitlements: { kind: 'delimited', column: 'ROLES_CSV', delimiter: ',' } }),
                [wideRow({ ROLES_CSV: 'r'.repeat(600) })],
                WIDE_COLUMNS,
            ),
        );
        expect(err.refusal).toBe('ROW_SCHEMA_INVALID');
        expect(err.message).toContain('entitlements');
        expect(err.message).not.toContain('r'.repeat(40));
    });

    it('a row within the bounds does not throw, so the bound is the trigger', () => {
        // The negative control. An implementation that threw on every row would
        // satisfy all three assertions above.
        expect(() =>
            mapRows(wideMapping(), [wideRow({ LOGIN: 'k'.repeat(512) })], WIDE_COLUMNS),
        ).not.toThrow();
    });
});

describe('the account key quoted in a refusal is bounded (#3800)', () => {
    // `accountKey` is a cell from an untrusted upload, interpolated into a
    // message that is logged and shown to an operator. #3795 established that
    // naming the account is DELIBERATE in all three row-level refusals, so the
    // fix is a bound rather than a redaction.
    //
    // The bound is `ACCOUNT_KEY_MAX_LENGTH`, the canonical schema's own, which
    // is the load-bearing choice: `ROW_SCHEMA_INVALID` is thrown exactly when
    // that schema REJECTED the row, so its key never went through the bound.

    it('elides an over-long key, marks it, and gives the real length', () => {
        const err = refusalOf(() =>
            mapRows(wideMapping(), [wideRow({ LOGIN: 'k'.repeat(900) })], WIDE_COLUMNS),
        );
        expect(err.refusal).toBe('ROW_SCHEMA_INVALID');
        // Marked, not silent: a key that looks complete but is not sends the
        // operator hunting for an account their file does not contain.
        expect(err.message).toContain('truncated from 900 characters');
        // And bounded — the quoted run of the key stops at the schema's max.
        expect(err.message).toContain('k'.repeat(ACCOUNT_KEY_MAX_LENGTH));
        expect(err.message).not.toContain('k'.repeat(ACCOUNT_KEY_MAX_LENGTH + 1));
    });

    it('states the ORIGINAL length, not the truncated one', () => {
        // The failure this rules out is reporting the bound back as the length,
        // which would make every over-long key look identically 512 long.
        const err = refusalOf(() =>
            mapRows(wideMapping(), [wideRow({ LOGIN: 'k'.repeat(513) })], WIDE_COLUMNS),
        );
        expect(err.message).toContain('truncated from 513 characters');
        expect(err.message).not.toContain(`truncated from ${ACCOUNT_KEY_MAX_LENGTH} characters`);
    });

    it('leaves a key the schema would ACCEPT completely intact', () => {
        // The other half of tying the bound to the schema, and the reason this
        // is not an arbitrary number: a key at exactly the schema's maximum is
        // legitimate, so it must appear in full. The refusal here comes from a
        // different field, which is what lets a valid key reach the message.
        const key = 'k'.repeat(ACCOUNT_KEY_MAX_LENGTH);
        const err = refusalOf(() =>
            mapRows(
                wideMapping({
                    entitlements: { kind: 'delimited', column: 'ROLES_CSV', delimiter: ',' },
                }),
                [wideRow({ LOGIN: key, ROLES_CSV: 'r'.repeat(600) })],
                WIDE_COLUMNS,
            ),
        );
        expect(err.refusal).toBe('ROW_SCHEMA_INVALID');
        expect(err.message).toContain(`account "${key}"`);
        expect(err.message).not.toContain('truncated from');
    });

    it('bounds the two post-parse refusals by the same helper', () => {
        // DUPLICATE_ACCOUNT_KEY and CONTRADICTORY_ROWS are thrown after a
        // successful parse, so their key is already schema-bounded and no input
        // can make them elide. What is checkable is that they still name the
        // account — the behaviour #3795 found to be deliberate — so bounding
        // them did not quietly remove it. That they route through the helper at
        // all is held by `ingest-refusals-bound-the-account-key`.
        const dup = refusalOf(() =>
            mapRows(wideMapping(), [wideRow({ LOGIN: 'dup-1' }), wideRow({ LOGIN: 'dup-1' })], WIDE_COLUMNS),
        );
        expect(dup.refusal).toBe('DUPLICATE_ACCOUNT_KEY');
        expect(dup.message).toContain('account "dup-1"');

        const contra = refusalOf(() =>
            mapRows(
                wideMapping({ entitlements: { kind: 'long', column: 'ROLES_CSV' } }),
                [
                    wideRow({ LOGIN: 'dup-2', DISPLAY_NAME: 'Jane Doe' }),
                    wideRow({ LOGIN: 'dup-2', DISPLAY_NAME: 'Someone Else' }),
                ],
                WIDE_COLUMNS,
            ),
        );
        expect(contra.refusal).toBe('CONTRADICTORY_ROWS');
        expect(contra.message).toContain('account "dup-2"');
    });
});
