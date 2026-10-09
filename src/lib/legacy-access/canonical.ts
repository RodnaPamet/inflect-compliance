/**
 * The canonical account schema — what Inflect keeps of a legacy access table, and
 * the mapping that gets it there.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A CANONICAL SCHEMA AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A legacy access table routinely carries forty columns: login name, three name
 * variants, cost centre, eight role slots, password expiry, the id of whoever
 * created the row. Recertification needs seventeen of those things and has no use
 * for the rest, so the rest is discarded AT THE BOUNDARY rather than stored and
 * ignored.
 *
 * That is a security decision before it is a tidiness one. A column nobody mapped
 * is a column nobody classified, and the retention policy, the encryption manifest
 * and the DSAR erasure path all range over columns somebody classified. A
 * `PASSWORD_HASH` sitting in a JSON blob is outside all three.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO LAYERS OF COLUMN DEFENCE, AND WHY NEITHER IS ENOUGH ALONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **The denylist is on NAMES, and runs when a mapping is saved.** An operator
 *    cannot map `PASSWD` onto `username`, so the column is never requested.
 * 2. **The egress scan is on VALUES, and runs at ingestion.** A column called
 *    `NOTES` carrying an API key is invisible to a name check, and the operator
 *    who mapped it had no way to know.
 *
 * They fail in opposite directions, which is the point. A name check cannot see
 * what a column holds; a value check cannot see a column it was never sent. And
 * the two have different remedies: a denied name is refused at save time with the
 * name in the message, where a secret-shaped value refuses the PULL and names
 * nothing, because the only thing it could name is the secret.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE FINGERPRINT IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A mapping is a promise about a table's shape: "the column called `LOGIN` holds
 * what I am calling `username`". If the far end renames, drops or reorders its
 * columns, that promise is void — and the dangerous case is not a missing column
 * (which fails loudly) but a RENAMED one, where `EMP_NO` becomes `EMPLOYEE_ID` and
 * some other column inherits the old name. A positional or best-effort remap would
 * then map a real column onto the wrong canonical field, and
 * `EMPLOYEE_NUMBER` is one of the four signals that can produce a `LINKED`.
 *
 * So the mapping records the fingerprint of the column set it was confirmed
 * against, and a pull whose fingerprint differs REFUSES. An administrator
 * re-confirms. There is no automatic re-mapping, by design.
 *
 * @module lib/legacy-access/canonical
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// ─── The canonical fields ──────────────────────────────────────────────────

/**
 * Identity fields. `accountKey` is the primary key of the snapshot and the only
 * unconditionally required field: a row that cannot be keyed cannot be reviewed,
 * and dropping it silently would hide an account from the one process that exists
 * to look at every account.
 */
export const IDENTITY_FIELDS = [
    'accountKey',
    'username',
    'displayName',
    'givenName',
    'familyName',
    'email',
    'employeeNumber',
    'department',
    'title',
    'managerRef',
] as const;

/**
 * Status fields. `createdAt` is here because it drives the temporal veto — an
 * account that did not exist when a person left cannot be that person's — so it is
 * load-bearing for correctness rather than merely informational.
 */
export const STATUS_FIELDS = ['status', 'lastLoginAt', 'createdAt', 'expiresAt'] as const;

/** Access fields. `entitlements` is a set; the other two are scalars. */
export const ACCESS_FIELDS = ['entitlements', 'isPrivileged', 'accountType'] as const;

/**
 * Every canonical field, SORTED. The sort is not cosmetic: it is what makes
 * "canonical form, sorted keys" in the payload hash a property of this constant
 * rather than of each call site that serialises a row.
 */
export const CANONICAL_FIELDS = [
    'accountKey',
    'accountType',
    'createdAt',
    'department',
    'displayName',
    'email',
    'employeeNumber',
    'entitlements',
    'expiresAt',
    'familyName',
    'givenName',
    'isPrivileged',
    'lastLoginAt',
    'managerRef',
    'status',
    'title',
    'username',
] as const;

export type CanonicalFieldName =
    | (typeof IDENTITY_FIELDS)[number]
    | (typeof STATUS_FIELDS)[number]
    | (typeof ACCESS_FIELDS)[number];

/**
 * `CANONICAL_FIELDS` is spelled out as a literal rather than derived by
 * concatenating the three groups and sorting, so `z.enum` below gets literal key
 * types instead of a widened `string[]` needing a cast. The cost of writing it
 * twice is that the two could drift, so both directions are checked at compile
 * time: this assignment fails if the literal names a field no group declares, and
 * {@link CanonicalFieldsAreExhaustive} fails if a group declares a field the
 * literal omits.
 */
const _canonicalFieldsAreDeclared: readonly CanonicalFieldName[] = CANONICAL_FIELDS;
void _canonicalFieldsAreDeclared;
type CanonicalFieldsAreExhaustive =
    Exclude<CanonicalFieldName, (typeof CANONICAL_FIELDS)[number]> extends never
        ? true
        : ['missing from CANONICAL_FIELDS', Exclude<CanonicalFieldName, (typeof CANONICAL_FIELDS)[number]>];
const _canonicalFieldsExhaustive: CanonicalFieldsAreExhaustive = true;
void _canonicalFieldsExhaustive;

/**
 * The fields that can carry an identity, for the "at least one" rule below.
 *
 * `accountKey` is deliberately NOT in this set even though it is an identity
 * field. It is already required, so counting it would make the "at least one
 * identity-bearing field" rule vacuous — every valid mapping has an accountKey, so
 * every valid mapping would satisfy a rule that included it. The rule exists to
 * refuse a mapping that names ONLY the key, which reconciliation cannot use for
 * anything: there is nothing to match a person against.
 *
 * `department`, `title` and `managerRef` are identity CONTEXT rather than
 * identity — two people in the same department with the same title are not the
 * same person — so they do not satisfy the rule either.
 */
export const IDENTITY_BEARING_FIELDS: readonly CanonicalFieldName[] = [
    'username',
    'displayName',
    'givenName',
    'familyName',
    'email',
    'employeeNumber',
];

// ─── The denylist ──────────────────────────────────────────────────────────

/**
 * Column names that are never mapped and never requested.
 *
 * `egn` and `ЕГН` are the Bulgarian national identifier, in both alphabets,
 * because a Cyrillic column name in a Bulgarian deployment's legacy table is the
 * expected case rather than an exotic one. The Latin `egn` would not match the
 * Cyrillic string: `Е`, `Г` and `Н` are U+0415, U+0413, U+041D, which merely LOOK
 * like E, G and H.
 *
 * Matched case-insensitively against the whole column name as a substring, so
 * `USER_PASSWORD_HASH`, `pwd`, and `Password Expiry` all match. Over-matching is
 * the intended direction: a column wrongly refused costs an operator a support
 * conversation, where a column wrongly accepted is a credential in our database.
 */
export const DENIED_COLUMN_PATTERN =
    /pass(word)?|pwd|hash|salt|secret|token|pin|ssn|egn|ЕГН|national.?id|iban|card/i;

/** Whether a legacy column name may be mapped or requested. */
export function isDeniedColumn(columnName: string): boolean {
    return DENIED_COLUMN_PATTERN.test(columnName);
}

// ─── Status value mapping ──────────────────────────────────────────────────

export const CANONICAL_STATUSES = ['ACTIVE', 'DISABLED', 'LOCKED', 'EXPIRED', 'UNKNOWN'] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

/**
 * The status spellings seen in the wild, folded to upper case.
 *
 * A value NOT in here maps to `UNKNOWN` rather than to `ACTIVE`. That asymmetry is
 * deliberate and it is the fail-closed direction for this particular field: an
 * unrecognised status read as `ACTIVE` would put a disabled account into a
 * recertification campaign as something a reviewer must act on, which is noise; an
 * unrecognised status read as `DISABLED` would REMOVE a live account from the
 * campaign, which is the failure this product exists to prevent. `UNKNOWN` is
 * neither — it reaches a human with the fact that we could not tell.
 */
export const DEFAULT_STATUS_VALUE_MAP: Readonly<Record<string, CanonicalStatus>> = {
    A: 'ACTIVE', ACTIVE: 'ACTIVE', Y: 'ACTIVE', '1': 'ACTIVE', ENABLED: 'ACTIVE', TRUE: 'ACTIVE',
    I: 'DISABLED', INACTIVE: 'DISABLED', N: 'DISABLED', '0': 'DISABLED',
    DISABLED: 'DISABLED', FALSE: 'DISABLED', TERMINATED: 'DISABLED',
    L: 'LOCKED', LOCKD: 'LOCKED', LOCKED: 'LOCKED', SUSPENDED: 'LOCKED',
    E: 'EXPIRED', EXPIRED: 'EXPIRED',
};

/** Fold one raw status value through the default map plus any per-connection overrides. */
export function mapStatusValue(
    raw: unknown,
    overrides?: Readonly<Record<string, CanonicalStatus>>
): CanonicalStatus {
    if (typeof raw !== 'string') return 'UNKNOWN';
    const key = raw.trim().toUpperCase();
    if (!key) return 'UNKNOWN';
    return overrides?.[key] ?? DEFAULT_STATUS_VALUE_MAP[key] ?? 'UNKNOWN';
}

// ─── The canonical account ─────────────────────────────────────────────────

export const ACCOUNT_TYPES = ['HUMAN', 'SERVICE', 'SHARED', 'SYSTEM', 'UNKNOWN'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

const optionalText = z.string().trim().min(1).max(512).nullish().transform((v) => v ?? null);

/**
 * One account, after mapping.
 *
 * Every field but `accountKey` is nullable, because a legacy table is under no
 * obligation to carry any particular column and a mapping is under no obligation
 * to name one. What is NOT optional is that the mapping as a whole names enough to
 * reconcile with — see {@link assertMappingUsable}, which is a check on the
 * MAPPING rather than on each row. Enforcing it per row would refuse a real
 * account for having a blank display name.
 */
export const CanonicalAccountSchema = z.object({
    accountKey: z.string().trim().min(1).max(512),
    username: optionalText,
    displayName: optionalText,
    givenName: optionalText,
    familyName: optionalText,
    email: optionalText,
    employeeNumber: optionalText,
    department: optionalText,
    title: optionalText,
    managerRef: optionalText,
    status: z.enum(CANONICAL_STATUSES),
    lastLoginAt: z.date().nullish().transform((v) => v ?? null),
    createdAt: z.date().nullish().transform((v) => v ?? null),
    expiresAt: z.date().nullish().transform((v) => v ?? null),
    entitlements: z.array(z.string().trim().min(1).max(512)).max(512),
    isPrivileged: z.boolean().nullish().transform((v) => v ?? null),
    accountType: z.enum(ACCOUNT_TYPES),
});

export type CanonicalAccount = z.infer<typeof CanonicalAccountSchema>;

// ─── The stored mapping ────────────────────────────────────────────────────

/**
 * How entitlements are laid out in the source table.
 *
 * Declared rather than detected. A wide table (`ROLE_1` … `ROLE_8`) and a long
 * table (one row per account per role) are indistinguishable from a single page of
 * rows — the long layout looks exactly like a wide table with duplicate account
 * keys, which is a fault this module refuses. Guessing would turn a legitimate
 * long table into a `DUPLICATE_ACCOUNT_KEY` refusal, or worse, turn a genuinely
 * duplicated key in a wide table into a silently merged account.
 */
export const EntitlementLayoutSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('none'),
    }),
    z.object({
        kind: z.literal('wide'),
        /** The columns holding one entitlement each. Blank values are skipped. */
        columns: z.array(z.string().min(1)).min(1).max(64),
    }),
    z.object({
        kind: z.literal('long'),
        /** The single column holding one entitlement per row. */
        column: z.string().min(1),
    }),
    z.object({
        kind: z.literal('delimited'),
        column: z.string().min(1),
        delimiter: z.string().min(1).max(4),
    }),
]);

export type EntitlementLayout = z.infer<typeof EntitlementLayoutSchema>;

export const StoredMappingSchema = z.object({
    /** 1 on first save, incremented on every change. */
    version: z.number().int().positive(),
    /** The column set this mapping was confirmed against. See the module docblock. */
    columnSetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * The column NAMES the fingerprint was taken over.
     *
     * Stored alongside the hash because a hash cannot be DIFFED, and the drift
     * screen's whole job is to show which columns were added and which removed.
     * `computeColumnSetFingerprint` is one-way; without the names, a drift
     * refusal can only say "something changed", which tells an administrator to
     * re-confirm a mapping they have no way to review.
     *
     * OPTIONAL, and that is deliberate rather than lazy: mappings saved before
     * this field existed carry only the hash, and they are still valid mappings
     * that must keep pulling. The drift screen says plainly that it cannot show a
     * diff for them rather than rendering an empty one, which would read as "no
     * columns changed" — the opposite of the truth.
     */
    confirmedColumns: z.array(z.string().min(1).max(256)).max(512).optional(),
    /** canonical field → source column name. A field absent here is not collected. */
    fields: z.partialRecord(z.enum(CANONICAL_FIELDS), z.string().min(1).max(256)),
    entitlements: EntitlementLayoutSchema,
    /** Per-connection status spellings, folded over {@link DEFAULT_STATUS_VALUE_MAP}. */
    statusValues: z.record(z.string(), z.enum(CANONICAL_STATUSES)).optional(),
    confirmedAt: z.string(),
    confirmedByUserId: z.string().nullable(),
});

export type StoredMapping = z.infer<typeof StoredMappingSchema>;

/** The `configJson` key the mapping lives under. One key, so a reader can grep for it. */
export const MAPPING_CONFIG_KEY = 'legacyAccessMapping';

// ─── Mapping validation ────────────────────────────────────────────────────

export class LegacyMappingError extends Error {
    readonly problems: readonly string[];

    constructor(problems: readonly string[]) {
        super(`Legacy access mapping is unusable: ${problems.join('; ')}`);
        this.name = 'LegacyMappingError';
        this.problems = problems;
    }
}

/**
 * Refuse a mapping that cannot produce a reviewable snapshot.
 *
 * Reports EVERY problem rather than the first, following `assertMappingComplete`
 * in the ServiceNow provider: an administrator fixing a mapping one error at a
 * time through a form is being made to rediscover the requirement list by trial,
 * and each cycle is a round trip through a test connection.
 *
 * Four rules, and the last two are the security-bearing ones:
 *
 *  1. `accountKey` must be mapped. Without it no row can be keyed.
 *  2. At least one {@link IDENTITY_BEARING_FIELDS} field must be mapped, or there
 *     is nothing to reconcile against a person.
 *  3. No mapped column may be denied. Checked HERE, at save, so the column is
 *     never requested — not at ingestion, where it would already have crossed the
 *     network and be sitting in a response body.
 *  4. No two canonical fields may name the same column. That is not a harmless
 *     alias: it silently makes two independent signals into one, and if the shared
 *     column is `email` and `employeeNumber`, two STRONG signals that the engine
 *     treats as corroborating each other are the same fact counted twice.
 */
export function assertMappingUsable(mapping: StoredMapping): void {
    const problems: string[] = [];
    const fields = mapping.fields;

    const keyColumn = fields.accountKey;
    if (typeof keyColumn !== 'string' || keyColumn.trim() === '') {
        problems.push('accountKey is not mapped, so no row can be keyed');
    }

    const identityNamed = IDENTITY_BEARING_FIELDS.filter((f) => {
        const col = fields[f];
        return typeof col === 'string' && col.trim() !== '';
    });
    if (identityNamed.length === 0) {
        problems.push(
            'no identity-bearing field is mapped (one of '
            + `${IDENTITY_BEARING_FIELDS.join(', ')}), so no account can be reconciled`
        );
    }

    // Every column the mapping would REQUEST, entitlement layout included — a
    // denied column reached through `entitlements.column` is just as requested as
    // one reached through `fields`.
    for (const [field, column] of Object.entries(fields)) {
        if (typeof column === 'string' && isDeniedColumn(column)) {
            problems.push(`column "${column}" (mapped to ${field}) is on the never-request denylist`);
        }
    }
    for (const column of entitlementColumns(mapping.entitlements)) {
        if (isDeniedColumn(column)) {
            problems.push(`entitlement column "${column}" is on the never-request denylist`);
        }
    }

    const byColumn = new Map<string, string[]>();
    for (const [field, column] of Object.entries(fields)) {
        if (typeof column !== 'string') continue;
        const at = byColumn.get(column);
        if (at) at.push(field);
        else byColumn.set(column, [field]);
    }
    for (const [column, claimants] of byColumn) {
        if (claimants.length > 1) {
            problems.push(
                `column "${column}" is mapped to more than one canonical field `
                + `(${claimants.slice().sort().join(', ')})`
            );
        }
    }

    // If the mapping carries BOTH the column names and their fingerprint, they
    // must agree. A mismatch is not cosmetic: the fingerprint is what refuses a
    // drifted pull and the names are what the drift screen shows, so two that
    // disagree mean the screen explains the refusal with the wrong columns —
    // which is worse than showing nothing, because it looks authoritative.
    if (mapping.confirmedColumns) {
        const derived = computeColumnSetFingerprint(mapping.confirmedColumns);
        if (derived !== mapping.columnSetFingerprint) {
            problems.push(
                'confirmedColumns does not hash to columnSetFingerprint '
                + `(names give ${derived.slice(0, 12)}…, the stored hash is `
                + `${mapping.columnSetFingerprint.slice(0, 12)}…)`
            );
        }
    }

    if (problems.length > 0) throw new LegacyMappingError(problems);
}

/** Every column an entitlement layout reads. Empty for the `none` layout. */
export function entitlementColumns(layout: EntitlementLayout): readonly string[] {
    switch (layout.kind) {
        case 'none':
            return [];
        case 'wide':
            return layout.columns;
        case 'long':
        case 'delimited':
            return [layout.column];
    }
}

/**
 * Every column a pull should request, de-duplicated and sorted.
 *
 * This is the `?fields=` projection, and it is the mechanism behind "a sensitive
 * column never leaves the legacy network". Sorted so the request is byte-identical
 * across pulls of the same mapping — a URL that varies run to run is one nobody
 * can diff when debugging what the far end was asked for.
 */
export function projectedColumns(mapping: StoredMapping): readonly string[] {
    const out = new Set<string>();
    for (const column of Object.values(mapping.fields)) {
        if (typeof column === 'string' && column.trim() !== '') out.add(column);
    }
    for (const column of entitlementColumns(mapping.entitlements)) out.add(column);
    return [...out].sort();
}

// ─── Fingerprint ───────────────────────────────────────────────────────────

/**
 * A fingerprint of a column SET.
 *
 * Sorted and lower-cased before hashing, so a server that reorders its columns or
 * changes their case between pulls does not trip schema drift. Reordering is not a
 * schema change — the mapping names columns, never positions — and a refusal for
 * it would be a false alarm that teaches administrators to re-confirm mappings
 * without reading them, which is the one habit this check cannot survive.
 *
 * A column ADDED or REMOVED does change the fingerprint, and that is intended: an
 * added column may be the renamed twin of a removed one, and nothing here can tell
 * the difference. A person can.
 */
export function computeColumnSetFingerprint(columns: readonly string[]): string {
    const normalised = [...new Set(columns.map((c) => c.trim().toLowerCase()))].sort();
    return createHash('sha256').update(normalised.join('\n'), 'utf8').digest('hex');
}

// ─── Payload hash ──────────────────────────────────────────────────────────

/**
 * The algorithm version recorded beside every payload hash.
 *
 * Stored ON THE ROW rather than read from this constant at verification time. A
 * verifier that assumed the current algorithm would report every snapshot taken
 * before a change as corrupt — which is the opposite of what integrity evidence is
 * for, and it would happen on the day somebody fixes a canonicalisation bug.
 */
export const PAYLOAD_HASH_ALGORITHM_VERSION = 1;

/**
 * One account in canonical serialised form.
 *
 * Only non-null fields are emitted, in {@link CANONICAL_FIELDS} order, which is
 * sorted. Entitlements are sorted too: they are a SET, and a server that returns
 * the same roles in a different order has not changed the account's access.
 *
 * Dates serialise through `JSON.stringify` as ISO-8601 with milliseconds, which is
 * also what reading a Prisma `DateTime` back gives — so the hash recomputes from
 * the stored rows. That is the whole requirement on this function, and the reason
 * it takes a parsed {@link CanonicalAccount} rather than a raw row: a raw row's
 * `"2026-01-01"` and a stored `Date` are the same account and must hash the same.
 */
export function canonicaliseAccount(account: CanonicalAccount): string {
    const entries: [string, unknown][] = [];
    for (const field of CANONICAL_FIELDS) {
        const value = account[field];
        if (value === null || value === undefined) continue;
        entries.push([field, field === 'entitlements' ? [...(value as string[])].sort() : value]);
    }
    return JSON.stringify(Object.fromEntries(entries));
}

/**
 * SHA-256 over the whole mapped population, rows ordered by `accountKey`.
 *
 * Re-derivable by an auditor from the stored rows with no knowledge of what the
 * far end sent, which is the property that makes it evidence rather than a
 * checksum we happen to have kept. The row order comes from the data, not from
 * arrival or from an autoincrement id, for the same reason.
 *
 * `accountKey` is unique per snapshot (the database enforces it and
 * {@link mapRows} refuses a duplicate before then), so the sort is total and this
 * is deterministic.
 */
export interface PayloadHasher {
    /** Accounts MUST arrive in ascending `accountKey` order. */
    update(account: CanonicalAccount): void;
    digest(): string;
}

/**
 * An incremental hasher, so a verifier can PAGE the stored rows instead of
 * holding the whole population in memory.
 *
 * Exists because the recompute path reads from the database, where ordering by
 * `accountKey` is something the index already does — so there is no reason to
 * materialise fifty thousand rows to sort them again. {@link computePayloadHash}
 * is this plus the sort, which keeps exactly ONE canonicalisation in the module:
 * a second implementation on the verify side is how a hash and its own verifier
 * come to disagree, and the disagreement would read as corruption.
 *
 * The caller owes the ordering. It cannot be checked cheaply without keeping the
 * previous key, so it is kept and checked — a verifier that pages in the wrong
 * order would otherwise report a valid snapshot as corrupt.
 */
export function createPayloadHasher(): PayloadHasher {
    const h = createHash('sha256');
    let previous: string | null = null;
    return {
        update(account: CanonicalAccount): void {
            if (previous !== null && account.accountKey < previous) {
                throw new Error(
                    'payload hash requires accounts in ascending accountKey order; '
                    + 'got a key that sorts before its predecessor'
                );
            }
            previous = account.accountKey;
            h.update(canonicaliseAccount(account), 'utf8');
            h.update('\n', 'utf8');
        },
        digest(): string {
            return h.digest('hex');
        },
    };
}

export function computePayloadHash(accounts: readonly CanonicalAccount[]): string {
    // Sorted on `accountKey` ITSELF, not on the serialised line. Sorting the
    // lines would give the same answer today — `accountKey` happens to sort first
    // among the canonical field names, so it leads every JSON object — but that is
    // an accident of the alphabet, and a future field named before it (an
    // `aliasKey`, say) would silently re-order the whole population and change
    // every hash. Ordering by the thing the brief names costs one comparator.
    const ordered = [...accounts].sort((a, b) =>
        a.accountKey < b.accountKey ? -1 : a.accountKey > b.accountKey ? 1 : 0
    );
    const hasher = createPayloadHasher();
    for (const account of ordered) hasher.update(account);
    return hasher.digest();
}

// ─── Column-set drift, as something a person can read ──────────────────────

export interface ColumnSetDiff {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    /**
     * True when the stored mapping predates {@link StoredMapping.confirmedColumns}
     * and carries only a hash, so no diff is derivable.
     *
     * Reported rather than defaulted to an empty diff: "nothing changed" and "I
     * cannot tell what changed" must not look the same on a screen whose purpose
     * is to justify asking somebody to re-confirm.
     */
    readonly indeterminate: boolean;
}

/**
 * Which columns appeared and which vanished since a mapping was confirmed.
 *
 * Compared on the NORMALISED form the fingerprint uses — trimmed and
 * lower-cased — so a server that re-cases its headers produces an empty diff,
 * consistent with that same change not tripping drift in the first place. The
 * names REPORTED are the current ones for additions and the stored ones for
 * removals, because those are the spellings each side can actually look up.
 */
export function diffColumnSets(
    mapping: StoredMapping,
    observedColumns: readonly string[]
): ColumnSetDiff {
    if (!mapping.confirmedColumns) {
        return { added: [], removed: [], indeterminate: true };
    }
    const norm = (c: string): string => c.trim().toLowerCase();
    const before = new Map(mapping.confirmedColumns.map((c) => [norm(c), c]));
    const after = new Map(observedColumns.map((c) => [norm(c), c]));

    const added = [...after].filter(([k]) => !before.has(k)).map(([, v]) => v).sort();
    const removed = [...before].filter(([k]) => !after.has(k)).map(([, v]) => v).sort();
    return { added, removed, indeterminate: false };
}
