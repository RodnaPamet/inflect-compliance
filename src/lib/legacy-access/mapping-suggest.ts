/**
 * Suggesting a mapping from column NAMES and column STATISTICS — never from
 * values.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SUGGESTIONS COME FROM INFLECT, DECISIONS COME FROM A PERSON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything here produces a SUGGESTION with a stated basis. Nothing here saves
 * anything, and {@link suggestMapping} deliberately returns no "accept all"
 * shape: an administrator confirms each column, because a mapping that names the
 * wrong column does not produce an error — it produces confident links between
 * the wrong people, and `email` and `employeeNumber` are two of the four signals
 * that can reach `LINKED` with nobody looking.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE CANNOT SEE A CELL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It takes {@link ColumnProfile}s, which carry counts and shares. That is not
 * squeamishness: the mapping screen is the one surface in this subsystem that an
 * operator looks at BEFORE anybody has decided what the columns mean, so it is
 * the one place a sensitive column could be rendered while still unclassified. A
 * module that never receives a value cannot leak one, however the UI evolves.
 *
 * The one exception is {@link ColumnProfile.valueSet}, and it is narrow by
 * construction — see that field's docblock. It exists because the status
 * value-map editor cannot ask somebody to map `A` onto `ACTIVE` without showing
 * them `A`.
 *
 * @module lib/legacy-access/mapping-suggest
 */

import {
    ACCESS_FIELDS,
    IDENTITY_FIELDS,
    STATUS_FIELDS,
    isDeniedColumn,
    type CanonicalFieldName,
} from './canonical';

// ─── What a profiler may report ────────────────────────────────────────────

/**
 * How many distinct values a column may have before its values stop being a
 * vocabulary and start being a sample of data.
 */
export const VALUE_SET_MAX_DISTINCT = 12;

/**
 * How many non-null values must have been seen before low cardinality MEANS
 * anything. Three rows are trivially low-cardinality.
 */
export const VALUE_SET_MIN_ROWS = 20;

/**
 * How often each value must recur. `distinct * 4 <= nonNull` means every value
 * appears four times on average — which is what separates a status vocabulary
 * from a short list of different people.
 */
export const VALUE_SET_MIN_REPETITION = 4;

export interface ColumnProfile {
    readonly name: string;
    /** Rows the profiler looked at. The denominator for every share below. */
    readonly rowsSampled: number;
    readonly nonNullCount: number;
    readonly distinctCount: number;
    /** Share of NON-NULL values that parse as an email address, in [0, 1]. */
    readonly emailShare: number;
    /** Share that parse as a date. */
    readonly dateShare: number;
    /** Share that are all digits. */
    readonly integerShare: number;
    /** Share that are a recognisable boolean spelling. */
    readonly booleanShare: number;
    readonly maxLength: number;
    /**
     * The column's distinct values — present ONLY when they are a vocabulary.
     *
     * This is the single place a real value reaches the mapping screen, and the
     * conditions are the safety property rather than a convenience:
     * `distinctCount <= VALUE_SET_MAX_DISTINCT`, `nonNullCount >=
     * VALUE_SET_MIN_ROWS`, every value recurring at least
     * `VALUE_SET_MIN_REPETITION` times on average, and no value that looks like
     * an email. Together those mean the column holds a small closed set each of
     * whose members describes MANY rows — `A`/`I`/`LOCKD`, `Y`/`N` — which is a
     * schema fact about the application, not data about a person.
     *
     * A name, an email or an employee number cannot satisfy them: those are
     * high-cardinality by definition, so they fail the repetition test however
     * small the sample. {@link mayExposeValueSet} is the predicate, and the
     * profiler is what must apply it — a caller that sets this field by hand is
     * bypassing the only thing standing between the mapping screen and a
     * customer's data.
     */
    readonly valueSet?: readonly string[];
}

/**
 * Whether a column's distinct values may be shown.
 *
 * Exported so the profiler and its test assert the SAME predicate, rather than
 * the test restating the conditions and both drifting.
 */
export function mayExposeValueSet(p: {
    readonly distinctCount: number;
    readonly nonNullCount: number;
    readonly emailShare: number;
}): boolean {
    if (p.distinctCount === 0) return false;
    if (p.distinctCount > VALUE_SET_MAX_DISTINCT) return false;
    if (p.nonNullCount < VALUE_SET_MIN_ROWS) return false;
    if (p.distinctCount * VALUE_SET_MIN_REPETITION > p.nonNullCount) return false;
    // Belt and braces. An email column is never a status vocabulary, and a
    // deployment with twenty rows and twelve shared mailboxes should not be the
    // case that disproves this module.
    if (p.emailShare > 0) return false;
    return true;
}

// ─── Name synonyms ─────────────────────────────────────────────────────────

/**
 * Column names seen in the wild, per canonical field.
 *
 * Matched on a NORMALISED form — lower-cased with separators removed — so
 * `EMP_NO`, `empNo` and `emp no` are one entry. Ordered most-specific first
 * within each field, and the fields themselves are tried in a fixed order so a
 * column matching two synonym sets resolves the same way every time.
 */
const SYNONYMS: ReadonlyArray<readonly [CanonicalFieldName, readonly string[]]> = [
    ['accountKey', ['accountkey', 'login', 'loginname', 'logonname', 'userid', 'usrid', 'uid', 'samaccountname', 'account', 'accountname', 'username']],
    ['employeeNumber', ['employeenumber', 'employeeid', 'empno', 'empid', 'personnelnumber', 'payrollid', 'badgeid', 'staffid', 'emplid']],
    ['email', ['email', 'emailaddress', 'mail', 'mailaddress', 'workemail', 'primaryemail', 'userprincipalname', 'upn']],
    ['username', ['username', 'login', 'loginid', 'shortname', 'alias', 'nickname', 'mailnickname']],
    ['displayName', ['displayname', 'fullname', 'name', 'commonname', 'cn', 'personname', 'employeename']],
    ['givenName', ['givenname', 'firstname', 'forename', 'fname']],
    ['familyName', ['familyname', 'lastname', 'surname', 'lname', 'sn']],
    ['department', ['department', 'dept', 'orgunit', 'ou', 'division', 'costcentre', 'costcenter', 'team']],
    ['title', ['title', 'jobtitle', 'position', 'role', 'jobrole', 'designation']],
    ['managerRef', ['manager', 'managerid', 'managername', 'supervisor', 'reportsto', 'managerupn', 'managermail']],
    ['status', ['status', 'accountstatus', 'state', 'active', 'isactive', 'enabled', 'isenabled', 'disabled', 'accountenabled', 'userstatus']],
    ['lastLoginAt', ['lastlogin', 'lastlogon', 'lastlogindate', 'lastlogontimestamp', 'lastsignin', 'lastaccess']],
    ['createdAt', ['created', 'createdat', 'createddate', 'createtime', 'whencreated', 'hiredate', 'startdate', 'accountcreated']],
    ['expiresAt', ['expires', 'expiresat', 'expirydate', 'expirationdate', 'accountexpires', 'validuntil', 'enddate', 'termdate']],
    ['isPrivileged', ['isprivileged', 'privileged', 'isadmin', 'admin', 'isadministrator', 'superuser', 'elevated']],
    ['accountType', ['accounttype', 'type', 'usertype', 'principaltype', 'category', 'accountclass']],
];

/** Normalise a column name for synonym lookup. */
export function normaliseColumnName(name: string): string {
    return name.trim().toLowerCase().replace(/[\s_\-.]+/g, '');
}

// ─── Suggestions ───────────────────────────────────────────────────────────

/** Why a suggestion was made. Shown beside it, because a basis is what makes it reviewable. */
export type SuggestionBasis =
    /** The column name matched a known synonym. */
    | 'name'
    /** The statistics fit the field's shape. */
    | 'profile'
    /** Both agreed, which is the only case worth a high confidence. */
    | 'name+profile';

export interface ColumnSuggestion {
    readonly column: string;
    /** Null when nothing fits — which is the common case for a forty-column table. */
    readonly suggested: CanonicalFieldName | null;
    readonly basis: SuggestionBasis | null;
    /** 0–1. Ordering only; nothing thresholds on it, because nothing auto-accepts. */
    readonly confidence: number;
    /**
     * Set when the column may not be mapped at all. The UI renders it as
     * unmappable rather than offering a target, and the save path refuses it
     * independently — this is a courtesy, not the enforcement.
     */
    readonly denied: boolean;
    /** One short operator-facing sentence. Never a value. */
    readonly note: string;
}

const ALL_FIELDS: readonly CanonicalFieldName[] = [
    ...IDENTITY_FIELDS, ...STATUS_FIELDS, ...ACCESS_FIELDS,
];

/**
 * Suggest a canonical target per column.
 *
 * Returns one entry per input profile, in input order, with no "best mapping"
 * and no accept-all. Two columns may be suggested for the same field — the UI
 * shows both and a person picks, because the alternative is this function
 * inventing a tie-break it has no basis for. `assertMappingUsable` is what
 * refuses the ambiguity if they pick both.
 */
export function suggestMapping(profiles: readonly ColumnProfile[]): readonly ColumnSuggestion[] {
    return profiles.map((p) => suggestOne(p));
}

function suggestOne(p: ColumnProfile): ColumnSuggestion {
    if (isDeniedColumn(p.name)) {
        return {
            column: p.name,
            suggested: null,
            basis: null,
            confidence: 0,
            denied: true,
            note: 'On the never-request denylist. It is not requested, not profiled and cannot be mapped.',
        };
    }

    const byName = synonymFor(p.name);
    const byProfile = profileFor(p);

    if (byName && byProfile === byName) {
        return {
            column: p.name, suggested: byName, basis: 'name+profile', confidence: 0.95, denied: false,
            note: `The name and the column's shape both fit ${byName}.`,
        };
    }
    if (byName) {
        // Name wins over a disagreeing profile, and says so. A column CALLED
        // `EMAIL` holding mostly nulls is still the email column; the statistics
        // describe the data, the name describes the intent.
        return {
            column: p.name, suggested: byName, basis: 'name', confidence: byProfile ? 0.6 : 0.75, denied: false,
            note: byProfile
                ? `The name fits ${byName}, but the column's shape looks more like ${byProfile}. Worth a look.`
                : `The name fits ${byName}.`,
        };
    }
    if (byProfile) {
        return {
            column: p.name, suggested: byProfile, basis: 'profile', confidence: 0.5, denied: false,
            note: `The name is unfamiliar, but the column's shape fits ${byProfile}.`,
        };
    }
    return {
        column: p.name, suggested: null, basis: null, confidence: 0, denied: false,
        note: 'No suggestion. Most columns in a legacy access table map to nothing, which is expected.',
    };
}

function synonymFor(name: string): CanonicalFieldName | null {
    const n = normaliseColumnName(name);
    if (!n) return null;
    // Exact synonym first, across every field, before any prefix reasoning —
    // otherwise `name` would match `accountname` by prefix and beat its own
    // exact entry under `displayName`.
    for (const [field, words] of SYNONYMS) {
        if (words.includes(n)) return field;
    }
    return null;
}

/**
 * A suggestion from the statistics alone.
 *
 * Ordered by how DISCRIMINATING the signal is, not by how common the field is.
 * An email share is nearly conclusive; a high distinct ratio only says "this
 * could be a key"; a small value set says "this could be a status". Each arm
 * states the threshold inline because the numbers are the whole argument.
 */
function profileFor(p: ColumnProfile): CanonicalFieldName | null {
    if (p.nonNullCount === 0) return null;

    // Mostly emails. Nothing else in the canonical schema looks like this.
    if (p.emailShare >= 0.8) return 'email';

    // A small closed vocabulary that recurs. `mayExposeValueSet` is the same
    // predicate the profiler used to decide it was safe to show, which is not a
    // coincidence: a column whose values are a vocabulary is a status candidate
    // for exactly the reason they were safe to show.
    if (mayExposeValueSet(p)) return 'status';

    // Mostly dates. Which date is a question the name answers, not the shape, so
    // this suggests the one that drives the temporal veto and lets a person move
    // it — a wrong `createdAt` is visible on the screen, where a wrong
    // `lastLoginAt` looks like nothing.
    if (p.dateShare >= 0.8) return 'createdAt';

    // Mostly booleans.
    if (p.booleanShare >= 0.8) return 'isPrivileged';

    // Near-unique digits across a decent sample: an employee number. Requires the
    // sample to be big enough that "near-unique" is an observation — in ten rows
    // every column is near-unique.
    if (p.integerShare >= 0.9 && p.nonNullCount >= VALUE_SET_MIN_ROWS
        && p.distinctCount / p.nonNullCount >= 0.95) {
        return 'employeeNumber';
    }

    // Near-unique short strings: a key candidate. Deliberately LAST and
    // deliberately not `accountKey` — suggesting the primary key from shape alone
    // would be this module guessing at the one field the whole snapshot is keyed
    // on. `username` is the recoverable version of the same guess.
    if (p.distinctCount / p.nonNullCount >= 0.98 && p.maxLength <= 64
        && p.nonNullCount >= VALUE_SET_MIN_ROWS) {
        return 'username';
    }

    return null;
}

/** Every canonical field, for the UI's target picker. */
export function canonicalTargets(): readonly CanonicalFieldName[] {
    return ALL_FIELDS;
}
