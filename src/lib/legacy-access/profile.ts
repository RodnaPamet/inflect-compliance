/**
 * Profiling a page of legacy rows into per-column STATISTICS, and discarding the
 * rows.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FUNCTION IS THE BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rows go in; counts and shares come out. Nothing that reaches the mapping
 * screen passes through anywhere else, so this is the one place that decides what
 * an operator may see about a column whose meaning nobody has yet declared — and
 * that is the moment of maximum exposure in the whole subsystem, because the
 * denylist only covers column NAMES and nobody has classified the rest.
 *
 * The one value that survives is {@link ColumnProfile.valueSet}, gated by
 * {@link mayExposeValueSet}. It exists because the status value-map editor cannot
 * ask somebody to map `A` onto `ACTIVE` without showing them `A`, and the gate is
 * what makes that a VOCABULARY rather than a sample: a small closed set, each of
 * whose members describes many rows. A name, an email or an employee number
 * cannot satisfy it at any sample size, because they are high-cardinality by
 * definition and fail the repetition floor however the sample is chosen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE PERSISTS, AND NOTHING HERE IS A SNAPSHOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A profile is scaffolding for a decision an administrator is about to make. It
 * is not evidence, it is not keyed, it has no payload hash, and it writes no
 * `LegacyAccount` row — a `COMPLETE` snapshot is the only thing recertification
 * reads, and a profile is explicitly not one. That separation is why the profiler
 * may read a column the mapping does not name: you cannot map a column you were
 * never shown.
 *
 * @module lib/legacy-access/profile
 */

import { isDeniedColumn } from './canonical';
import { mayExposeValueSet, type ColumnProfile } from './mapping-suggest';

export type { ColumnProfile } from './mapping-suggest';

/**
 * Cells longer than this are measured but never retained.
 *
 * A length is a statistic; the content is not. The cap exists so a pathological
 * cell cannot make the `maxLength` figure itself a memory problem.
 */
const MAX_MEASURED_LENGTH = 4096;

// ─── Shape detectors ───────────────────────────────────────────────────────

/**
 * Email-ish, for the purpose of a SHARE.
 *
 * Deliberately looser than a validator and deliberately not `checkWebhookUrl`'s
 * cousin: the question is "does this column look like it holds addresses", and
 * one malformed row should not move the answer. Stricter than `includes('@')`
 * because a display name can contain one.
 */
function looksLikeEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v);
}

/**
 * Date-ish. ISO-8601, `YYYY/MM/DD`, `DD.MM.YYYY` and `DD/MM/YYYY`.
 *
 * Parsed with a pattern FIRST and `Date` second. `new Date('7')` is a valid date
 * in V8, so a column of small integers would otherwise read as 100% dates and be
 * suggested as `createdAt` — which drives the temporal veto.
 */
function looksLikeDate(v: string): boolean {
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([T ]|$)|^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(v)) {
        return false;
    }
    return !Number.isNaN(new Date(v.replace(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/, '$3-$2-$1')).getTime());
}

function looksLikeInteger(v: string): boolean {
    return /^\d{1,20}$/.test(v);
}

const BOOLEAN_WORDS = new Set([
    'true', 'false', 'yes', 'no', 'y', 'n', '0', '1', 't', 'f', 'enabled', 'disabled',
]);

function looksLikeBoolean(v: string): boolean {
    return BOOLEAN_WORDS.has(v.toLowerCase());
}

// ─── The profiler ──────────────────────────────────────────────────────────

/**
 * One profile per column, computed from the rows and nothing else.
 *
 * `columns` comes from the manifest, so a column present in the manifest but
 * absent from every row still gets a profile — with `nonNullCount: 0`, which is
 * the honest answer and is what tells an administrator the column is empty
 * rather than missing. Deriving the column list from the rows instead would make
 * an all-null column disappear from the screen.
 *
 * A denylisted column is refused rather than profiled, even though the caller
 * should never have requested it. Two checks, because this one is cheap and the
 * cost of the other being wrong is a credential in a screenshot.
 */
export function computeColumnProfiles(
    rows: readonly Record<string, unknown>[],
    columns: readonly string[]
): readonly ColumnProfile[] {
    const wanted = columns.filter((c) => !isDeniedColumn(c));

    return wanted.map((column) => {
        // One pass per column rather than one pass over rows building every
        // column's accumulator: the row count here is ONE page, and per-column
        // keeps each `Set` scoped so a wide table does not hold every column's
        // distinct values at once.
        const distinct = new Set<string>();
        let nonNull = 0;
        let emails = 0;
        let dates = 0;
        let integers = 0;
        let booleans = 0;
        let maxLength = 0;

        for (const row of rows) {
            const raw = readCell(row, column);
            if (raw === null) continue;
            nonNull += 1;
            if (raw.length > maxLength) maxLength = Math.min(raw.length, MAX_MEASURED_LENGTH);
            // Bounded: a page is capped by the transport, so this Set is bounded
            // by rows-per-page and not by the table.
            distinct.add(raw);
            if (looksLikeEmail(raw)) emails += 1;
            if (looksLikeDate(raw)) dates += 1;
            if (looksLikeInteger(raw)) integers += 1;
            if (looksLikeBoolean(raw)) booleans += 1;
        }

        const share = (n: number): number => (nonNull === 0 ? 0 : n / nonNull);
        const base = {
            name: column,
            rowsSampled: rows.length,
            nonNullCount: nonNull,
            distinctCount: distinct.size,
            emailShare: share(emails),
            dateShare: share(dates),
            integerShare: share(integers),
            booleanShare: share(booleans),
            maxLength,
        };

        // The gate, applied HERE and nowhere else. A caller that wants the values
        // cannot ask for them; it gets them only when the statistics say they are
        // a vocabulary.
        if (!mayExposeValueSet(base)) return base;
        return { ...base, valueSet: [...distinct].sort() };
    });
}

/**
 * Read one cell as text, case-insensitively by column name.
 *
 * Case-insensitive for the same reason the fingerprint is: a server that
 * upper-cases its headers between pulls has not changed its schema. Returns null
 * for absent, blank, and for any non-scalar — an object in a cell is not
 * something a share can describe, and stringifying it would put a blob on the
 * mapping screen.
 */
function readCell(row: Record<string, unknown>, column: string): string | null {
    const target = column.trim().toLowerCase();
    for (const [key, value] of Object.entries(row)) {
        if (key.trim().toLowerCase() !== target) continue;
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') {
            const t = value.trim();
            return t === '' ? null : t;
        }
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return null;
    }
    return null;
}
