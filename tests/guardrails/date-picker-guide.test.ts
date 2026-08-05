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

describe('Epic 58 — date-picker contributor guide', () => {
    it('the contributor guide ships with the canonical components', () => {
        const docPath = path.join(ROOT, 'docs/date-picker.md');
        expect(fs.existsSync(docPath)).toBe(true);
        const doc = fs.readFileSync(docPath, 'utf-8');
        expect(doc).toMatch(/## Picking the right component/i);
        expect(doc).toMatch(/## Choosing presets/i);
        expect(doc).toMatch(/## Display formatters/i);
        expect(doc).toMatch(/## Filter-state integration/i);
    });
});
