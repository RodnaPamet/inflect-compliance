/**
 * Who may do what with audit cycles, packs, share links and auditors — the ONE
 * place both sides read.
 *
 * The audit-readiness policies (`src/app-layer/policies/audit-readiness.policies.ts`)
 * gate on the BUILT-IN role (`ctx.role`), not on a permission key. The pages
 * used to gate on `audits.manage` / `audits.share`, which hold different
 * populations: `audits.manage` is OWNER + ADMIN, so an Editor could not see
 * controls the server allowed them, and `audits.share` is held by AUDITOR, so
 * an Auditor saw share, resolve and create-finding buttons that always failed.
 * The policies now read these predicates, and the pages read them through
 * `auditReadinessAccess`, so the two cannot drift apart again.
 *
 * Pure and client-safe: no server import, a type-only import of the role enum.
 */
import type { Role } from '@prisma/client';
import type { PermissionSet } from '@/lib/permissions';

/** Create a cycle, change its status. */
export const AUDIT_CYCLE_WRITER_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'EDITOR'];
/** Create a pack, add or remove a draft pack's items, clone a frozen pack. */
export const AUDIT_PACK_WRITER_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'EDITOR'];
/** Freeze a pack (and assemble the reliance pack, which freezes one). */
export const AUDIT_PACK_FREEZER_ROLES: readonly Role[] = ['OWNER', 'ADMIN'];
/** Create, list and revoke share links; act on an auditor's messages. */
export const AUDIT_PACK_SHARER_ROLES: readonly Role[] = ['OWNER', 'ADMIN'];
/** List, invite and revoke named auditors and their pack grants. */
export const AUDITOR_MANAGER_ROLES: readonly Role[] = ['OWNER', 'ADMIN'];

const holds = (roles: readonly Role[], role: string): boolean => (roles as readonly string[]).includes(role);

export const mayManageAuditCycles = (role: string): boolean => holds(AUDIT_CYCLE_WRITER_ROLES, role);
export const mayManageAuditPacks = (role: string): boolean => holds(AUDIT_PACK_WRITER_ROLES, role);
export const mayFreezeAuditPacks = (role: string): boolean => holds(AUDIT_PACK_FREEZER_ROLES, role);
export const mayShareAuditPacks = (role: string): boolean => holds(AUDIT_PACK_SHARER_ROLES, role);
export const mayManageAuditors = (role: string): boolean => holds(AUDITOR_MANAGER_ROLES, role);

/** What the audits pages may offer this viewer. Every flag is something the server allows. */
export interface AuditReadinessAccess {
    /** The Cycle button, the empty state's add action, the status picker. */
    readonly manageCycles: boolean;
    /** The Pack button, Add items, item removal, Clone for retest. */
    readonly managePacks: boolean;
    /** Freeze pack. */
    readonly freezePacks: boolean;
    /** Generate share link, the share-link list, Revoke link, Resolve, Create finding. */
    readonly sharePacks: boolean;
    /** The auditor list and Invite auditor. */
    readonly manageAuditors: boolean;
    /**
     * Grant and revoke an auditor's pack access, revoke an auditor's account.
     * Those routes also take `admin.manage` (`route-permissions.ts`).
     */
    readonly changeAuditorAccess: boolean;
    /**
     * The reliance pack. Its route takes `audits.manage` AND `admin.manage`,
     * and the usecase then asks the freeze role.
     */
    readonly assembleReliancePack: boolean;
}

export function auditReadinessAccess(viewer: {
    readonly role: string;
    readonly appPermissions: Pick<PermissionSet, 'audits' | 'admin'>;
}): AuditReadinessAccess {
    const { role, appPermissions } = viewer;
    const adminManage = appPermissions.admin.manage === true;
    return {
        manageCycles: mayManageAuditCycles(role),
        managePacks: mayManageAuditPacks(role),
        freezePacks: mayFreezeAuditPacks(role),
        sharePacks: mayShareAuditPacks(role),
        manageAuditors: mayManageAuditors(role),
        changeAuditorAccess: mayManageAuditors(role) && adminManage,
        assembleReliancePack:
            mayFreezeAuditPacks(role) && appPermissions.audits.manage === true && adminManage,
    };
}
