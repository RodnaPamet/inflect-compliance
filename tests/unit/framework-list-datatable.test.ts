/**
 * Framework list + detail page ratchets.
 *
 * History on the LIST page:
 *
 *   - Epic 46.4 originally migrated the list to ListPageShell +
 *     DataTable. That migration was rolled back; the card grid
 *     read better at-a-glance for a small catalog and gave every
 *     framework a colour band.
 *   - This file briefly locked the OPPOSITE invariant ("never
 *     re-introduce DataTable on the list") as a revert ratchet.
 *   - Epic 66 deliberately re-introduced a TOGGLE: the new
 *     `<FrameworksClient>` island owns table/cards switching so
 *     the user can pick. Default stays cards, persisted via
 *     `useViewMode` under `inflect:view-mode:frameworks`.
 *
 * The revert ratchet was therefore retired with Epic 66 — the
 * "explicit re-decision" the ratchet asked for is exactly what
 * Epic 66 carried out. The list-page UX choice is now under the
 * Epic 66 ratchet at `tests/rendered/epic-66-rollout.test.tsx`,
 * not here. The detail-page builder-tab assertions stay — those
 * are independent of the list-page UX choice.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const DETAIL_PAGE = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page.tsx',
);

function read(p: string): string {
    return codeOf(fs.readFileSync(p, 'utf-8'));
}

describe('framework detail — builder tab wiring (Epic 46.4)', () => {
    const src = read(DETAIL_PAGE);

    it('imports FrameworkBuilder', () => {
        expect(src).toMatch(
            /from\s*'@\/components\/ui\/FrameworkBuilder'/,
        );
        expect(src).toMatch(/<FrameworkBuilder\b/);
    });

    it('mounts the builder behind a permission gate', () => {
        expect(src).toMatch(/<RequirePermission[^>]*resource="frameworks"[^>]*action="install"/);
    });

    it('declares a "builder" tab and a #builder-panel container', () => {
        expect(src).toMatch(/key:\s*'builder'/);
        expect(src).toMatch(/id="builder-panel"/);
    });

    it('the save handler POSTs to /frameworks/<key>/reorder', () => {
        expect(src).toMatch(/\/frameworks\/\$\{frameworkKey\}\/reorder/);
    });
});
