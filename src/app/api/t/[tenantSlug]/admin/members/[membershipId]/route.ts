import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import {
    updateTenantMemberRole,
    updateTenantMemberRoleAndCustomRole,
    removeTenantMember,
} from '@/app-layer/usecases/tenant-admin';
import { assignCustomRole } from '@/app-layer/usecases/custom-roles';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import {
    BUILT_IN_SCOPE_REFUSAL,
    MEMBER_ROLE_CHANGE_ROLES,
    builtInScopeRoleMessage,
    mayCarryCustomRole,
} from '@/lib/roles';

const UpdateMemberSchema = z
    .object({
        // The members-page role change's list: the writers' list plus AI_ADMIN
        // (#3699 deploy 2), which the usecase lets an OWNER alone assign.
        role: z.enum(MEMBER_ROLE_CHANGE_ROLES).optional(),
        // `null` clears. An empty string is neither a role id nor a clear, so
        // it is refused here rather than written.
        customRoleId: z.string().min(1).nullable().optional(),
    })
    // A body naming both halves is applied all or nothing (#4118). Asking for
    // a role that carries no custom role (OWNER, AI_ADMIN — `mayCarryCustomRole`)
    // AND a custom role in one body can never succeed, so it is refused here,
    // before the database. The other order is refused by the usecase: a role
    // change into OWNER or AI_ADMIN is refused while the member still carries a
    // custom role, so `{ role: 'OWNER', customRoleId: null }` for a member who
    // carries one commits nothing — the custom role is removed on its own
    // first (#3720).
    .superRefine((v, issue) => {
        if (v.role && !mayCarryCustomRole(v.role) && typeof v.customRoleId === 'string') {
            issue.addIssue({
                code: 'custom',
                path: ['customRoleId'],
                message: `${BUILT_IN_SCOPE_REFUSAL}: ${builtInScopeRoleMessage(v.role, 'assign-custom-role')}`,
            });
        }
    });

export const PATCH = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; membershipId: string }>(
        'admin.members',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json();
            const input = UpdateMemberSchema.parse(body);

            let result;

            if (input.role && input.customRoleId !== undefined) {
                // Both: every check of both halves before either write, so a
                // refused custom role leaves the role as it was (#4118).
                result = await updateTenantMemberRoleAndCustomRole(ctx, {
                    membershipId: params.membershipId,
                    role: input.role,
                    customRoleId: input.customRoleId,
                });
            } else if (input.role) {
                result = await updateTenantMemberRole(ctx, {
                    membershipId: params.membershipId,
                    role: input.role,
                });
            } else if (input.customRoleId !== undefined) {
                // `null` unassigns.
                result = await assignCustomRole(
                    ctx,
                    params.membershipId,
                    input.customRoleId,
                );
            }

            if (!result) {
                return jsonResponse(
                    { error: 'No changes specified' },
                    { status: 400 },
                );
            }

            return jsonResponse(result);
        },
    ),
);

// Hard-remove a member from the tenant (distinct from POST /deactivate).
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; membershipId: string }>(
        'admin.members',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await removeTenantMember(ctx, {
                membershipId: params.membershipId,
            });
            return jsonResponse(result);
        },
    ),
);
