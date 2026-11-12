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
 * A finding, a risk, a control or a policy (#5369) is created or edited through `findings.create` /
 * `findings.edit` and `risks.create` / `risks.edit`, the keys their routes
 * take and their usecases now floor on. Listing them here makes the queue
 * refuse BEFORE the signature and the claim: without it the usecase's own
 * floor would refuse after the claim, and a claimed proposal is never handed
 * back — it would read ACCEPTED with nothing created. So the table is keyed
 * by kind AND operation: an UPDATE proposal edits, a CREATE proposal creates.
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

/** A proposal's operation. A row with none is a CREATE, as the approve usecase reads it. */
export type ProposalApproveOperation = 'CREATE' | 'UPDATE';

/** The extra key each kind's approval needs, per operation; a kind not listed needs none. */
export const PROPOSAL_KIND_APPROVE_PERMISSION: Readonly<
    Partial<Record<(typeof PROPOSAL_KINDS)[number], Readonly<Record<ProposalApproveOperation, PermissionKey>>>>
> = {
    PROCESS_MAP: { CREATE: 'processes.edit', UPDATE: 'processes.edit' },
    FINDING: { CREATE: 'findings.create', UPDATE: 'findings.edit' },
    RISK: { CREATE: 'risks.create', UPDATE: 'risks.edit' },
    // A control's and a policy's usecases already floor on their keys; listed
    // so the queue asks BEFORE the claim, for the reason the docstring gives.
    CONTROL: { CREATE: 'controls.create', UPDATE: 'controls.edit' },
    POLICY: { CREATE: 'policies.create', UPDATE: 'policies.edit' },
};

/** The extra key approving a `kind` proposal of `operation` needs, or null. */
export function approvePermissionFor(kind: string, operation?: string | null): PermissionKey | null {
    if (!Object.prototype.hasOwnProperty.call(PROPOSAL_KIND_APPROVE_PERMISSION, kind)) return null;
    const keys = PROPOSAL_KIND_APPROVE_PERMISSION[kind as (typeof PROPOSAL_KINDS)[number]];
    if (!keys) return null;
    // Anything but an explicit UPDATE is approved by running the create path.
    return operation === 'UPDATE' ? keys.UPDATE : keys.CREATE;
}

/**
 * Would `approveAgentProposal` take this viewer's approval of a proposal of
 * this kind, as far as AUTHORITY goes?
 *
 * The role-tier write (`permissions.canWrite`, which the usecase asserts
 * first) and the extra key for the kind and operation. The per-row refusals (the window, the
 * composer, a second signature, the diff) are decided elsewhere on the row.
 */
export function viewerMayApproveProposal(
    viewer: { permissions: { canWrite: boolean }; appPermissions: PermissionSet },
    kind: string,
    operation?: string | null,
): boolean {
    if (!viewer.permissions.canWrite) return false;
    const key = approvePermissionFor(kind, operation);
    return key === null || hasPermission(viewer.appPermissions, key);
}
