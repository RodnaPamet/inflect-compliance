/**
 * Links for in-app (bell) notifications about a tenant's pages.
 *
 * Every tenant page lives under `/t/<slug>/…`, and the bell renders a stored
 * `Notification.linkUrl` as-is. A sender that stores a bare `/policies/<id>`
 * therefore sends its reader to a 404 (#4128). The correct senders already
 * build the prefix — `task-due.ts` from a `tenant.slug` join, `agentic.ts` from
 * `ctx.tenantSlug` — and the senders here share that rule through these two
 * helpers, so the prefix is written in one place.
 *
 * Same fallback as `leaver.ts`: `RequestContext.tenantSlug` is OPTIONAL (a
 * system or job context usually has none), so the slug is looked up rather
 * than the link dropped for every unattended run. When no slug can be found at
 * all, the link is `null`, as `agentic.ts` does: a bell row that navigates
 * nowhere is better than one that 404s.
 */
import type { PrismaTx } from '@/lib/db-context';

/**
 * The tenant's slug for building a page link: `ctx.tenantSlug` when the
 * context carries one, otherwise a lookup by `ctx.tenantId`.
 */
export async function resolveTenantSlugForLinks(
    db: PrismaTx,
    ctx: { tenantId: string; tenantSlug?: string | null },
): Promise<string | null> {
    if (ctx.tenantSlug) return ctx.tenantSlug;
    const tenant = await db.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { slug: true },
    });
    return tenant?.slug ?? null;
}

/**
 * `/t/<slug><path>` for a tenant page path such as `/policies/<id>`, or `null`
 * when the slug is unknown.
 */
export function tenantPageLink(tenantSlug: string | null | undefined, path: string): string | null {
    if (!tenantSlug) return null;
    return `/t/${tenantSlug}${path.startsWith('/') ? path : `/${path}`}`;
}
