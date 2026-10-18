import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { updateTenantMemberRole, removeTenantMember } from '@/app-layer/usecases/tenant-admin';
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
        customRoleId: z.string().nullable().optional(),
    })
    // The two halves below run as separate writes, role first. Asking for a
    // role that carries no custom role AND a custom role in one body would
    // commit the first and refuse the second; refuse the body instead.
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

            // If role change requested, update enum role
            if (input.role) {
                result = await updateTenantMemberRole(ctx, {
                    membershipId: params.membershipId,
                    role: input.role,
                });
            }

            // If customRoleId change requested (even if null = unassign)
            if (input.customRoleId !== undefined) {
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
