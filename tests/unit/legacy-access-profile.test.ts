/**
 * The column profiler: rows in, statistics out, rows discarded.
 *
 * The assertions that matter are the ones proving a VALUE cannot reach the
 * mapping screen except through the gated `valueSet`. This is the moment of
 * maximum exposure in the subsystem — the denylist only covers column NAMES, and
 * at profiling time nobody has classified anything else.
 */
import { computeColumnProfiles, type ColumnProfile } from '@/lib/legacy-access/profile';
import { VALUE_SET_MIN_ROWS } from '@/lib/legacy-access/mapping-suggest';

const rowsOf = (n: number, make: (i: number) => Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => make(i));

const byName = (profiles: readonly ColumnProfile[], name: string): ColumnProfile =>
    profiles.find((p) => p.name === name)!;

describe('statistics', () => {
    it('counts non-null, distinct and max length', () => {
        const rows = [
            { LOGIN: 'alice', NOTE: 'x' },
            { LOGIN: 'bob', NOTE: '' },
            { LOGIN: 'alice', NOTE: null },
            { LOGIN: '  ', NOTE: 'yy' },
        ];
        const [login, note] = [
            byName(computeColumnProfiles(rows, ['LOGIN', 'NOTE']), 'LOGIN'),
            byName(computeColumnProfiles(rows, ['LOGIN', 'NOTE']), 'NOTE'),
        ];
        // Blank and whitespace-only both read as absent, which is the same rule
        // the mapping applies — a mapping present but blank is the same failure as
        // an absent one.
        expect(login).toMatchObject({ rowsSampled: 4, nonNullCount: 3, distinctCount: 2 });
        expect(note).toMatchObject({ nonNullCount: 2, distinctCount: 2, maxLength: 2 });
    });

    it('computes shares over NON-NULL values, not over rows', () => {
        // A column that is 90% empty and 100% emails in what it has is an email
        // column. Dividing by rows would report 0.1 and suggest nothing.
        const rows = rowsOf(10, (i) => ({ E: i === 0 ? 'a@b.test' : null }));
        const p = byName(computeColumnProfiles(rows, ['E']), 'E');
        expect(p.nonNullCount).toBe(1);
        expect(p.emailShare).toBe(1);
    });

    it('a column in the manifest but absent from every row is profiled as EMPTY, not dropped', () => {
        // Deriving the column list from the rows would make an all-null column
        // vanish from the screen, so an administrator could not tell "empty" from
        // "not there".
        const p = computeColumnProfiles([{ A: '1' }], ['A', 'GHOST']);
        expect(p.map((x) => x.name)).toEqual(['A', 'GHOST']);
        expect(byName(p, 'GHOST')).toMatchObject({ nonNullCount: 0, distinctCount: 0, emailShare: 0 });
    });

    it('reads cells case-insensitively, as the fingerprint folds case', () => {
        const p = byName(computeColumnProfiles([{ login: 'a' }, { LOGIN: 'b' }], ['LOGIN']), 'LOGIN');
        expect(p.nonNullCount).toBe(2);
    });

    it('ignores a non-scalar cell rather than stringifying it', () => {
        // A blob on the mapping screen is the thing this module exists to prevent.
        const p = byName(computeColumnProfiles([{ A: { nested: 1 } }, { A: ['x'] }, { A: 'ok' }], ['A']), 'A');
        expect(p.nonNullCount).toBe(1);
        expect(p.distinctCount).toBe(1);
    });
});

describe('shape detection', () => {
    it('detects emails without counting a display name containing @', () => {
        const rows = [{ A: 'a@b.test' }, { A: 'Alice @ Ops' }, { A: 'c@d.test' }];
        expect(byName(computeColumnProfiles(rows, ['A']), 'A').emailShare).toBeCloseTo(2 / 3);
    });

    it('does NOT read a column of small integers as dates', () => {
        // `new Date('7')` is a valid date in V8. Without a pattern check first, a
        // column of small integers reads as 100% dates and gets suggested as
        // `createdAt` — the field that drives the temporal veto.
        const rows = rowsOf(30, (i) => ({ N: String(i % 9) }));
        const p = byName(computeColumnProfiles(rows, ['N']), 'N');
        expect(p.dateShare).toBe(0);
        expect(p.integerShare).toBe(1);
    });

    it('detects several real date spellings', () => {
        const rows = [
            { D: '2026-03-04' }, { D: '2026-03-04T05:06:07.008Z' },
            { D: '2026/03/04' }, { D: '04.03.2026' }, { D: 'not a date' },
        ];
        expect(byName(computeColumnProfiles(rows, ['D']), 'D').dateShare).toBeCloseTo(4 / 5);
    });

    it('detects boolean spellings', () => {
        const rows = [{ B: 'Y' }, { B: 'N' }, { B: 'true' }, { B: '1' }, { B: 'maybe' }];
        expect(byName(computeColumnProfiles(rows, ['B']), 'B').booleanShare).toBeCloseTo(4 / 5);
    });
});

describe('the denylist', () => {
    it.each(['PASSWORD', 'PWD', 'PASSWORD_HASH', 'API_TOKEN', 'SSN', 'EGN', 'ЕГН', 'IBAN', 'CARD_NUMBER'])
    ('%s is not profiled at all', (name) => {
        const rows = [{ [name]: 'sensitive-value-here' }, { LOGIN: 'a' }];
        const p = computeColumnProfiles(rows, [name, 'LOGIN']);
        expect(p.map((x) => x.name)).toEqual(['LOGIN']);
        // Not merely absent from the list — absent from the OUTPUT entirely.
        expect(JSON.stringify(p)).not.toContain('sensitive-value-here');
        expect(JSON.stringify(p)).not.toContain(name);
    });
});

describe('valueSet exposure — the only path a value takes to the screen', () => {
    it('exposes a genuine vocabulary', () => {
        // 100 rows, 3 values, each recurring ~33 times.
        const rows = rowsOf(100, (i) => ({ STATUS: ['A', 'I', 'LOCKD'][i % 3] }));
        const p = byName(computeColumnProfiles(rows, ['STATUS']), 'STATUS');
        expect(p.valueSet).toEqual(['A', 'I', 'LOCKD']);
    });

    it('does NOT expose an identity column, at any sample size', () => {
        // The property the whole gate exists for. High cardinality fails the
        // repetition floor however the sample is chosen.
        for (const n of [VALUE_SET_MIN_ROWS, 100, 1000]) {
            const rows = rowsOf(n, (i) => ({ NAME: `Person ${i}` }));
            expect(byName(computeColumnProfiles(rows, ['NAME']), 'NAME').valueSet).toBeUndefined();
        }
    });

    it('does NOT expose an email column even when a few mailboxes are shared', () => {
        // 40 rows, 4 shared addresses: low cardinality AND recurring, so only the
        // email veto keeps it out. This is the case that would otherwise put real
        // addresses on the mapping screen.
        const rows = rowsOf(40, (i) => ({ MAIL: `shared${i % 4}@corp.test` }));
        const p = byName(computeColumnProfiles(rows, ['MAIL']), 'MAIL');
        expect(p.distinctCount).toBe(4);
        expect(p.valueSet).toBeUndefined();
        expect(JSON.stringify(p)).not.toContain('@corp.test');
    });

    it('does NOT expose from a sample too small for low cardinality to mean anything', () => {
        const rows = rowsOf(VALUE_SET_MIN_ROWS - 1, (i) => ({ S: ['A', 'I'][i % 2] }));
        expect(byName(computeColumnProfiles(rows, ['S']), 'S').valueSet).toBeUndefined();
    });

    it('does NOT expose values that barely recur', () => {
        // 20 rows, 10 distinct — twice each, under the floor of four.
        const rows = rowsOf(20, (i) => ({ S: `v${i % 10}` }));
        expect(byName(computeColumnProfiles(rows, ['S']), 'S').valueSet).toBeUndefined();
    });

    it('no value reaches the output except through valueSet', () => {
        // The whole-module claim, asserted over a realistic wide page: identity
        // columns, a vocabulary column, and a free-text column together.
        const rows = rowsOf(60, (i) => ({
            LOGIN: `user${i}`,
            EMAIL: `user${i}@corp.test`,
            FULL_NAME: `Person Number ${i}`,
            NOTES: `free text about person ${i}`,
            STATUS: ['A', 'I'][i % 2],
        }));
        const p = computeColumnProfiles(rows, ['LOGIN', 'EMAIL', 'FULL_NAME', 'NOTES', 'STATUS']);
        const json = JSON.stringify(p);

        // The vocabulary IS present, by design.
        expect(byName(p, 'STATUS').valueSet).toEqual(['A', 'I']);
        // Nothing else is.
        expect(json).not.toContain('user0');
        expect(json).not.toContain('@corp.test');
        expect(json).not.toContain('Person Number');
        expect(json).not.toContain('free text');
    });
});
