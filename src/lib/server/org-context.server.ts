/**
 * Server-side org context resolver — Epic O-4.
 *
 * Mirror of `getTenantServerContext` for the hub-and-spoke org layer.
 * Returns a plain serializable shape that flows from the server
 * `org/[orgSlug]/layout.tsx` into the client `OrgProvider` without
 * dragging Prisma model internals across the server-client boundary.
 *
 * ## Anti-enumeration policy
 *
 * Both "this org slug doesn't exist" AND "you have no membership in
 * this org" throw `NotFoundError` with the same generic message that
 * does NOT echo the slug. The layout's try/catch routes both to
 * `notFound()`. A non-member cannot tell whether an org exists by
 * visiting `/org/<slug>` — same external surface as the API-side
 * `getOrgCtx`.
 *
 * Internal observability is preserved via a structured `org-ctx` log
 * line (level=warn) carrying a `reason` field (`org_not_found` vs
 * `not_a_member`). Operators reading the application logs see the
 * real cause; external callers only see 404.
 */

import prisma from '@/lib/prisma';
import { getOrgPermissions, type OrgPermissionSet } from '@/lib/permissions';
import { NotFoundError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import type { OrgRole } from '@prisma/client';

export interface OrgServerContext {
    organization: {
        id: string;
        slug: string;
        name: string;
    };
    role: OrgRole;
    permissions: OrgPermissionSet;
}

export async function getOrgServerContext(params: {
    orgSlug: string;
    userId: string;
    /**
     * The session's single-sign-on scope (`session.user.ssoTenantId`).
     * Required so no caller can forget it: `null` for a session that did not
     * come from SSO.
     */
    ssoTenantId: string | null | undefined;
}): Promise<OrgServerContext> {
    const slug = params.orgSlug.trim();
    if (!slug) {
        throw new NotFoundError('Organization not found or access not permitted');
    }

    // A single-sign-on session vouches for one tenant, never for an
    // organization above it — see `src/lib/auth/sso-session.ts`.
    if (params.ssoTenantId != null) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            surface: 'server',
            reason: 'sso_scoped_session',
            orgSlug: slug,
            userId: params.userId,
        });
        throw new NotFoundError('Organization not found or access not permitted');
    }

    // Generic external message — same string for both "no such org"
    // and "not a member". The internal log line carries the real
    // reason for ops diagnostics.
    const externalNotFound = () =>
        new NotFoundError('Organization not found or access not permitted');

    const org = await prisma.organization.findUnique({
        where: { slug },
        select: { id: true, slug: true, name: true },
    });
    if (!org) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            surface: 'server',
            reason: 'org_not_found',
            orgSlug: slug,
            userId: params.userId,
        });
        throw externalNotFound();
    }

    const membership = await prisma.orgMembership.findUnique({
        where: {
            organizationId_userId: {
                organizationId: org.id,
                userId: params.userId,
            },
        },
        select: { role: true },
    });
    if (!membership) {
        logger.warn('org-ctx.access_denied', {
            component: 'org-ctx',
            surface: 'server',
            reason: 'not_a_member',
            orgSlug: slug,
            organizationId: org.id,
            userId: params.userId,
        });
        throw externalNotFound();
    }

    return {
        organization: org,
        role: membership.role,
        permissions: getOrgPermissions(membership.role),
    };
}
