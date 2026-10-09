/**
 * The mapping suggestion engine.
 *
 * The load-bearing tests here are the `mayExposeValueSet` ones. That predicate
 * is the only thing standing between the mapping screen — the one surface an
 * operator sees BEFORE anybody has decided what the columns mean — and a
 * customer's data, so each of its conditions must block on its own.
 */
import {
    VALUE_SET_MAX_DISTINCT,
    VALUE_SET_MIN_REPETITION,
    VALUE_SET_MIN_ROWS,
    canonicalTargets,
    mayExposeValueSet,
    normaliseColumnName,
    suggestMapping,
    type ColumnProfile,
} from '@/lib/legacy-access/mapping-suggest';
import { CANONICAL_FIELDS } from '@/lib/legacy-access/canonical';

const profile = (over: Partial<ColumnProfile> & { name: string }): ColumnProfile => ({
    rowsSampled: 100,
    nonNullCount: 100,
    distinctCount: 100,
    emailShare: 0,
    dateShare: 0,
    integerShare: 0,
    booleanShare: 0,
    maxLength: 32,
    ...over,
});

const suggest = (p: ColumnProfile) => suggestMapping([p])[0];

describe('denied columns', () => {
    it.each(['PASSWORD', 'PWD', 'PASSWORD_HASH', 'CLIENT_SECRET', 'API_TOKEN', 'SSN', 'EGN', 'ЕГН', 'IBAN', 'CARD_NUMBER'])
    ('%s is unmappable and gets no target', (name) => {
        const s = suggest(profile({ name }));
        expect(s.denied).toBe(true);
        expect(s.suggested).toBeNull();
        expect(s.confidence).toBe(0);
    });

    it('a denied column is refused BEFORE any profile reasoning', () => {
        // Even a column whose statistics scream "email" stays unmappable.
        const s = suggest(profile({ name: 'SECRET_EMAIL', emailShare: 1 }));
        expect(s.denied).toBe(true);
        expect(s.suggested).toBeNull();
    });
});

describe('name synonyms', () => {
    it.each([
        ['LOGIN', 'accountKey'],
        ['SAMAccountName', 'accountKey'],
        ['EMP_NO', 'employeeNumber'],
        ['employeeId', 'employeeNumber'],
        ['EMAIL_ADDRESS', 'email'],
        ['userPrincipalName', 'email'],
        ['DISPLAY_NAME', 'displayName'],
        ['first_name', 'givenName'],
        ['SURNAME', 'familyName'],
        ['dept', 'department'],
        ['JOB_TITLE', 'title'],
        ['reports_to', 'managerRef'],
        ['ACCOUNT_STATUS', 'status'],
        ['last_logon', 'lastLoginAt'],
        ['WHEN_CREATED', 'createdAt'],
        ['ACCOUNT_EXPIRES', 'expiresAt'],
        ['is_admin', 'isPrivileged'],
        ['USER_TYPE', 'accountType'],
    ])('%s suggests %s', (name, expected) => {
        expect(suggest(profile({ name })).suggested).toBe(expected);
    });

    it('normalises separators and case, so one entry covers every spelling', () => {
        expect(normaliseColumnName('EMP_NO')).toBe('empno');
        expect(normaliseColumnName('emp no')).toBe('empno');
        expect(normaliseColumnName('emp-no')).toBe('empno');
        expect(normaliseColumnName('Emp.No')).toBe('empno');
    });

    it('prefers an EXACT synonym over a longer one containing it', () => {
        // `name` is an exact synonym of displayName and a substring of
        // `accountname`. Exact must win, or every short name resolves to whichever
        // field happens to list a superstring first.
        expect(suggest(profile({ name: 'NAME' })).suggested).toBe('displayName');
        expect(suggest(profile({ name: 'ACCOUNT_NAME' })).suggested).toBe('accountKey');
    });

    it('an unfamiliar name with unremarkable statistics suggests nothing', () => {
        // The common case. A forty-column table maps to seventeen fields at most.
        const s = suggest(profile({ name: 'ZZ_LEGACY_FLAG_7', distinctCount: 4, nonNullCount: 9 }));
        expect(s.suggested).toBeNull();
        expect(s.basis).toBeNull();
    });
});

describe('profile-only suggestions', () => {
    it('mostly-email values suggest email', () => {
        const s = suggest(profile({ name: 'COL_14', emailShare: 0.9 }));
        expect(s).toMatchObject({ suggested: 'email', basis: 'profile' });
    });

    it('mostly-date values suggest createdAt, the one that drives the temporal veto', () => {
        // Which date it is cannot be known from shape. Suggesting the
        // consequential one means a wrong guess is visible on the screen; a wrong
        // `lastLoginAt` looks like nothing.
        expect(suggest(profile({ name: 'COL_3', dateShare: 0.95 })).suggested).toBe('createdAt');
    });

    it('near-unique digits over a decent sample suggest employeeNumber', () => {
        const s = suggest(profile({ name: 'COL_9', integerShare: 1, nonNullCount: 80, distinctCount: 80 }));
        expect(s.suggested).toBe('employeeNumber');
    });

    it('does NOT suggest employeeNumber from a tiny sample, where everything is near-unique', () => {
        const s = suggest(profile({ name: 'COL_9', integerShare: 1, nonNullCount: 6, distinctCount: 6 }));
        expect(s.suggested).not.toBe('employeeNumber');
    });

    it('never suggests accountKey from shape alone', () => {
        // The primary key of the whole snapshot is not a thing to guess at. The
        // recoverable version of the same guess is `username`.
        const s = suggest(profile({ name: 'COL_1', nonNullCount: 90, distinctCount: 90, maxLength: 12 }));
        expect(s.suggested).toBe('username');
        expect(s.suggested).not.toBe('accountKey');
    });
});

describe('name and profile together', () => {
    it('agreement earns the highest confidence', () => {
        const s = suggest(profile({ name: 'EMAIL', emailShare: 1 }));
        expect(s.basis).toBe('name+profile');
        expect(s.confidence).toBeGreaterThan(0.9);
    });

    it('the NAME wins when they disagree, and the note says so', () => {
        // A column called EMAIL holding mostly nulls is still the email column.
        // Statistics describe the data; the name describes the intent.
        const s = suggest(profile({ name: 'EMAIL', emailShare: 0, dateShare: 0.9 }));
        expect(s.suggested).toBe('email');
        expect(s.basis).toBe('name');
        expect(s.note).toContain('createdAt');
        // And lower confidence than agreement, so the screen can sort it up.
        expect(s.confidence).toBeLessThan(0.9);
    });
});

describe('mayExposeValueSet — each condition blocks on its own', () => {
    const ok = { distinctCount: 4, nonNullCount: 100, emailShare: 0 };

    it('accepts a genuine vocabulary', () => {
        expect(mayExposeValueSet(ok)).toBe(true);
    });

    it('refuses too many distinct values', () => {
        expect(mayExposeValueSet({ ...ok, distinctCount: VALUE_SET_MAX_DISTINCT + 1 })).toBe(false);
    });

    it('refuses a sample too small for low cardinality to MEAN anything', () => {
        expect(mayExposeValueSet({ ...ok, nonNullCount: VALUE_SET_MIN_ROWS - 1 })).toBe(false);
    });

    it('refuses values that do not recur — a short list of different people', () => {
        // 20 rows, 10 distinct: each value appears twice, below the repetition
        // floor. This is the case that keeps a tiny tenant's name column out.
        expect(mayExposeValueSet({ distinctCount: 10, nonNullCount: 20, emailShare: 0 })).toBe(false);
        expect(VALUE_SET_MIN_REPETITION).toBe(4);
    });

    it('refuses anything that looks like an email, however low the cardinality', () => {
        expect(mayExposeValueSet({ ...ok, emailShare: 0.01 })).toBe(false);
    });

    it('refuses an empty column', () => {
        expect(mayExposeValueSet({ distinctCount: 0, nonNullCount: 0, emailShare: 0 })).toBe(false);
    });

    it('a high-cardinality identity column can NEVER qualify, at any sample size', () => {
        // The property that matters: names, emails and employee numbers are
        // high-cardinality by definition, so they fail the repetition test however
        // the sample is chosen.
        for (const n of [20, 100, 1000, 50_000]) {
            expect(mayExposeValueSet({ distinctCount: n, nonNullCount: n, emailShare: 0 })).toBe(false);
        }
    });
});

describe('a vocabulary column suggests status', () => {
    it('suggests status for a small recurring value set', () => {
        const s = suggest(profile({ name: 'COL_7', distinctCount: 3, nonNullCount: 100 }));
        expect(s.suggested).toBe('status');
    });

    it('never echoes a value set into the operator-facing note', () => {
        // `valueSet` is the one place a real value reaches this screen. The note is
        // free text an operator reads, so it must carry none of them.
        const values = ['A', 'I', 'LOCKD'];
        const s = suggest(profile({
            name: 'COL_7', distinctCount: 3, nonNullCount: 100, valueSet: values,
        }));
        for (const v of values) {
            expect(s.note).not.toContain(v);
        }
    });
});

describe('the target list', () => {
    it('offers exactly the canonical fields, no more', () => {
        expect([...canonicalTargets()].sort()).toEqual([...CANONICAL_FIELDS].sort());
    });
});
