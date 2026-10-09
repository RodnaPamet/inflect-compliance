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
