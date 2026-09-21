/**
 * GUARD — the Evidence title cell keeps the FULL title text in the DOM.
 *
 * The title is truncated VISUALLY (CSS ellipsis), never by JS-substringing the
 * text node. A prior change rendered `truncateGlyph(title, 20)` as the cell's
 * children, which removed the full text from the DOM — silently breaking the
 * evidence-list E2E specs (`core-flow`, `evidence-upload-modal`) that assert
 * the newly-created row's FULL title appears, and degrading accessibility /
 * search / copy-paste. CSS truncation (`text-overflow: ellipsis`) is purely
 * visual: `textContent` stays complete, so assertions + a11y keep working.
 *
 * Lesson generalises (any list cell), but this lock is scoped to the surface
 * that actually regressed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx'),
    'utf8',
));

describe('GUARD: evidence title cell keeps full text in the DOM', () => {
    it('does not JS-truncate the title (no truncateGlyph / substring on the title node)', () => {
        expect(SRC).not.toMatch(/truncateGlyph\s*\(\s*title/);
        expect(SRC).not.toMatch(/title[^\n]*\.slice\(\s*0\s*,\s*\d+\s*\)/);
        expect(SRC).not.toMatch(/title[^\n]*\.substring\(\s*0\s*,\s*\d+\s*\)/);
    });

    it('truncates the title visually with a CSS ellipsis + a semantic width token', () => {
        // The title TableTitleCell carries the CSS-truncation classes, using
        // a semantic `max-w-trunc-*` token (not an arbitrary max-w-[…ch]),
        // per the Roadmap-4 PR-6 truncation-token discipline.
        expect(SRC).toMatch(/className="[^"]*truncate[^"]*"/);
        expect(SRC).toMatch(/max-w-trunc-(?:tight|default|loose)/);
    });

    it('renders the raw title as the cell children (full text in the DOM)', () => {
        // The cell's children is the bare `title`, not a truncated derivative.
        expect(SRC).toMatch(/<TableTitleCell[^>]*>\s*\{title\}\s*<\/TableTitleCell>/);
    });
});
