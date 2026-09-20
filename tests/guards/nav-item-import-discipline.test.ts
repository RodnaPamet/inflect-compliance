/**
 * Roadmap-12 PR-1 — `<NavItem>` primitive discipline.
 *
 * The tenant sidebar's `NavItem` was extracted from inline-in-
 * `SidebarNav.tsx` into its own `nav-item.tsx` so every later
 * Roadmap-12 PR can edit one file.
 *
 * Invariants this ratchet locks:
 *
 *   1. `nav-item.tsx` exists, is a "use client" module, and exports
 *      the three load-bearing class strings (BASE / DEFAULT /
 *      ACTIVE) by name. Future PRs edit these consts; the import
 *      surface stays stable.
 *
 *   2. `SidebarNav.tsx` imports `NavItem` from `./nav-item` — not
 *      from a deep path, not duplicated inline.
 *
 *   3. `SidebarNav.tsx` does NOT redeclare the load-bearing geometry
 *      tokens (`min-h-[44px] rounded-lg`) inline. The primitive owns
 *      them. Catches the "let me just hand-roll a one-off nav link"
 *      regression.
 *
 * What this ratchet does NOT police
 *
 *   - The exact class-string content. Roadmap-12 PRs 4-9 will edit
 *     these constants; the ratchet asserts they're CO-LOCATED in
 *     `nav-item.tsx`, not what they say.
 *
 *   - `OrgSidebarNav.tsx`'s `OrgNavItem`. The org sidebar still
 *     uses the legacy `nav-link` CSS class. Consolidating it is a
 *     separate migration — outside Roadmap-12's tenant-sidebar
 *     scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const NAV_ITEM = 'src/components/layout/nav-item.tsx';
const SIDEBAR_NAV = 'src/components/layout/SidebarNav.tsx';

describe('Roadmap-12 PR-1 — NavItem primitive discipline', () => {
    describe('`nav-item.tsx` shape', () => {
        const src = read(NAV_ITEM);

        it('is a client module', () => {
            // The Link import + onClick handler only work in client
            // contexts. The directive must come first.
            expect(src.trimStart()).toMatch(/^['"]use client['"]/);
        });

        it('exports the `NavItem` component', () => {
            expect(src).toMatch(/export\s+function\s+NavItem\b/);
        });

        it('exports the three load-bearing class strings by name', () => {
            // Future Roadmap-12 PRs edit ONLY these three consts.
            // Renaming or removing any of them changes the primitive's
            // public surface — by design a deliberate, ratchet-
            // catching event.
            expect(src).toMatch(/export\s+const\s+NAV_ITEM_BASE\b/);
            expect(src).toMatch(/export\s+const\s+NAV_ITEM_DEFAULT\b/);
            expect(src).toMatch(/export\s+const\s+NAV_ITEM_ACTIVE\b/);
        });
    });

    describe('`SidebarNav.tsx` consumes the primitive', () => {
        const src = read(SIDEBAR_NAV);

        it('imports `NavItem` from `./nav-item` (not a deep path, not duplicated inline)', () => {
            expect(src).toMatch(
                /import\s*\{\s*NavItem\s*\}\s*from\s*['"]\.\/nav-item['"]/,
            );
        });

        it('does not redeclare `NavItem` inline', () => {
            // The legacy inline definition lived here. If a future
            // refactor reintroduces a local NavItem (intentionally
            // or accidentally), the primitive contract drifts —
            // catch it.
            expect(src).not.toMatch(/function\s+NavItem\b/);
        });

        it('does not redeclare the load-bearing geometry tokens', () => {
            // `min-h-[44px] rounded-lg` is the recipe `nav-item.tsx`
            // owns. A hand-rolled `<Link>` with that geometry in
            // SidebarNav.tsx would be a second source of truth for
            // a contract Roadmap-12 needs centralised.
            expect(src).not.toMatch(/min-h-\[44px\][^"]*rounded-lg/);
        });
    });
});
