/**
 * Exactly one file under `src/` renders `<header role="banner">` (#3650).
 *
 * `nav-bar.tsx` said "The ratchet `tests/guards/nav-bar-import-discipline.test.ts`
 * locks the contract: no parallel `<header role="banner">` with the load-bearing
 * chrome geometry outside this file." That file has never existed here, and no
 * guard in `tests/guards` or `tests/guardrails` scans for the attribute at all.
 *
 * WHY IT IS A GUARD AND NOT A RENDERED TEST. `app-shell-frame-landmarks.test.tsx`
 * already asserts the landmark structure of the frame — one `main`, the banner
 * not nested inside it — by RENDERING. It cannot see a second banner introduced
 * by a page it does not render, and a rendered test for "no other file does
 * this" would have to render every page to be sound. The property is textual and
 * repo-wide, so it is checked that way.
 *
 * WHY ONE AND NOT ZERO-OR-ONE. `toHaveLength(1)` rather than
 * `toBeLessThanOrEqual(1)`, because the floor matters as much as the ceiling: a
 * refactor that deleted the banner entirely would satisfy "no parallel banner"
 * perfectly and lose the `banner` landmark, which is the accessibility
 * affordance the whole contract exists to protect (axe
 * `landmark-banner-is-top-level`, and a page with no banner has no top-level
 * landmark for a screen reader to jump to).
 *
 * COMMENTS ARE MASKED. `AppShellFrame.tsx` mentions `<header role="banner">` in
 * a comment explaining the nesting bug it fixed — it does not render one. A raw
 * scan reports two files and the second is an explanation of the fix, which is
 * the "a scar is not a wound" failure. I hit exactly that while filing #3650
 * and nearly recorded a second live banner that does not exist.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3650
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/** `role="banner"` as rendered markup, in either quote style. */
const BANNER_ROLE = /role=\{?["']banner["']\}?/;

function filesRenderingABanner(): string[] {
    return repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
        .filter((abs) => BANNER_ROLE.test(codeOf(fs.readFileSync(abs, 'utf-8'))))
        .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
        .sort();
}

describe('exactly one banner landmark in src/ (#3650)', () => {
    it('scans a real population of source files', () => {
        expect(repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).length).toBeGreaterThan(500);
    });

    it('exactly one file renders role="banner", and it is the nav bar', () => {
        // Named, not just counted. A count of one would be satisfied by the
        // banner MOVING to another file, which is a different change and one
        // that should be made deliberately rather than pass this guard silently.
        expect(filesRenderingABanner()).toEqual(['src/components/layout/nav-bar.tsx']);
    });

    it('ignores a banner mentioned in a comment, and sees one in markup', () => {
        // The control. `AppShellFrame.tsx` produces the first case for real, so
        // a guard without comment masking would report it as a second banner.
        expect(BANNER_ROLE.test(codeOf('// `<header role="banner">` INSIDE the main landmark'))).toBe(false);
        expect(BANNER_ROLE.test(codeOf('/* It used to wrap both, which put role="banner" inside */'))).toBe(false);

        expect(BANNER_ROLE.test(codeOf('<header role="banner" data-testid="nav-bar">'))).toBe(true);
        expect(BANNER_ROLE.test(codeOf("<header role='banner'>"))).toBe(true);
        expect(BANNER_ROLE.test(codeOf('<header role={"banner"}>'))).toBe(true);

        // And a different landmark must not count.
        expect(BANNER_ROLE.test(codeOf('<nav role="navigation">'))).toBe(false);
    });
});
