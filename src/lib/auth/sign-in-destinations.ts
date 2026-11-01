/**
 * Where a signed-in person can go (#4690).
 *
 * Read by the workspace picker (`/tenants`) and by `/no-tenant`. Both used
 * to read ACTIVE tenant memberships only, so:
 *   - a member of an organisation with no workspace membership (an
 *     ORG_READER, or the admin of an organisation with no workspaces yet)
 *     was sent to "No access yet" with no way to reach the organisation;
 *   - a deactivated member was told to ask for an invitation, when what they
 *     need is to be reactivated.
 *
 * Read from the database, not the JWT, for the reason the picker gives: the
 * JWT's lists are capped, and these pages must see every row.
 *
 * A single-sign-on session reaches only the workspace that opened it and no
 * organisation (`src/lib/auth/sso-session.ts`), so for one this returns that
 * workspace and nothing else.
 *
 * A workspace whose Microsoft Entra ID group gate refused this sign-in is not
 * a destination for the session (#4869, `src/lib/auth/entra-gate-scope.ts`):
 * it is named in `entraRefusedWorkspaces` instead, so the page can say why.
 */
import prisma from '@/lib/prisma';
import type { Role } from '@prisma/client';

export interface WorkspaceDestination {
    slug: string;
    name: string;
    role: Role;
}

export interface OrganizationDestination {
    slug: string;
    name: string;
}

export interface SignInDestinations {
    workspaces: WorkspaceDestination[];
    organizations: OrganizationDestination[];
    /** Names of the workspaces where the person's membership is DEACTIVATED. */
    deactivatedWorkspaces: string[];
    /** Names of the workspaces the Entra group gate refused this sign-in. */
    entraRefusedWorkspaces: string[];
}

export async function readSignInDestinations(
    userId: string,
    ssoTenantId: string | null | undefined,
    entraGateDeniedTenantIds: readonly string[] | null | undefined = [],
): Promise<SignInDestinations> {
    const entraDenied = new Set(entraGateDeniedTenantIds ?? []);
    const ssoScope = ssoTenantId != null ? { tenantId: ssoTenantId } : {};
    const [active, deactivated, orgs] = await Promise.all([
        prisma.tenantMembership.findMany({
            where: { userId, status: 'ACTIVE', tenant: { deletedAt: null }, ...ssoScope },
            orderBy: { createdAt: 'asc' },
            // No `take`: the picker lists every workspace the person holds.
            include: { tenant: { select: { id: true, slug: true, name: true } } },
        }),
        prisma.tenantMembership.findMany({
            where: { userId, status: 'DEACTIVATED', tenant: { deletedAt: null }, ...ssoScope },
            orderBy: { createdAt: 'asc' },
            take: 20,
            include: { tenant: { select: { name: true } } },
        }),
        ssoTenantId != null
            ? Promise.resolve([])
            : prisma.orgMembership.findMany({
                  where: { userId },
                  orderBy: { createdAt: 'asc' },
                  take: 100,
                  include: { organization: { select: { slug: true, name: true } } },
              }),
    ]);
    return {
        workspaces: active
            .filter((m) => !entraDenied.has(m.tenant.id))
            .map((m) => ({ slug: m.tenant.slug, name: m.tenant.name, role: m.role })),
        entraRefusedWorkspaces: active.filter((m) => entraDenied.has(m.tenant.id)).map((m) => m.tenant.name),
        organizations: orgs.map((m) => ({ slug: m.organization.slug, name: m.organization.name })),
        deactivatedWorkspaces: deactivated.map((m) => m.tenant.name),
    };
}

/**
 * Where to send the person without showing the picker, or null to show it.
 *
 * One workspace goes straight to it, as it always has, organisations or not:
 * an organisation admin is given a membership in each of its workspaces, and
 * a picker on every sign-in would be a new step for all of them. With no
 * workspace, one organisation goes straight to it and none at all is
 * `/no-tenant`.
 */
export function directDestination(d: Pick<SignInDestinations, 'workspaces' | 'organizations'>): string | null {
    if (d.workspaces.length === 1) return `/t/${d.workspaces[0].slug}/dashboard`;
    if (d.workspaces.length > 1) return null;
    if (d.organizations.length === 1) return `/org/${d.organizations[0].slug}`;
    if (d.organizations.length === 0) return '/no-tenant';
    return null;
}
