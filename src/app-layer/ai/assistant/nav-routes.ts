/**
 * The routes the assistant is allowed to name (#3845).
 *
 * ═══ WHY A TABLE AND NOT THE MODEL'S MEMORY ═══
 *
 * An assistant that confidently describes a menu path that does not exist is
 * worse than one that stays silent: in a compliance product the user cannot
 * tell a wrong path from their own mistake, so they go looking for a screen
 * that was never there. The fix is not a better prompt — it is to remove the
 * model's opportunity to invent. The real route table goes INTO the prompt,
 * and anything the model names that is not in it is refused on the way out.
 *
 * ═══ WHY THIS IS A SECOND COPY, AND WHAT STOPS IT DRIFTING ═══
 *
 * The product's navigation lives in `useNavSections()`
 * (`src/components/layout/SidebarNav.tsx`), which is a React hook: it reads
 * tenant context, permissions, modules and the translation catalogue, so it
 * cannot be called from a server usecase that has no React tree. This module
 * is therefore a deliberate second copy of the route half of that definition.
 *
 * A second copy that drifts silently would be worse than no table at all —
 * it would authorise paths that no longer exist, which is exactly the failure
 * it exists to prevent. `tests/unit/ai/assistant-guidance-from-nav.test.ts`
 * renders `useNavSections()` and derives the expected set from IT, not from a
 * hand-written list, so adding, removing or renaming a nav route fails that
 * test until this table is updated. The nav definition stays the authority;
 * this is a projection of it that CI keeps honest.
 *
 * Paths are TENANT-RELATIVE — no `/t/<slug>` prefix. The prefix is the
 * client's to add (`useTenantHref`), and a table that carried a concrete slug
 * could not be shared between tenants.
 */

/**
 * Tenant-relative nav paths, as `useNavSections()` builds them.
 *
 * Sorted, so a diff against the nav definition reads as a set difference
 * rather than an ordering change.
 */
export const ASSISTANT_NAV_ROUTES: readonly string[] = Object.freeze([
    '/admin',
    '/agents',
    // #3870 — the asking surface. Listed because this table is asserted to
    // EQUAL the real nav in both directions, so a sidebar entry that is not
    // here is a divergence rather than an omission.
    '/agents/ask',
    '/assets',
    '/audits',
    '/calendar',
    '/controls',
    '/dashboard',
    '/evidence',
    '/policies',
    '/processes',
    '/reports',
    '/risks',
    '/tasks',
    '/tests',
    '/vendors',
]);

const ROUTE_SET: ReadonlySet<string> = new Set(ASSISTANT_NAV_ROUTES);

/**
 * Is this a route the assistant may describe or link to?
 *
 * Accepts a tenant-relative path, with or without a trailing slash, and with
 * or without a query string — a deep link carries filter state
 * (`/controls?evidence=missing`), and the filters are not part of the route's
 * existence. A `/t/<slug>` prefix is stripped first, because the caller may
 * hand us either shape and silently answering "unknown" for a real route
 * would make the assistant refuse to link to pages that do exist.
 *
 * Sub-paths are NOT accepted. `/controls/abc123` is a detail page whose
 * existence depends on the id resolving, and the assistant has no way to know
 * that from the nav table. Deep links to a filtered LIST are the cheap, safe
 * win; a fabricated detail URL is a 404 with the user's trust attached.
 */
export function isKnownAssistantRoute(path: string): boolean {
    const normalised = normaliseRoute(path);
    return normalised !== null && ROUTE_SET.has(normalised);
}

/**
 * Reduce a candidate to the bare route, or null when it is not a shape this
 * table can speak about at all.
 */
export function normaliseRoute(path: string): string | null {
    if (typeof path !== 'string') return null;

    let p = path.trim();
    if (p === '') return null;

    // An absolute URL is never a route in this table — it is somewhere else
    // entirely, and treating its pathname as ours would authorise
    // `https://evil.example/controls`.
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) return null;

    // Drop query and fragment: filter state does not change which page it is.
    p = p.split('?')[0].split('#')[0];

    // Strip a tenant prefix if the caller passed a built href.
    const tenantPrefix = /^\/t\/[^/]+/;
    p = p.replace(tenantPrefix, '');

    if (!p.startsWith('/')) p = `/${p}`;
    // Collapse a trailing slash, but keep the root as '/'.
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

    return p;
}

/**
 * The route table as prompt text.
 *
 * One route per line and nothing else — no descriptions, because a
 * description is a second place for the model to read intent from and the
 * labels are localised anyway (so an English gloss would be wrong in half the
 * product). The instruction that these are the ONLY nameable routes belongs
 * with the rest of the system prompt, not repeated here.
 */
export function routeTableForPrompt(): string {
    return ASSISTANT_NAV_ROUTES.join('\n');
}

/**
 * The nav-level route a path belongs to: `/controls/abc123` → `/controls`.
 *
 * Needed because `isKnownAssistantRoute` deliberately rejects sub-paths, and
 * the page the user is actually ON is very often a detail page. Dropping the
 * page context in that case would remove it exactly when it is most useful —
 * "which of THESE has no evidence" is asked from a list or a record, not from
 * the dashboard. So the context reports the nav route it sits under, which the
 * table CAN vouch for, without claiming the detail URL is nameable.
 *
 * Returns null when the first segment is not a nav route at all.
 */
export function baseRouteOf(path: string): string | null {
    const normalised = normaliseRoute(path);
    if (normalised === null || normalised === '/') return null;

    const first = `/${normalised.split('/')[1] ?? ''}`;
    return ROUTE_SET.has(first) ? first : null;
}
