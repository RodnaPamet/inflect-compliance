/**
 * The recertification phases table must not store a status column.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A GUARD AND NOT A CONVENTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/legacy-access-recertification-phases.md` used to carry a `Status`
 * column beside the `Pull request` column it was derivable from. Two things went
 * wrong, and the second was worse:
 *
 *   1. Each step's own pull request set its own row to `Open`, which was true
 *      when written. MERGING that branch is what made the row false — so the
 *      commit that falsified the row was the commit that added it. 5 of 19 rows
 *      were wrong when the column was removed, and it had been wrong after
 *      almost every merge.
 *
 *   2. Every concurrent step edited the SAME rows, so the table conflicted on
 *      nearly every pair of steps in flight — three times in one day. Each
 *      resolution had the same shape: BOTH sides were stale snapshots, so the
 *      correct answer came from neither and every row had to be re-read from
 *      GitHub anyway. A naive resolution also duplicated rows, because the
 *      conflicting blocks sat far enough apart that a consecutive-duplicate
 *      filter removed none of them.
 *
 * The same class is already recorded in `CLAUDE.md`, about the per-class
 * `counts` header deleted from `docs/_status/doc-classification.json`: two
 * branches each bumping `494 → 495` do not conflict, so git keeps one copy,
 * both PRs are green, and main is wrong by one with no suspicious diff.
 *
 * A convention would not hold. The pressure to add the column back is strongest
 * exactly when it is most wrong — somebody reads the table, cannot tell what has
 * landed, and helpfully writes it down.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS STILL ALLOWED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The PR number, because that is the FACT rather than a projection of it. And
 * prose anywhere in the document may say whatever it likes — this guard reads
 * the table header only. A document that cannot discuss status would be a
 * document nobody could use.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3313
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC = path.resolve(
    __dirname,
    '../../docs/legacy-access-recertification-phases.md'
);

const text = fs.readFileSync(DOC, 'utf8');

/** Every markdown table header row in the document. */
function headerRows(): string[] {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
        // A header is a pipe row followed by a delimiter row. Matching the PAIR
        // rather than any pipe row is what keeps a data row full of dashes from
        // reading as a header.
        if (/^\|.*\|$/.test(lines[i].trim()) && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
            out.push(lines[i].trim());
        }
    }
    return out;
}

const DERIVED = /\b(status|state|merged|landed|progress)\b/i;

/**
 * The rows of the STEP table specifically — the one whose header names a pull
 * request — from its header to the first line that is not a table row.
 *
 * The document contains more than one step-keyed table, so "a line beginning
 * with a step id" is not the same population and never was.
 */
function stepTableRows(): string[] {
    const lines = text.split('\n');
    const start = lines.findIndex(
        (l) => l.trim().startsWith('| Step |') && l.includes('Pull request')
    );
    if (start < 0) return [];
    const out: string[] = [];
    // +2 skips the header and its delimiter row.
    for (let i = start + 2; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t.startsWith('|')) break;
        out.push(t);
    }
    return out;
}

describe('the recert phases table stores no derived status', () => {
    it('finds the tables it is meant to be checking', () => {
        // The population, asserted. A heading-matcher that silently stopped
        // matching would make every assertion below pass over nothing.
        const heads = headerRows();
        expect(heads.length).toBeGreaterThanOrEqual(2);
        expect(heads.some((h) => h.includes('| Step |'))).toBe(true);
    });

    it('no table header declares a status-like column', () => {
        const offenders = headerRows()
            .filter((h) => h.split('|').some((cell) => DERIVED.test(cell)))
            .map((h) => h);

        expect(offenders).toEqual([]);
    });

    it('the step table still carries the pull request column, which is the fact', () => {
        // The other direction. Deleting the whole table would satisfy the test
        // above, and would lose the one piece of non-derivable information in it.
        const step = headerRows().find((h) => h.includes('| Step |') && h.includes('Title'));
        expect(step).toContain('Pull request');
    });

    it('every recorded pull request is a number or an explicit em dash', () => {
        // Catches the other way the column rots: a row that says "in review" or
        // "see branch" instead of a number, which is a status by another name.
        //
        // Scoped to the ROWS OF ONE TABLE, not to every row in the document that
        // starts with a step id. The document has a second step-keyed table —
        // dependencies and change class — whose third column is `Standard`, and
        // a filter on `| 0a |` alone reads those rows as malformed PR cells.
        // That is what the first version of this test did.
        const rows = stepTableRows();
        expect(rows.length).toBeGreaterThanOrEqual(15);
        for (const r of rows) {
            const cell = r.split('|')[3].trim();
            expect({ row: r.slice(0, 12), ok: /^(—|#\d+( \(part \d\))?)$/.test(cell) })
                .toEqual({ row: r.slice(0, 12), ok: true });
        }
    });
});
