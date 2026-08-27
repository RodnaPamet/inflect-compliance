/**
 * Epic O-2 — organization members.
 *
 *   POST /api/org/[orgSlug]/members
 *     add an ORG_ADMIN or ORG_READER. ORG_ADMIN add triggers fan-out
 *     of ADMIN memberships into every existing org tenant.
 *
 *   PUT /api/org/[orgSlug]/members
 *     change an existing member's role atomically. READER→ADMIN
 *     triggers tenant fan-out, ADMIN→READER triggers fan-in of only
 *     the org-tagged auto-provisioned rows. Same-role transitions
 *     are a no-op. Last-ORG_ADMIN guard refuses to demote the only
 *     remaining admin.
 *
 *   DELETE /api/org/[orgSlug]/members?userId=...
 *     remove a member. ORG_ADMIN remove triggers fan-in of the
 *     auto-provisioned ADMIN memberships (only those tagged with
 *     this org's id; manual memberships are preserved). Last-
 *     ORG_ADMIN guard refuses to orphan the org.
 *
 * All three gated by `canManageMembers` (ORG_ADMIN only).
 */
import { NextRequest, NextResponse } from 'next/server';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { withValidatedBody } from '@/lib/validation/route';
import {
    AddOrgMemberInput,
    ChangeOrgMemberRoleInput,
} from '@/app-layer/schemas/organization.schemas';
import {
    addOrgMember,
    changeOrgMemberRole,
    removeOrgMember,
} from '@/app-layer/usecases/org-members';
import { badRequest, forbidden } from '@/lib/errors/types';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

export const POST = withApiErrorHandling(
    withValidatedBody(
        AddOrgMemberInput,
        async (req: NextRequest, routeCtx: RouteContext, body) => {
            const ctx = await getOrgCtx((await routeCtx.params), req);
            if (!ctx.permissions.canManageMembers) {
                throw forbidden('You do not have permission to manage members of this organization');
            }

            const result = await addOrgMember(ctx, {
                userEmail: body.userEmail,
                role: body.role,
            });

            return NextResponse.json(
                {
                    membership: result.membership,
                    user: result.user,
                    provisioned: result.provision
                        ? {
                              created: result.provision.created,
                              skipped: result.provision.skipped,
                              totalConsidered: result.provision.totalConsidered,
                          }
                        : null,
                },
                { status: 201 },
            );
        },
    ),
);

export const PUT = withApiErrorHandling(
    withValidatedBody(
        ChangeOrgMemberRoleInput,
        async (req: NextRequest, routeCtx: RouteContext, body) => {
            const ctx = await getOrgCtx((await routeCtx.params), req);
            if (!ctx.permissions.canManageMembers) {
                throw forbidden('You do not have permission to manage members of this organization');
            }

            const result = await changeOrgMemberRole(ctx, {
                userId: body.userId,
                role: body.role,
            });

            return NextResponse.json({
                membership: result.membership,
                transition: result.transition,
                provisioned: result.provision
                    ? {
                          created: result.provision.created,
                          skipped: result.provision.skipped,
                          totalConsidered: result.provision.totalConsidered,
                      }
                    : null,
                deprovisioned: result.deprovision
                    ? {
                          deleted: result.deprovision.deleted,
                          tenantIds: result.deprovision.tenantIds,
                      }
                    : null,
            });
        },
    ),
);

type DeleteParams = { orgSlug: string };

/**
 * Gated on `canManageMembers`. The inline check this replaces recorded nothing
 * on refusal; the gate writes an `ORG_AUTHZ_DENIED` row (#2147).
 *
 * `removeOrgMember` gained `assertCanManageOrgMembers` in the same diff, so
 * this is additive rather than relocating the only check.
 *
 * POST and PUT keep their inline checks: they are not destructive verbs, and
 * migrating them raises the same `withValidatedBody` composition question
 * deferred on the tenant side.
 */
export const DELETE = withApiErrorHandling(
    requireOrgPermission<DeleteParams>('canManageMembers', async (req, _args, ctx) => {
        const userId = req.nextUrl.searchParams.get('userId');
        if (!userId) {
            throw badRequest('Missing userId query parameter');
        }

        const result = await removeOrgMember(ctx, { userId });

        return NextResponse.json({
            deleted: true,
            wasOrgAdmin: result.wasOrgAdmin,
            deprovisioned: result.deprovision
                ? {
                      deleted: result.deprovision.deleted,
                      tenantIds: result.deprovision.tenantIds,
                  }
                : null,
        });
    }),
);
