/**
 * Which way-back a phone shows on a page: the back link, or the breadcrumbs.
 *
 * Below `md` the top chrome hides its breadcrumbs, so a page used to render
 * its trail inline AND a back link to the same parent — two lines of a small
 * screen for one destination, in an order that changed from page to page
 * (breadcrumbs above the back link on some pages, below it on others).
 *
 * The rule now: on a SUBPAGE that carries a back affordance, a phone shows the
 * back link and nothing else. The inline breadcrumbs collapse into it. Every
 * subpage mounts its back link first, above the title, so it sits in the same
 * place on every one of them. Desktop is untouched: its breadcrumbs live in
 * the top chrome, which this does not reach.
 *
 * MAIN pages keep their inline breadcrumbs (they have no back link), and so do
 * the subpages exempt from the back affordance (`BACK_AFFORDANCE_EXEMPT_SUBPAGES`
 * — redirect shims, forced flows, and the two test sub-pages whose parent
 * navigation IS the breadcrumb trail). Collapsing their breadcrumbs would
 * leave them with no way back at all.
 *
 * Pure, and keyed on the pathname, so the server and client renders agree.
 */
import {
    BACK_AFFORDANCE_EXEMPT_SUBPAGES,
    classifyRoute,
    normalizePathname,
} from './page-segregation';

/**
 * True when a phone should show ONLY the back link on `pathname` — i.e. the
 * page's inline (mobile) breadcrumbs must not render.
 */
export function phoneShowsBackLinkOnly(pathname: string): boolean {
    if (classifyRoute(pathname) !== 'subpage') return false;
    const pattern = normalizePathname(pathname);
    if (!pattern) return false;
    return !(BACK_AFFORDANCE_EXEMPT_SUBPAGES as readonly string[]).includes(
        pattern,
    );
}
