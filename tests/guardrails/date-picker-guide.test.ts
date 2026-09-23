/**
 * Epic 58 — the date-picker contributor guide stays complete.
 *
 * The BAN this file used to carry ("no native <input type=\"date\">") moved
 * to `no-restricted-syntax` in eslint.config.mjs on 2026-08-05. The regex
 * version needed a bespoke `stripComments()` helper so that a migration
 * note *mentioning* the old widget wouldn't fail the build — an AST
 * selector never sees a comment, so that whole class of false positive is
 * gone. The rule is scoped to app source there, exactly as it was here.
 *
 * What stays is the part ESLint cannot express: the lint message points
 * contributors at docs/date-picker.md, so that guide has to keep the
 * sections it promises. A rule whose explanation has been gutted is a rule
 * people work around.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The document's ATX heading lines AT ONE LEVEL, and nothing else (#2246).
 *
 * NARROWED AT THE READ SEAM RATHER THAN MASKED, because for this guard
 * masking is the wrong tool and would empty the subject. The four sibling
 * maskers in `tests/helpers/source-blocks.ts` all separate CODE from PROSE,
 * and `mdCodeOf` — the one for markdown — keeps the code (fences, inline
 * spans) and blanks the prose. A heading IS prose: measured on
 * `docs/date-picker.md`, all four needles below match once raw and ZERO
 * times through `mdCodeOf`. The assertion is not about code at all; it is
 * about the guide's SECTION STRUCTURE.
 *
 * So the fix is the other route this repo's Class A advice names — narrow
 * the read to the region the assertion is about. `/## Choosing presets/`
 * against the whole document is satisfied by that text ANYWHERE: a prose
 * sentence quoting the section name, a table cell, or a fenced markdown
 * sample. Against the level-2 heading lines it is satisfied only by a
 * level-2 heading.
 *
 * Fenced blocks are tracked and excluded for exactly that last case — a
 * guide that shows markdown source in a ```markdown fence would otherwise
 * document its own headings into existence.
 *
 * WHY `level` IS A PARAMETER rather than baked into the regex. It says what
 * the assertions below actually mean — every one of them writes `##`, so the
 * subject is the level-2 structure and not "any heading". It also keeps this
 * READABLE to `tests/helpers/assertion-reach.ts`, which distinguishes a
 * narrowing from a mask by arity: a one-argument `f(<content>)` is the shape
 * of a wrapper (`codeOnly(src)`) and resolves as `content-transformed`, a
 * CAPPED skip, while a second argument is the shape of an extraction
 * (`declarationOf(src, 'fetchVendor')`) and is out of scope because
 * narrowing is the fix those ratchets ask for. Measured: the one-argument
 * spelling of this function pushed Class D's `UNANALYSABLE_READ_BASELINE`
 * from 1460 to 1467 — taking the advice turned a ceiling red.
 */
function headingLines(md: string, level: number): string {
    const out: string[] = [];
    const marker = new RegExp(`^#{${level}}\\s`);
    let open: string | null = null;
    for (const line of md.split('\n')) {
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (open === null) open = fence[1][0];
            else if (fence[1][0] === open) open = null;
            continue;
        }
        if (open === null && marker.test(line)) out.push(line);
    }
    return out.join('\n');
}

describe('Epic 58 — date-picker contributor guide', () => {
    it('the contributor guide ships with the canonical components', () => {
        const docPath = path.join(ROOT, 'docs/date-picker.md');
        expect(fs.existsSync(docPath)).toBe(true);
        const headings = headingLines(fs.readFileSync(docPath, 'utf-8'), 2);
        expect(headings).toMatch(/## Picking the right component/i);
        expect(headings).toMatch(/## Choosing presets/i);
        expect(headings).toMatch(/## Display formatters/i);
        expect(headings).toMatch(/## Filter-state integration/i);
    });
});
