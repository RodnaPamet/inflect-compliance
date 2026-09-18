/**
 * A Tailwind arbitrary track list may not separate its tracks with commas.
 *
 * Tailwind writes an arbitrary value straight into CSS, substituting `_` for
 * the space the class name cannot contain. So
 *
 *     grid-cols-[1fr_320px]      ->  grid-template-columns: 1fr 320px       VALID
 *     grid-cols-[auto,1fr]       ->  grid-template-columns: auto,1fr        INVALID
 *
 * and an invalid `grid-template-columns` is not a degraded grid — the browser
 * DISCARDS the declaration. The element falls back to a single implicit column
 * and every child takes its own row. Paired with a `text-right` on the value,
 * that reads as a deliberate stacked layout rather than as breakage, which is
 * why two of these survived in the tree: nothing looks like an error.
 *
 * THE SUBTLETY THIS GUARD EXISTS FOR. A comma INSIDE a function is legal
 * argument syntax and must not be flagged:
 *
 *     grid-cols-[minmax(0,1fr)_340px]          VALID   — comma inside minmax()
 *     grid-cols-[minmax(0,380px),12rem,1fr]    INVALID — commas between tracks
 *
 * Same punctuation, opposite meanings. So the check strips balanced
 * parentheses first and only then looks for a comma.
 *
 * Found by a user reporting that a card's label and number rendered on
 * separate lines. The rendered test covering that component asserted the
 * `<dt>`/`<dd>` COUNTS and passed throughout — structure was never the defect.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** Arbitrary-value utilities whose payload is a space-separated track list. */
const TRACK_UTILITIES = ['grid-cols', 'grid-rows'] as const;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** Remove balanced parenthesised groups, so only top-level commas remain. */
function stripParens(s: string): string {
    let prev: string;
    let cur = s;
    do {
        prev = cur;
        cur = cur.replace(/\([^()]*\)/g, '');
    } while (cur !== prev);
    return cur;
}

interface Hit {
    file: string;
    line: number;
    value: string;
}

function scan(): { files: number; values: number; offenders: Hit[] } {
    const files = walk(SRC);
    const offenders: Hit[] = [];
    let values = 0;
    const re = new RegExp(`(?:${TRACK_UTILITIES.join('|')})-\\[([^\\]]+)\\]`, 'g');
    for (const file of files) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((text, i) => {
            for (const m of text.matchAll(re)) {
                values += 1;
                if (stripParens(m[1]).includes(',')) {
                    offenders.push({ file: path.relative(ROOT, file), line: i + 1, value: m[0] });
                }
            }
        });
    }
    return { files: files.length, values, offenders };
}

describe('Tailwind arbitrary track lists', () => {
    const report = scan();

    it('scanned a real population', () => {
        // Denominators before any "no offenders" claim: an empty selection is a PASS.
        expect(report.files).toBeGreaterThan(100);
        expect(report.values).toBeGreaterThan(4);
    });

    it('separates tracks with underscores, never commas', () => {
        if (report.offenders.length > 0) {
            throw new Error(
                [
                    'Arbitrary track list separated by commas — the browser DISCARDS',
                    'the declaration and the grid collapses to one implicit column.',
                    'Tailwind needs `_` where CSS wants a space.',
                    '',
                    ...report.offenders.map(
                        (o) => `  ${o.file}:${o.line}  ${o.value}`,
                    ),
                    '',
                    `  scanned: ${report.values} arbitrary track values in ${report.files} files`,
                ].join('\n'),
            );
        }
        expect(report.offenders).toEqual([]);
    });

    it('does not flag a comma inside a function', () => {
        // The discriminator: same punctuation, opposite meaning.
        expect(stripParens('minmax(0,1fr)_340px')).not.toContain(',');
        expect(stripParens('minmax(0,380px),12rem,1fr')).toContain(',');
        expect(stripParens('repeat(2,minmax(0,1fr))_auto')).not.toContain(',');
    });
});
