/**
 * The wire contract `inflect-legacy-access/1`.
 *
 * ONE SOURCE OF TRUTH. `docs/legacy-mcp-access-contract.md` is what an operator
 * builds against, `tests/helpers/legacy-mcp-fake-server.ts` is the executable
 * reference, and these schemas are what the client enforces. The document names the
 * fake server as the reference implementation and the suite validates that server's
 * output against these schemas, so the three cannot drift apart silently.
 *
 * ‾‾‾ WHY EVERY DIMENSION IS BOUNDED ‾‾‾
 *
 * A legacy MCP server is hosted by the operator, not by us. It is a third party in
 * the security sense even when the customer runs it themselves: the bytes arrive
 * from outside, over the network, from software we did not write. So the schema
 * states a maximum for every dimension that can grow - column count, column-name
 * length, snapshot-id length, rows per page, pages per snapshot and cell length -
 * rather than trusting a server's own claim about its size.
 *
 * These are the schema's bounds. Step 1b enforces the same numbers at the transport
 * layer, BEFORE parsing, because a schema cannot protect you from a body you have
 * already read into memory. A bound stated in only one of those two places is not a
 * bound.
 *
 * ‾‾‾ STRICT, AND WHY THAT IS THE INTERESTING PART ‾‾‾
 *
 * Every envelope is `.strict()`. An unknown key is a refusal rather than a shrug,
 * which is what makes the oversharing fault detectable: a server that sends columns
 * the mapping did not ask for has to be NOTICED, because the alternative is storing
 * data nobody classified. Zod's default would strip the extra key and hand back a
 * clean object, and the connection would look healthy while quietly receiving more
 * than it should.
 *
 * Rows are the one deliberate exception - see `LegacyRowSchema`.
 */
import { z } from 'zod';

/** The only contract version this client speaks. */
export const CONTRACT_VERSION = 'inflect-legacy-access/1' as const;

/**
 * Bounds. Each is a refusal threshold, not a target.
 *
 * `MAX_PAGES * MAX_ROWS_PER_PAGE` is the ceiling on one snapshot - a million
 * accounts, which is far past any real legacy application and still finite, so a
 * server cannot keep a pull running forever by paginating.
 */
export const LIMITS = {
    /** Columns in a manifest. A wide legacy export is tens, not hundreds. */
    MAX_COLUMNS: 200,
    /** A column name reaches the mapping UI, so it is short and inert. */
    MAX_COLUMN_NAME_LENGTH: 128,
    /** Opaque to us; bounded so it cannot be a payload. */
    MAX_SNAPSHOT_ID_LENGTH: 200,
    MAX_ROWS_PER_PAGE: 1_000,
    MAX_PAGES: 1_000,
    /** One cell. Legacy free-text fields exist; a megabyte of them does not. */
    MAX_CELL_LENGTH: 4_096,
    /** Resource URI, app name, owner. */
    MAX_SHORT_TEXT_LENGTH: 512,
} as const;

/**
 * Control and invisible characters are REJECTED, never stripped.
 *
 * Column names are rendered in the mapping UI and used as object keys. Stripping
 * would silently rename a column - and two columns differing only by a zero-width
 * character would then collide, producing a mapping that points at the wrong data.
 * Refusing says so instead. C0, C1, and the bidi, zero-width and separator marks
 * that make two different names look identical.
 *
 * ALL of C0, tab and the newlines included. An earlier draft carved out
 * \x09, \x0A and \x0D by reflex, from the habit of treating them as ordinary
 * whitespace. They are not ordinary in a column NAME: both are invisible in
 * the mapping UI, so `emp\tid` and `empid` present identically to the person
 * choosing what a column means, which is the collision this check exists to
 * prevent. A legitimate column name contains neither.
 */
const FORBIDDEN_CONTROL =
    /[\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/;

const inertText = (max: number, label: string) =>
    z
        .string()
        .min(1, `${label} must not be empty`)
        .max(max, `${label} exceeds ${max} characters`)
        .refine((s) => !FORBIDDEN_CONTROL.test(s), {
            message: `${label} contains a control or invisible character`,
        });

export const ColumnNameSchema = inertText(LIMITS.MAX_COLUMN_NAME_LENGTH, 'column name');

/**
 * A declared column type. Advisory only.
 *
 * The client does NOT coerce a cell because its column says `number`: a legacy
 * export that labels a column `number` and sends `"00123"` is describing its own
 * intent, not ours, and leading zeros are load-bearing in an employee number.
 * Mapping and normalisation decide types later, from the value.
 */
export const ColumnTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'unknown']);

export const ColumnSchema = z
    .object({
        name: ColumnNameSchema,
        type: ColumnTypeSchema,
        nullable: z.boolean(),
    })
    .strict();

/**
 * Entitlement layout, declared by the server.
 *
 * `wide` - one column per entitlement, truthy means held.
 * `long` - one row per (account, entitlement) pair.
 *
 * Declared rather than inferred, because the two are indistinguishable from data
 * alone when an application happens to give each account exactly one entitlement.
 */
export const LayoutSchema = z.enum(['wide', 'long']);

export const ManifestSchema = z
    .object({
        contract: z.literal(CONTRACT_VERSION),
        app: z
            .object({
                name: inertText(LIMITS.MAX_SHORT_TEXT_LENGTH, 'app name'),
                owner: inertText(LIMITS.MAX_SHORT_TEXT_LENGTH, 'app owner'),
            })
            .strict(),
        snapshot: z
            .object({
                id: inertText(LIMITS.MAX_SNAPSHOT_ID_LENGTH, 'snapshot id'),
                generatedAt: z.string().datetime({ offset: true }),
                rowCount: z
                    .number()
                    .int()
                    .nonnegative()
                    .max(LIMITS.MAX_PAGES * LIMITS.MAX_ROWS_PER_PAGE),
            })
            .strict(),
        columns: z
            .array(ColumnSchema)
            .min(1, 'a manifest with no columns describes nothing')
            .max(LIMITS.MAX_COLUMNS)
            // A duplicate column name makes the row record ambiguous: one key, two
            // declared meanings, and whichever the server serialises last wins.
            .refine((cols) => new Set(cols.map((c) => c.name)).size === cols.length, {
                message: 'duplicate column name',
            }),
        pages: z
            .array(inertText(LIMITS.MAX_SHORT_TEXT_LENGTH, 'page uri'))
            .min(1, 'a snapshot with no pages cannot be read')
            .max(LIMITS.MAX_PAGES),
        layout: LayoutSchema,
    })
    .strict();

export type LegacyManifest = z.infer<typeof ManifestSchema>;

/** A cell. Scalars only - no nested objects or arrays on the wire. */
export const CellSchema = z.union([
    z.string().max(LIMITS.MAX_CELL_LENGTH),
    z.number().finite(),
    z.boolean(),
    z.null(),
]);

/**
 * A row: column name to cell.
 *
 * THE ONE PLACE THAT IS NOT `.strict()`, and deliberately. A row's keys are the
 * manifest's column names, which are data rather than schema, so there is no fixed
 * key set to be strict about. The check that matters - that a row carries no column
 * the mapping did not request - belongs where the manifest is known, which is the
 * client in Step 1b and the ingestion in Step 2a. Stating it here would be a
 * pretence: this schema cannot see the manifest.
 */
export const LegacyRowSchema = z.record(ColumnNameSchema, CellSchema);
export type LegacyRow = z.infer<typeof LegacyRowSchema>;

export const PageSchema = z
    .object({
        snapshotId: inertText(LIMITS.MAX_SNAPSHOT_ID_LENGTH, 'snapshot id'),
        page: z.number().int().positive().max(LIMITS.MAX_PAGES),
        rows: z.array(LegacyRowSchema).max(LIMITS.MAX_ROWS_PER_PAGE),
    })
    .strict();

export type LegacyPage = z.infer<typeof PageSchema>;

// --- Resource URIs -------------------------------------------------

export const MANIFEST_URI = 'inflect-access://manifest' as const;
const ACCOUNTS_URI_RE = /^inflect-access:\/\/accounts\/([1-9]\d{0,3})(\?fields=[^?#]*)?$/;

/** The page URI for page `n`, with an optional `?fields=` projection. */
export function accountsUri(page: number, fields?: readonly string[]): string {
    const base = `inflect-access://accounts/${page}`;
    if (!fields || fields.length === 0) return base;
    // Comma-separated, in the caller's order. Not percent-encoded per component: the
    // contract document fixes the grammar as bare column names, and a name needing
    // encoding would already have failed `ColumnNameSchema`.
    return `${base}?fields=${fields.join(',')}`;
}

/**
 * Parse a page URI the client is about to request, or one a server advertised.
 *
 * Returns `null` rather than throwing, because an unparseable URI in a manifest is
 * a contract violation the caller reports with its own typed error - not an
 * exception from a parser.
 */
export function parseAccountsUri(uri: string): { page: number; fields: string[] } | null {
    const m = ACCOUNTS_URI_RE.exec(uri);
    if (!m) return null;
    const page = Number(m[1]);
    if (!Number.isInteger(page) || page < 1 || page > LIMITS.MAX_PAGES) return null;
    const fields = m[2]
        ? m[2].slice('?fields='.length).split(',').filter((f) => f.length > 0)
        : [];
    return { page, fields };
}

/**
 * Whether a contract string is the version this client speaks.
 *
 * Exported so Step 1b can refuse an unknown version with a typed error before it
 * tries to parse the body - a clearer failure than a Zod issue on a literal, and
 * the one an operator can act on.
 */
export function isSupportedContract(contract: unknown): contract is typeof CONTRACT_VERSION {
    return contract === CONTRACT_VERSION;
}
