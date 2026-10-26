import type { PermissionSet } from '@/lib/permissions';

/**
 * The most risks one bulk request may name. The status, assign and delete
 * schemas (`BulkRisk*Schema` in `src/lib/schemas/index.ts`) refuse more, with
 * a validation message that means nothing on screen, so the list stops a
 * larger selection before it is sent. A unit test holds the two in step.
 */
export const RISK_BULK_MAX = 100;

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

/**
 * Whether the user can create risks: the list's button, the import page,
 * the empty register's button on the list, the dashboard and the board, and
 * AI Assist (the list's panel and the `/risks/ai` page). Every way in is gated
 * twice, like the bulk actions: the create, import and AI generate / apply
 * routes check `risks.create`, and `createRisk` / `bulkImportRisks` /
 * `generateRiskSuggestions` / `applySession` assert the coarse write tier. A
 * custom role can hold one without the other, so the page used to offer
 * Create on the tier alone and the server then refused it.
 */
export function riskCanCreate(ctx: {
    permissions: { canWrite: boolean };
    appPermissions: Pick<PermissionSet, 'risks'>;
}): boolean {
    return ctx.permissions.canWrite && ctx.appPermissions.risks.create;
}
