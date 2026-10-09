/**
 * Applying a mapping to what the far end sent — and refusing, by name, when the
 * result would not be a snapshot anybody should review.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY REFUSAL HERE IS A WHOLE-PULL REFUSAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not a dropped row. A snapshot is a claim about a POPULATION — "these are the
 * accounts that exist in that application" — and a recertification campaign built
 * on it asks a human to confirm each one. An account silently absent from the
 * snapshot is an account nobody reviews, and the review will nonetheless report
 * that everything in scope was looked at. That is the exact shape of the failure
 * the subsystem exists to catch, so a row this module cannot key, or cannot
 * key unambiguously, fails the pull rather than being skipped.
 *
 * The one thing that is NOT a refusal is oversharing. A column we did not ask for
 * arriving anyway is the far end's bug, and dropping it is a complete remedy:
 * nothing of it reaches the database. Refusing would mean a misconfigured legacy
 * server could stop recertification entirely, which trades a real risk for a
 * worse one.
 *
 * @module lib/legacy-access/ingest
 */

import { scanEgress } from '@/app-layer/ai/guard';
import {
    CanonicalAccountSchema,
    computeColumnSetFingerprint,
    entitlementColumns,
    isDeniedColumn,
    mapStatusValue,
    projectedColumns,
    type AccountType,
    type CanonicalAccount,
    type StoredMapping,
} from './canonical';

/**
 * Why a pull did not produce a complete snapshot.
 *
 * A closed union, and it is what lands in `LegacyAccessSnapshot.refusalReason`.
 * Closed because the snapshot's reason is read by an operator surface that has to
 * say what to DO about each one — a free-text reason would make that surface a
 * list of sentences nobody can group.
 */
export const INGEST_REFUSALS = [
    'SCHEMA_DRIFT',
    'AMBIGUOUS_COLUMN_CASE',
    'MISSING_ACCOUNT_KEY',
    'DUPLICATE_ACCOUNT_KEY',
    'CONTRADICTORY_ROWS',
    'SECRET_SHAPED_VALUE',
    'ROW_SCHEMA_INVALID',
] as const;

export type IngestRefusal = (typeof INGEST_REFUSALS)[number];

export class LegacyIngestError extends Error {
    readonly refusal: IngestRefusal;
    /**
     * Operator-facing detail. NEVER a cell value.
     *
     * Column names, counts and account keys are allowed — a column name is schema
     * metadata the mapping UI already shows, and an account key is the thing a
     * reviewer will be asked about by name. A cell VALUE is the untrusted payload
     * this whole module exists to keep out of our logs and rows, and for
     * `SECRET_SHAPED_VALUE` the value is, by hypothesis, a credential.
     */
    readonly detail: string;

    constructor(refusal: IngestRefusal, detail: string) {
        super(`${refusal}: ${detail}`);
        this.name = 'LegacyIngestError';
        this.refusal = refusal;
        this.detail = detail;
    }
}

export interface IngestOutcome {
    readonly accounts: readonly CanonicalAccount[];
    /**
     * Columns present in the returned ROWS that the projection did not ask for.
     * Names only, no values — nothing of these columns is kept.
     *
     * Computed from the row keys, NOT from `manifest.columns`. The manifest
     * declares the whole table and the projection is deliberately a subset of it,
     * so a manifest-minus-projection difference is the normal case for every
     * mapping that does not name all forty columns — flagging it would put a
     * permanent OVERSHARING banner on every connection, which is the same defect
     * as a flag that never clears.
     *
     * **Normally EMPTY through the live transport**, and that is not this module
     * being careless. `lib/mcp/client` now STRIPS unrequested columns at the
     * socket and reports their names in `PullResult.overshared`, so the rows that
     * reach here carry none — the pull usecase reads the transport's list, which
     * is authoritative because it saw what was actually on the wire.
     *
     * This stays as the backstop for a caller holding rows from anywhere else,
     * and it is a real one: it is what would catch a future reader that bypassed
     * the client. #3319 records the policy history.
     */
    readonly overshared: readonly string[];
    /**
     * Denylisted columns the server DECLARES in its manifest, whether or not it
     * returned them.
     *
     * Not a subset of {@link overshared} and not an error: we never requested
     * them, so nothing of them was read. It is an operator signal worth
     * surfacing — a table carrying `PASSWORD_HASH` next to the access rows is
     * worth knowing about — and it is the one oversharing-adjacent fact that IS
     * observable on every real pull.
     */
    readonly declaredDenied: readonly string[];
    /**
     * How many date cells could not be parsed, across the whole population.
     *
     * Counted rather than refused. An unparseable `createdAt` yields null, which
     * disables the temporal veto for that account — and the veto only ever REMOVES
     * candidates, so losing it produces more suggestions for a human to look at
     * rather than fewer. That is the safe direction, but it is still a degradation,
     * and invariant 4 is "fail closed, and never SILENTLY" — so it is a number the
     * pull records, not a thing nobody finds out about.
     */
    readonly unparsedDates: number;
}

/**
 * Refuse a pull whose column set is not the one the mapping was confirmed against.
 *
 * Runs BEFORE any row is examined, and the pull stores no accounts when it throws.
 * The order matters: mapping a drifted table "as far as it goes" is how `EMP_NO`
 * renamed to `EMPLOYEE_ID` ends up mapped onto whatever else now answers to the
 * old name, and `employeeNumber` is one of the four signals that can produce a
 * `LINKED` without a human looking.
 */
export function assertNoSchemaDrift(
    mapping: StoredMapping,
    observedColumns: readonly string[]
): void {
    const observed = computeColumnSetFingerprint(observedColumns);
    if (observed !== mapping.columnSetFingerprint) {
        throw new LegacyIngestError(
            'SCHEMA_DRIFT',
            `mapping version ${mapping.version} was confirmed against column-set `
            + `${mapping.columnSetFingerprint.slice(0, 12)}…, the server now reports `
            + `${observed.slice(0, 12)}… — an administrator must re-confirm the mapping`
        );
    }
}

/**
 * A case-insensitive view of one row's cells.
 *
 * Case-insensitive because the fingerprint is: a server that upper-cases its
 * headers between pulls has not changed its schema, and a mapping that stopped
 * resolving for it would be a false drift alarm. The cost is that two columns
 * differing only by case become indistinguishable here — so that table is refused
 * rather than silently resolved to whichever one `Object.entries` reached last.
 */
function buildRowIndex(row: Record<string, unknown>): Map<string, unknown> {
    const index = new Map<string, unknown>();
    const collisions: string[] = [];
    for (const [key, value] of Object.entries(row)) {
        const norm = key.trim().toLowerCase();
        if (index.has(norm)) collisions.push(key);
        else index.set(norm, value);
    }
    if (collisions.length > 0) {
        throw new LegacyIngestError(
            'AMBIGUOUS_COLUMN_CASE',
            `columns differing only by case cannot be told apart: ${collisions.sort().join(', ')}`
        );
    }
    return index;
}

function readCell(index: Map<string, unknown>, column: string | undefined): unknown {
    if (!column) return undefined;
    return index.get(column.trim().toLowerCase());
}

function asText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        const t = value.trim();
        return t === '' ? null : t;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    // An object or array in a scalar cell is not a value this schema has a shape
    // for. Dropped rather than JSON-stringified: stringifying would store a blob
    // nobody classified, which is the thing the canonical schema exists to prevent.
    return null;
}

interface DateReadResult {
    readonly value: Date | null;
    readonly unparsed: boolean;
}

function asDate(value: unknown): DateReadResult {
    if (value === null || value === undefined || value === '') {
        return { value: null, unparsed: false };
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime())
            ? { value: null, unparsed: true }
            : { value, unparsed: false };
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
        return { value: null, unparsed: true };
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return { value: null, unparsed: true };
    return { value: parsed, unparsed: false };
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 't']);
const FALSY = new Set(['false', 'no', 'n', '0', 'f']);

function asBool(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    const text = asText(value);
    if (text === null) return null;
    const key = text.toLowerCase();
    if (TRUTHY.has(key)) return true;
    if (FALSY.has(key)) return false;
    // Unrecognised reads as null, not false. `isPrivileged` gates whether an
    // account is treated as high-risk in a review, so an unrecognised value
    // becoming a confident `false` would quietly downgrade it.
    return null;
}

const ACCOUNT_TYPE_WORDS: Readonly<Record<string, AccountType>> = {
    HUMAN: 'HUMAN', USER: 'HUMAN', PERSON: 'HUMAN', EMPLOYEE: 'HUMAN',
    SERVICE: 'SERVICE', SVC: 'SERVICE', SERVICE_ACCOUNT: 'SERVICE', APP: 'SERVICE',
    SHARED: 'SHARED', GENERIC: 'SHARED',
    SYSTEM: 'SYSTEM', BUILTIN: 'SYSTEM',
};

function asAccountType(value: unknown): AccountType {
    const text = asText(value);
    if (text === null) return 'UNKNOWN';
    return ACCOUNT_TYPE_WORDS[text.toUpperCase().replace(/[\s-]+/g, '_')] ?? 'UNKNOWN';
}

function readEntitlements(mapping: StoredMapping, index: Map<string, unknown>): string[] {
    const layout = mapping.entitlements;
    switch (layout.kind) {
        case 'none':
            return [];
        case 'wide': {
            const out: string[] = [];
            for (const column of layout.columns) {
                const text = asText(readCell(index, column));
                if (text !== null) out.push(text);
            }
            return out;
        }
        case 'long': {
            const text = asText(readCell(index, layout.column));
            return text === null ? [] : [text];
        }
        case 'delimited': {
            const text = asText(readCell(index, layout.column));
            if (text === null) return [];
            return text
                .split(layout.delimiter)
                .map((p) => p.trim())
                .filter((p) => p !== '');
        }
    }
}

/**
 * Apply a mapping to the rows the client returned.
 *
 * The order of the checks is the contract, and it is ordered by blast radius
 * rather than by cost:
 *
 *   1. **Schema drift** — the caller's job, before this is reached at all.
 *   2. **Oversharing** — computed, never fatal.
 *   3. **Per-row mapping**, with a missing key fatal to the whole pull.
 *   4. **Key collisions**, layout-aware.
 *   5. **The secret-shaped-value scan**, over what would be STORED.
 *
 * Five is last on purpose. It scans the MAPPED values, not everything the server
 * sent: a credential sitting in a column the projection dropped is a column whose
 * value never reaches the database, so refusing the pull for it would let a
 * misconfigured legacy server block recertification with data we correctly threw
 * away. What it does catch is the case the name-based denylist structurally
 * cannot — a column called `NOTES` holding an API key, mapped in good faith by an
 * operator with no way to know.
 */
export function mapRows(
    mapping: StoredMapping,
    rows: readonly Record<string, unknown>[],
    observedColumns: readonly string[]
): IngestOutcome {
    const projected = new Set(projectedColumns(mapping).map((c) => c.toLowerCase()));
    // What the server DECLARED that is denylisted. Observable on every pull, and
    // not a fault — we never asked for these.
    const declaredDenied = observedColumns.filter(isDeniedColumn).slice().sort();
    // Real oversharing is a ROW carrying a column the projection excluded. Built
    // below, from the row keys, as the rows are walked.
    const oversharedKeys = new Set<string>();

    const isLong = mapping.entitlements.kind === 'long';
    const byKey = new Map<string, CanonicalAccount>();
    const missingKeyRows: number[] = [];
    let unparsedDates = 0;

    for (let i = 0; i < rows.length; i += 1) {
        const index = buildRowIndex(rows[i]);
        // Iterated over the RAW keys, not the normalised index, so the reported
        // name is the one the server actually sent — an operator comparing this
        // against their own schema needs its real casing.
        for (const raw of Object.keys(rows[i])) {
            if (!projected.has(raw.trim().toLowerCase())) oversharedKeys.add(raw);
        }
        const accountKey = asText(readCell(index, mapping.fields.accountKey));
        if (accountKey === null) {
            // Collected rather than thrown on, so the refusal can say HOW MANY
            // rows were unkeyable. One is a typo in a mapping; four hundred is the
            // wrong column, and an operator told "row 3 has no account key" will
            // fix row 3.
            missingKeyRows.push(i);
            continue;
        }

        const entitlements = readEntitlements(mapping, index);
        const lastLogin = asDate(readCell(index, mapping.fields.lastLoginAt));
        const created = asDate(readCell(index, mapping.fields.createdAt));
        const expires = asDate(readCell(index, mapping.fields.expiresAt));
        if (lastLogin.unparsed) unparsedDates += 1;
        if (created.unparsed) unparsedDates += 1;
        if (expires.unparsed) unparsedDates += 1;

        const parsed = CanonicalAccountSchema.safeParse({
            accountKey,
            username: asText(readCell(index, mapping.fields.username)),
            displayName: asText(readCell(index, mapping.fields.displayName)),
            givenName: asText(readCell(index, mapping.fields.givenName)),
            familyName: asText(readCell(index, mapping.fields.familyName)),
            email: asText(readCell(index, mapping.fields.email)),
            employeeNumber: asText(readCell(index, mapping.fields.employeeNumber)),
            department: asText(readCell(index, mapping.fields.department)),
            title: asText(readCell(index, mapping.fields.title)),
            managerRef: asText(readCell(index, mapping.fields.managerRef)),
            status: mapStatusValue(readCell(index, mapping.fields.status), mapping.statusValues),
            lastLoginAt: lastLogin.value,
            createdAt: created.value,
            expiresAt: expires.value,
            entitlements,
            isPrivileged: asBool(readCell(index, mapping.fields.isPrivileged)),
            accountType: asAccountType(readCell(index, mapping.fields.accountType)),
        });
        if (!parsed.success) {
            // The Zod issue PATHS are field names and are safe; the issue
            // MESSAGES can quote the received value, so only the paths are used.
            const paths = [...new Set(parsed.error.issues.map((is) => is.path.join('.')))].sort();
            throw new LegacyIngestError(
                'ROW_SCHEMA_INVALID',
                `account "${accountKey}" has values the canonical schema refuses in: ${paths.join(', ')}`
            );
        }
        const account = parsed.data;

        const existing = byKey.get(accountKey);
        if (!existing) {
            byKey.set(accountKey, account);
            continue;
        }
        if (!isLong) {
            throw new LegacyIngestError(
                'DUPLICATE_ACCOUNT_KEY',
                `account "${accountKey}" appears more than once and the declared entitlement `
                + 'layout is not "long", so the repeat is not an extra entitlement row'
            );
        }
        // A long layout means one row PER ENTITLEMENT, so a repeated key is
        // expected and the entitlements accumulate. What is not expected is the
        // two rows disagreeing about the person: that is a table contradicting
        // itself, and it gives no reason to trust either answer. Same rule, and
        // the same reasoning, as `DuplicateRosterIdError` on the roster side — an
        // exactly-repeated row is tolerated, a contradicting one is refused.
        const disagreements = scalarDisagreements(existing, account);
        if (disagreements.length > 0) {
            throw new LegacyIngestError(
                'CONTRADICTORY_ROWS',
                `account "${accountKey}" appears on several rows that disagree about `
                + `${disagreements.join(', ')}`
            );
        }
        byKey.set(accountKey, {
            ...existing,
            entitlements: [...new Set([...existing.entitlements, ...account.entitlements])],
        });
    }

    if (missingKeyRows.length > 0) {
        throw new LegacyIngestError(
            'MISSING_ACCOUNT_KEY',
            `${missingKeyRows.length} of ${rows.length} rows have no value in the column mapped `
            + `to accountKey — an account that cannot be keyed is an account nobody reviews`
        );
    }

    const accounts = [...byKey.values()];

    const scan = scanEgress(accounts.map(forEgressScan));
    if (scan.verdict !== 'clean') {
        // `ruleIds` only. The scanner's own docblock says they carry no user
        // content, and the thing that matched is by hypothesis a credential.
        throw new LegacyIngestError(
            'SECRET_SHAPED_VALUE',
            `mapped values match secret patterns (${scan.ruleIds.sort().join(', ')}); `
            + 'nothing from this pull is stored. Re-map the offending column or '
            + 'exclude it at the source'
        );
    }

    return {
        accounts,
        overshared: [...oversharedKeys].sort(),
        declaredDenied,
        unparsedDates,
    };
}

/**
 * The scalar fields two rows about one account must agree on.
 *
 * `entitlements` is excluded because disagreeing about it is the whole point of a
 * long layout. Dates are compared by instant rather than by identity.
 */
function scalarDisagreements(a: CanonicalAccount, b: CanonicalAccount): string[] {
    const out: string[] = [];
    const check = (field: string, left: unknown, right: unknown): void => {
        const l = left instanceof Date ? left.getTime() : left;
        const r = right instanceof Date ? right.getTime() : right;
        // A null on one side is ABSENCE, not a contradiction: a long layout's
        // second row legitimately repeats only the key and the role.
        if (l === null || r === null || l === undefined || r === undefined) return;
        if (l !== r) out.push(field);
    };
    check('username', a.username, b.username);
    check('displayName', a.displayName, b.displayName);
    check('givenName', a.givenName, b.givenName);
    check('familyName', a.familyName, b.familyName);
    check('email', a.email, b.email);
    check('employeeNumber', a.employeeNumber, b.employeeNumber);
    check('department', a.department, b.department);
    check('title', a.title, b.title);
    check('managerRef', a.managerRef, b.managerRef);
    // `status` and `accountType` never arrive as null — an absent or
    // unrecognised cell folds to the enum's `UNKNOWN`, which MEANS "we could not
    // tell". So UNKNOWN is absence here, exactly like null, and comparing it as a
    // value made a legitimate long-layout table self-contradictory: a repeat row
    // carrying only the key and the role folds to UNKNOWN and would "disagree"
    // with the first row's ACTIVE. Caught by the absence test below, not by
    // reading this function.
    const known = (v: string): string | null => (v === 'UNKNOWN' ? null : v);
    check('status', known(a.status), known(b.status));
    check('lastLoginAt', a.lastLoginAt, b.lastLoginAt);
    check('createdAt', a.createdAt, b.createdAt);
    check('expiresAt', a.expiresAt, b.expiresAt);
    check('isPrivileged', a.isPrivileged, b.isPrivileged);
    check('accountType', known(a.accountType), known(b.accountType));
    return out.sort();
}

/**
 * What the egress scan sees.
 *
 * Dates and booleans are dropped: the scanner folds every string leaf into one
 * buffer and runs entropy rules over it, and an ISO timestamp contributes
 * characters that can only push a high-entropy rule towards a false positive
 * about a neighbouring cell. Only the fields that can carry free text are
 * offered — which is also every field a credential could hide in.
 */
function forEgressScan(account: CanonicalAccount): Record<string, unknown> {
    return {
        accountKey: account.accountKey,
        username: account.username,
        displayName: account.displayName,
        givenName: account.givenName,
        familyName: account.familyName,
        email: account.email,
        employeeNumber: account.employeeNumber,
        department: account.department,
        title: account.title,
        managerRef: account.managerRef,
        entitlements: account.entitlements,
    };
}

/** Every column the pull may legitimately store a value from. Used by the DB-side check. */
export function storableColumns(mapping: StoredMapping): readonly string[] {
    return [
        ...Object.values(mapping.fields).filter((c): c is string => typeof c === 'string'),
        ...entitlementColumns(mapping.entitlements),
    ];
}
