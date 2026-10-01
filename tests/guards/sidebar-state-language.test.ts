import { codeOf, cssCodeOf } from '../helpers/source-blocks';
/**
 * Elevation PR-3 — sidebar state-language ratchet.
 *
 * Locks two invariants on the sidebar:
 *
 *   1. SidebarNav.tsx does NOT reference the legacy `nav-link` /
 *      `nav-link-label` CSS classes. The state language (default /
 *      hover / active / focus-visible) lives inline as Tailwind
 *      tokens so it participates in the design-system ratchets
 *      (Polish PR-8 hover-state, Polish PR-9 motion-language).
 *
 *   2. globals.css does NOT redefine `.nav-link`. The CSS rule was
 *      retired by Elevation PR-3 — re-introducing it would silently
 *      pull a sidebar consumer back into the un-ratcheted CSS layer.
 *
 *   3. The mobile drawer close button has a focus ring
 *      (`focus-visible:ring-2`). Keyboard accessibility on a
 *      load-bearing UI affordance. Since T07 (#3076) that is a chain:
 *      `MobileNavDrawer` mounts `Sheet.Header`, and Sheet's close
 *      button carries the ring. Both links are asserted.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SIDEBAR = 'src/components/layout/SidebarNav.tsx';
const GLOBALS = 'src/app/globals.css';

describe('Sidebar state-language ratchet (Elevation PR-3)', () => {
    it('SidebarNav.tsx does not reference the retired nav-link / nav-link-label CSS classes', () => {
        const abs = path.resolve(ROOT, SIDEBAR);
        expect(fs.existsSync(abs)).toBe(true);
        // #2246 — masked at the READ SEAM. This suite already wanted exactly
        // that: its own note below says `nav-link` may appear in JSDoc and is
        // banned only as a className. Masking enforces that by construction
        // instead of by a regex that tries to spot comments.
        const content = codeOf(fs.readFileSync(abs, 'utf8'));
        // Allow `nav-link` to appear in JSDoc comments; ban only
        // className attribute uses.
        const usagePatterns = [
            /className=[`"][^`"]*\bnav-link\b/,
            /className=[`"][^`"]*\bnav-link-label\b/,
        ];
        for (const re of usagePatterns) {
            expect(content).not.toMatch(re);
        }
    });

    it('globals.css does not redefine `.nav-link`', () => {
        // #2246 — named `cssAbs`, not `abs`, on purpose. The Class A analyser
        // resolves a read's target by VARIABLE NAME and does not honour block
        // scope: with three sibling `const abs` bindings in this file it
        // credited THIS css read with a `.tsx` path.
        //
        // It used to stay RAW, and the note here said why: "`codeOf` lexes
        // TypeScript, not CSS". That was true and is no longer — #2727 added
        // `cssCodeOf`, which blanks /* … */ and preserves length and line
        // count. So the read is masked with the masker for its OWN kind, and
        // the assertion below can no longer be satisfied by a `.nav-link`
        // rule that someone commented out rather than deleted.
        const cssAbs = path.resolve(ROOT, GLOBALS);
        const content = cssCodeOf(fs.readFileSync(cssAbs, 'utf8'));
        // The retired ruleset shape: `.nav-link {` or `.nav-link.active {`.
        expect(content).not.toMatch(/^\s*\.nav-link\b[^*]/m);
    });

    it('the mobile drawer close button has a focus-visible ring', () => {
        // T07 (#3076) — the drawer moved from the hand-rolled `MobileDrawer`
        // in SidebarNav.tsx onto `Sheet direction="left"`, so the close button
        // is the primitive's now and the needle that read SidebarNav for a
        // `data-testid="nav-drawer-close"` block can no longer find it.
        //
        // The INVARIANT is unchanged — keyboard accessibility on a
        // load-bearing affordance — and it is now a chain of two links, so
        // both are asserted. Either one alone is satisfiable while the user
        // loses the ring: a drawer with no header renders no close button at
        // all, and a close button with no ring is invisible to a keyboard
        // user. Body-only rendering was in fact the first shape this
        // conversion took, and this assertion is what caught it.
        const drawer = codeOf(
            fs.readFileSync(
                path.resolve(ROOT, 'src/components/layout/MobileNavDrawer.tsx'),
                'utf8',
            ),
        );
        // link 1 — the drawer mounts the header that carries the close button.
        expect(drawer).toMatch(/<Sheet\.Header\b/);

        // link 2 — the primitive's close button carries the ring.
        const sheet = codeOf(
            fs.readFileSync(path.resolve(ROOT, 'src/components/ui/sheet.tsx'), 'utf8'),
        );
        const closeBlock = sheet.match(/data-sheet-close[\s\S]{0,400}/);
        expect(closeBlock).not.toBeNull();
        expect(closeBlock?.[0] ?? '').toMatch(/focus-visible:ring-2/);
    });

    it('the NavItem primitive uses the canonical hover/active state shape', () => {
        // R12-PR1 extracted the state recipe from `SidebarNav.tsx`
        // into `nav-item.tsx`.
        // R12-PR4 dropped the `/50` alpha on the hover bg.
        // R12-PR5 retired the full-row hover bg entirely —
        //   the hover signal is a 3px brand-gradient capsule band
        //   on the left, faded in via opacity transition on a
        //   `::before` pseudo-element.
        // R12-PR6 added a brand-subtle bg wash to the active state.
        // R13-PR2 expanded the band gradient from 2 stops
        //   (`from-default → to-emphasis`) to 3 stops
        //   (`from-default → via-muted → to-emphasis`) for the
        //   "polished metal" highlight midstop.
        // R13-PR11 evolved the active wash from a uniform
        //   `bg-[var(--brand-subtle)]` fill to a radial gradient
        //   from `--brand-secondary-subtle` fading right.
        //
        // This ratchet was missed in those evolutions — the
        // gradient regex required adjacent from + to with no via
        // between, and the wash regex required the uniform shape.
        // Both assertions are now relaxed to accept the R12 or
        // R13+ form; the load-bearing contracts (gradient + wash
        // + opacity transitions) stay locked.
        const navItem = codeOf(
            fs.readFileSync(
                path.resolve(ROOT, 'src/components/layout/nav-item.tsx'),
                'utf8',
            ),
        );
        // The brand-gradient band recipe — Tailwind utility form
        // (2-stop or 3-stop) OR R15-PR1 comprehensive arbitrary-
        // value form (which stacks stardust radial particles on
        // top of the linear gradient). Both preserve the
        // `--brand-default` / `--brand-emphasis` stops in order.
        const utilityForm =
            /before:bg-gradient-to-b/.test(navItem) &&
            /before:from-\[var\(--brand-default\)\]/.test(navItem) &&
            /before:to-\[var\(--brand-emphasis\)\]/.test(navItem);
        const arbitraryForm =
            /before:bg-\[[\s\S]*?linear-gradient\(to_bottom/.test(navItem) &&
            /before:bg-\[[\s\S]*?var\(--brand-default\)/.test(navItem) &&
            /before:bg-\[[\s\S]*?var\(--brand-emphasis\)/.test(navItem);
        expect(utilityForm || arbitraryForm).toBe(true);
        // 2026-05-19 — the hover-band reveal (`hover:before:opacity-100`)
        // was retired. The band stays as a permanent active-only
        // signal; hover state expresses itself via text-brighten,
        // gloss, bevel, liquid-sweep instead.
        expect(navItem).not.toMatch(/hover:before:opacity-100/);
        // Active: band stays visible (un-gated opacity-100).
        expect(navItem).toMatch(/(?<!hover:)\bbefore:opacity-100\b/);
        // Active: brand wash — uniform (R12-PR6) OR radial (R13-PR11).
        const activeRecipe =
            navItem.match(
                /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
            )?.[1] ?? '';
        const uniformWash = /\bbg-\[var\(--brand-subtle\)\]/.test(
            activeRecipe,
        );
        const radialWash =
            /bg-\[radial-gradient\(/.test(activeRecipe) &&
            /var\(--brand(-secondary)?-subtle\)/.test(activeRecipe);
        expect(uniformWash || radialWash).toBe(true);
        // Motion: transition-colors duration-150 (motion-language).
        expect(navItem).toMatch(/transition-colors\s+duration-150/);
    });
});
