/**
 * Roadmap-2 PR-2 — top-chrome discipline (PR-11 simplification).
 *
 * The chrome is the load-bearing premium-feel surface added in
 * this roadmap pass. Three things must remain true for the
 * affordance to keep working as the codebase evolves:
 *
 *   1. The shell mounts the chrome AND wraps its children in the
 *      breadcrumbs provider. Without the provider the
 *      `useBreadcrumbs` hook falls back to a silent no-op and the
 *      chrome renders an empty trail forever.
 *   2. The chrome mounts both canonical regions: breadcrumbs
 *      (left) + identity pill (right). The center search-anchor
 *      was retired in PR-11 — the sidebar's inline command opener
 *      (PR-3) is the canonical search affordance. A future PR
 *      that removes EITHER remaining region collapses the
 *      chrome's contract — ratchet fails so the diff is loud.
 *   3. `<PageHeader>` pushes its breadcrumbs into the context.
 *      Removing this call (e.g. "let pages call useBreadcrumbs
 *      directly") would silently break every existing page that
 *      passes breadcrumbs to the page header.
 *
 * What this ratchet does NOT police
 *   The unauth/print surfaces (login, error, no-tenant, not-found,
 *   SoAPrintView) intentionally render outside `<AppShell>` and
 *   therefore have no chrome. They never call `useBreadcrumbs`
 *   either, so the context's silent no-op is the desired
 *   behaviour there.
 */
import * as fs from 'fs';
import { codeOf } from '../helpers/source-blocks';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
// #2629 — every read below goes through `codeOf`, which masks comments.
// Without it a guard can be satisfied by the COMMENT that records a
// component's removal: this file asserted `/OrgIdentityPill/` while that
// name survived in TopChrome only at two comments, one reading "retired in
// favour of OrgWorkspaceSwitcher". It was green BECAUSE its subject was
// gone. Anchoring on `<Name` is NOT sufficient on its own — comments here
// routinely write JSX inline ("now mounts <OrgWorkspaceSwitcher>"), which a
// mutation proved still satisfies the stricter pattern.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

describe('Top-chrome discipline (Roadmap-2 PR-2)', () => {
    it('AppShell mounts <TopChrome> and wraps children in <BreadcrumbsProvider>', () => {
        const src = read('src/components/layout/AppShell.tsx');
        expect(src).toMatch(/from\s+['"]\.\/breadcrumbs-store['"]/);
        expect(src).toMatch(/from\s+['"]\.\/TopChrome['"]/);
        expect(src).toMatch(/<BreadcrumbsProvider>/);
        expect(src).toMatch(/<TopChrome\b/);
    });

    it('TopChrome renders breadcrumbs + identity affordance', () => {
        const src = read('src/components/layout/TopChrome.tsx');
        // Each region is owned by a named component or a direct
        // `<Breadcrumbs>` mount. The ratchet binds to the names
        // not the layout, so a future visual refactor can move
        // them around without breaking the contract.
        expect(src).toMatch(/<Breadcrumbs\b/);
        // R14-PR4 evolved the tenant variant from the passive
        // `TenantIdentityPill` (R2) to the popover-driven
        // `TenantSwitcher`; either MOUNT satisfies the tenant side.
        const hasTenantAffordance =
            /<TenantIdentityPill\b/.test(src) || /<TenantSwitcher\b/.test(src);
        expect(hasTenantAffordance).toBe(true);
        // PR-2 retired OrgIdentityPill; the org variant mounts this instead.
        expect(src).toMatch(/<OrgWorkspaceSwitcher\b/);
    });

    it('TopChrome does not import the retired R2 SearchAnchor module', () => {
        // R2-PR11 retired the original center search-anchor (a
        // separate `<SearchAnchor>` component in
        // `src/components/layout/SearchAnchor.tsx`). R14-PR6
        // resurrects a search affordance as `<SearchAnchor>` from
        // `./search-anchor` (lowercase-dash filename, different
        // implementation — opens the global command palette).
        //
        // This assertion locks the FILE PATH of the retired
        // module: a future import from `./SearchAnchor` (uppercase
        // filename) would be the R2 regression we caught originally.
        // The R14 path `./search-anchor` is allowed.
        const src = read('src/components/layout/TopChrome.tsx');
        expect(src).not.toMatch(
            /from\s+['"]\.\/SearchAnchor['"]/,
        );
    });

    it('breadcrumbs-store exports the provider + hook + reader', () => {
        const src = read('src/components/layout/breadcrumbs-store.tsx');
        expect(src).toMatch(/export function BreadcrumbsProvider/);
        expect(src).toMatch(/export function useBreadcrumbs/);
        expect(src).toMatch(/export function useCurrentBreadcrumbs/);
    });

    it('PageHeader pushes breadcrumbs into the chrome context', () => {
        const src = read('src/components/layout/PageHeader.tsx');
        expect(src).toMatch(
            /from\s+['"]@\/components\/layout\/breadcrumbs-store['"]/,
        );
        // The hook must be called inside the component body —
        // exact-call match instead of a string scan keeps "import
        // but never call" from passing.
        expect(src).toMatch(/useBreadcrumbs\s*\(/);
    });

    it('TopChrome no longer renders a parallel mobile-only top bar (R14-PR12)', () => {
        // R14-PR12 unified the chrome — the pre-R14 `<AppShell>`
        // rendered a SEPARATE mobile-only top bar with its own
        // hamburger + wordmark + theme toggle. That bar is GONE;
        // the NavBar (mounted by TopChrome) is the single chrome
        // surface across mobile + desktop. AppShell should no
        // longer contain a mobile-only `<header>` or sticky-top
        // hamburger row.
        const src = read('src/components/layout/AppShell.tsx');
        // The retired mobile bar had `md:hidden sticky top-0`
        // on a top-level div. A regression that re-introduces it
        // would re-stack two bars on mobile.
        expect(src).not.toMatch(/md:hidden\s+sticky\s+top-0/);
    });
});
