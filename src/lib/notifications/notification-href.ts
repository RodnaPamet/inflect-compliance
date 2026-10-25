/**
 * Where a bell notification's stored `linkUrl` should navigate.
 *
 * Client-safe (no server imports): the notifications bell calls it at render.
 *
 * Until #4128 several senders stored a tenant page path WITHOUT the `/t/<slug>`
 * prefix every tenant page lives under, so those rows 404 when clicked. The
 * senders now build the prefix (`src/app-layer/notifications/tenant-link.ts`),
 * but rows already written keep the old link. This resolves such a stored link
 * against the workspace the reader is CURRENTLY in.
 *
 * Only the exact path shapes those senders wrote count — nothing else is
 * rewritten:
 *
 *   - `/policies/…`                  policy acknowledgement request, and the
 *                                    re-acknowledgement after publish/rollback
 *   - `/evidence`                    evidence approved / rejected
 *   - `/framework-updates`           framework version update
 *   - `/vendors/…`                   vendor review due, vendor posture alert
 *   - `/audits/nis2-gap/respond/…`   NIS2 gap-assessment assignment
 *
 * A prefix matches only on a path-segment boundary (`/evidence` and
 * `/evidence?x` count; `/evidence-x` does not). Absolute `http(s)` links (an
 * automation rule's link must be a full URL), protocol-relative `//…` links,
 * `/t/…`, `/org/…` and every other route are returned unchanged, as is every
 * link when there is no current workspace (the org chrome).
 */
export const LEGACY_TENANT_RELATIVE_LINK_PREFIXES = [
    '/policies',
    '/evidence',
    '/framework-updates',
    '/vendors',
    '/audits/nis2-gap/respond',
] as const;

function startsWithSegment(path: string, prefix: string): boolean {
    if (!path.startsWith(prefix)) return false;
    const next = path.charAt(prefix.length);
    return next === '' || next === '/' || next === '?' || next === '#';
}

export function resolveNotificationHref(
    linkUrl: string,
    currentTenantSlug: string | null | undefined,
): string {
    if (!currentTenantSlug) return linkUrl;
    const isLegacyTenantPath = LEGACY_TENANT_RELATIVE_LINK_PREFIXES.some((p) =>
        startsWithSegment(linkUrl, p),
    );
    return isLegacyTenantPath ? `/t/${currentTenantSlug}${linkUrl}` : linkUrl;
}
