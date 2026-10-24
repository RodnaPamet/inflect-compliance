import type { PermissionSet } from '@/lib/permissions';

/** Which of the Risks list's bulk actions a user can complete. */
export interface RiskBulkPermissions {
    /** Set status and assign owner. */
    canEdit: boolean;
    /** Delete (a soft, restorable delete). */
    canDelete: boolean;
}

/**
 * Each bulk route is gated twice, and an action is offered only when both
 * gates admit the user: the route's `requirePermission` key (granular, so a
 * custom role can grant it) and the usecase's coarse tier (the built-in
 * role's rung). A custom role can hold one without the other, and the
 * server then refuses the action, so offering it would only produce a
 * "bulk action failed" toast.
 *
 *   status / assign → `risks.edit`   + `assertCanWrite`
 *   delete          → `admin.manage` + `assertCanAdmin`
 */
export function riskBulkPermissions(ctx: {
    permissions: { canWrite: boolean; canAdmin: boolean };
    appPermissions: Pick<PermissionSet, 'risks' | 'admin'>;
}): RiskBulkPermissions {
    return {
        canEdit: ctx.permissions.canWrite && ctx.appPermissions.risks.edit,
        canDelete: ctx.permissions.canAdmin && ctx.appPermissions.admin.manage,
    };
}
