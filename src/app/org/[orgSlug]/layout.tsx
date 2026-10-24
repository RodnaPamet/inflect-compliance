import { notFound, redirect } from 'next/navigation';
import { unstable_noStore as noStore } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getOrgServerContext } from '@/lib/server/org-context.server';
import { OrgProvider } from '@/lib/org-context-provider';
import { AppShell } from '@/components/layout/AppShell';
import { ClientProviders } from '@/components/layout/ClientProviders';

/**
 * Epic O-4 — organization-scoped layout.
 *
 * Two-stage resolution (mirrors the tenant layout pair at
 * `src/app/t/[tenantSlug]/layout.tsx` + `…/(app)/layout.tsx`,
 * collapsed into one because the org tree doesn't need a separate
 * (app) route group yet):
 *
 *   1. `auth()` — resolve the NextAuth session. Middleware should
 *      have caught unauthenticated requests already, but redirect to
 *      `/login` here too as a defence-in-depth gate (the tenant layout
 *      pattern does the same).
 *
 *   2. `getOrgServerContext({ orgSlug, userId, ssoTenantId })` — verifies the user
 *      has an `OrgMembership` for this org. Throws `NotFoundError`
 *      (org slug doesn't exist) or `ForbiddenError` (user isn't a
 *      member). Both collapse to `notFound()` here so non-members get
 *      the standard 404 surface — same anti-enumeration posture as
 *      the API-layer `getOrgCtx`.
 *
 * `noStore()` + `dynamic = 'force-dynamic'` guarantee per-request
 * freshness so an admin's permission state never leaks to a reader
 * via a stale cache (same rationale as the tenant layout).
 */
export const dynamic = 'force-dynamic';

export default async function OrgLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ orgSlug: string }>;
}) {
    noStore();

    const { orgSlug } = await params;

    const session = await auth();
    if (!session?.user?.id) {
        redirect('/login');
    }

    let orgCtx;
    try {
        orgCtx = await getOrgServerContext({
            orgSlug,
            userId: session.user.id,
            ssoTenantId: session.user.ssoTenantId,
        });
    } catch {
        // NotFoundError | ForbiddenError both → standard 404 surface.
        // Anti-enumeration: a non-member sees the same 404 as a
        // missing slug.
        notFound();
    }

    const tc = await getTranslations('common');

    return (
        <OrgProvider
            value={{
                organizationId: orgCtx.organization.id,
                orgSlug: orgCtx.organization.slug,
                orgName: orgCtx.organization.name,
                role: orgCtx.role,
                permissions: orgCtx.permissions,
            }}
        >
            <AppShell
                variant="org"
                user={{
                    name: session.user.name,
                    email: session.user.email,
                    image: session.user.image,
                    memberships: session.user.memberships,
                }}
                appName={tc('appName')}
            >
                <ClientProviders>{children}</ClientProviders>
            </AppShell>
        </OrgProvider>
    );
}
