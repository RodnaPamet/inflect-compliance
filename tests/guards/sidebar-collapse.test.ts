/**
 * Sidebar collapse (icon-rail) ratchet.
 *
 * The desktop sidebar collapses to a 56px icon rail via a persisted toggle.
 * Locks the wiring so a refactor can't silently drop it:
 *   - a collapse context broadcasts the flag to the nav primitives,
 *   - NavItem hides its label + tooltips it when collapsed,
 *   - AppShellFrame persists the state and drives the aside width, and
 *     AppShell provides the context (false for the mobile drawer),
 *   - both sidebars render the toggle.
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
import { uiStorageKey } from '@/lib/ui-storage';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('sidebar collapse / icon rail', () => {
    it('the collapse context exists', () => {
        expect(exists('src/components/layout/sidebar-collapse-context.tsx')).toBe(true);
        const ctx = read('src/components/layout/sidebar-collapse-context.tsx');
        expect(ctx).toMatch(/export function SidebarCollapseProvider/);
        expect(ctx).toMatch(/export function useSidebarCollapsed/);
    });

    it('NavItem collapses to an icon + tooltip', () => {
        const src = read('src/components/layout/nav-item.tsx');
        expect(src).toMatch(/useSidebarCollapsed/);
        // label is conditional on NOT collapsed; collapsed wraps in a Tooltip.
        expect(src).toMatch(/!collapsed &&[\s\S]*?\{label\}/);
        expect(src).toMatch(/<Tooltip content=\{label\} side="right">/);
    });

    // T07 (#3076) split this in two, because the wiring did. `AppShellFrame`
    // now owns the persisted state and the rail width; `AppShell` owns the
    // context it broadcasts. Both halves are still asserted — a refactor that
    // dropped either would redden one of these, which is what the file's
    // header promises.
    it('AppShellFrame persists the state and drives the aside width', () => {
        const src = read('src/components/layout/AppShellFrame.tsx');
        // Through the T01 seam rather than a spelled-out literal, so a
        // vendoring product changes one constant.
        expect(src).toMatch(/useLocalStorage\(/);
        expect(src).toMatch(/uiStorageKey\(\s*['"]sidebar-collapsed['"]\s*\)/);
        // collapsed → narrow rail (w-14), expanded → thinner sidebar (180px).
        expect(src).toMatch(/md:w-14/);
        expect(src).toMatch(/md:w-\[180px\]/);
    });

    it('keeps the persisted key BYTE-IDENTICAL across the seam move', () => {
        // The guard used to pin the literal `inflect:sidebar-collapsed`. Moving
        // to `uiStorageKey('sidebar-collapsed')` is only safe if it produces
        // the same string: a changed key is not a migration, it is a silent
        // reset of every user's collapse preference. Asserted on the VALUE, so
        // a future change to the prefix or the join character fails here.
        expect(uiStorageKey('sidebar-collapsed')).toBe('inflect:sidebar-collapsed');
    });

    it('AppShell provides the context, and never collapses the mobile drawer', () => {
        const src = read('src/components/layout/AppShell.tsx');
        expect(src).toMatch(/SidebarCollapseProvider/);
        // mobile drawer is never collapsed.
        expect(src).toMatch(/SidebarCollapseProvider collapsed=\{false\}/);
    });

    it('both sidebars render the collapse toggle', () => {
        for (const f of ['SidebarNav.tsx', 'OrgSidebarNav.tsx']) {
            const src = read(`src/components/layout/${f}`);
            expect(src).toMatch(/onToggleCollapse/);
            expect(src).toMatch(/data-testid="sidebar-collapse-toggle"/);
            // The collapse toggle's icon is either the `Menu` hamburger (main
            // app sidebar — the toggle now lives in the brand/logo slot above
            // "Board") or the `PanelLeft*` chevrons (org sidebar, whose brand
            // slot is the load-bearing org switcher).
            expect(src).toMatch(/Menu|PanelLeftOpen|PanelLeftClose/);
        }
    });
});
