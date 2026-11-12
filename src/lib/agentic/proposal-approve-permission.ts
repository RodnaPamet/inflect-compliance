/**
 * The permission a proposal KIND's approval needs on top of the queue's own
 * gate, and whether a viewer holds it (#5053).
 *
 * Approving a proposal runs the real create usecase as the approver, so the
 * approver must be allowed to make the record. For the four record kinds that
 * is the role-tier write `approveAgentProposal` already asserts. A process map
 * is created through `processes.edit`, the key both human process-map routes
 * take, and a custom role can withhold it on a write-capable base: without
 * this the approver could create, through the queue, a map REST would refuse
 * them (owner decision, 2026-11-11).
 *
 * ONE TABLE, read twice: `approveAgentProposal` asserts the key (an audited
 * `AUTHZ_DENIED` on refusal, before the signature and the claim), and the two
 * review surfaces ask `viewerMayApproveProposal` on the server and offer
 * Approve only where the approval would be taken. Never compute the second
 * from a role in a page.
 */
import type { PermissionSet } from '@/lib/permissions';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-key';
import type { PROPOSAL_KINDS } from '@/lib/agentic/proposal-labels';

/** The extra key each kind's approval needs; a kind not listed needs none. */
export const PROPOSAL_KIND_APPROVE_PERMISSION: Readonly<
    Partial<Record<(typeof PROPOSAL_KINDS)[number], PermissionKey>>
> = {
    PROCESS_MAP: 'processes.edit',
};

/** The extra key `kind`'s approval needs, or null. */
export function approvePermissionFor(kind: string): PermissionKey | null {
    return Object.prototype.hasOwnProperty.call(PROPOSAL_KIND_APPROVE_PERMISSION, kind)
        ? (PROPOSAL_KIND_APPROVE_PERMISSION[kind as (typeof PROPOSAL_KINDS)[number]] ?? null)
        : null;
}

/**
 * Would `approveAgentProposal` take this viewer's approval of a proposal of
 * this kind, as far as AUTHORITY goes?
 *
 * The role-tier write (`permissions.canWrite`, which the usecase asserts
 * first) and the kind's extra key. The per-row refusals (the window, the
 * composer, a second signature, the diff) are decided elsewhere on the row.
 */
export function viewerMayApproveProposal(
    viewer: { permissions: { canWrite: boolean }; appPermissions: PermissionSet },
    kind: string,
): boolean {
    if (!viewer.permissions.canWrite) return false;
    const key = approvePermissionFor(kind);
    return key === null || hasPermission(viewer.appPermissions, key);
}
