/**
 * The approver of a FINDING, RISK, CONTROL or POLICY proposal holds the key the record's own
 * route takes (#5369).
 *
 * Approving runs the real `createFinding` / `updateFinding` / `createRisk` /
 * `updateRisk` as the approver, and those floor on `findings.create` /
 * `findings.edit` / `risks.create` / `risks.edit`. Asked HERE as well, before
 * the signature and the claim, because a refusal from the usecase comes after
 * the claim — and a claimed proposal is deliberately never handed back, so it
 * would read ACCEPTED with nothing created. `assertPermission` writes the one
 * hash-chained `AUTHZ_DENIED` row; the refusal is re-thrown with a
 * `details.reason` the review surfaces word.
 *
 * The key comes from `PROPOSAL_KIND_APPROVE_PERMISSION`, the table the review
 * surfaces read through `viewerMayApproveProposal`. A process map keeps its own
 * assert (`assertMayApproveProcessMap`) and reason.
 */
import { forbidden } from '@/lib/errors/types';
import { assertPermission } from '@/lib/security/assert-permission';
import { approvePermissionFor } from '@/lib/agentic/proposal-approve-permission';

import type { RequestContext } from '../types';

/** `details.reason` of each refusal, by kind and operation. */
export const RECORD_APPROVER_REFUSALS = {
    FINDING: {
        CREATE: {
            reason: 'FINDING_APPROVER_NEEDS_FINDINGS_CREATE',
            message: 'Approving this finding creates it as you, so it needs permission to create findings.',
        },
        UPDATE: {
            reason: 'FINDING_APPROVER_NEEDS_FINDINGS_EDIT',
            message: 'Approving this change edits the finding as you, so it needs permission to edit findings.',
        },
    },
    RISK: {
        CREATE: {
            reason: 'RISK_APPROVER_NEEDS_RISKS_CREATE',
            message: 'Approving this risk creates it as you, so it needs permission to create risks.',
        },
        UPDATE: {
            reason: 'RISK_APPROVER_NEEDS_RISKS_EDIT',
            message: 'Approving this change edits the risk as you, so it needs permission to edit risks.',
        },
    },
    CONTROL: {
        CREATE: {
            reason: 'CONTROL_APPROVER_NEEDS_CONTROLS_CREATE',
            message: 'Approving this control creates it as you, so it needs permission to create controls.',
        },
        UPDATE: {
            reason: 'CONTROL_APPROVER_NEEDS_CONTROLS_EDIT',
            message: 'Approving this change edits the control as you, so it needs permission to edit controls.',
        },
    },
    POLICY: {
        CREATE: {
            reason: 'POLICY_APPROVER_NEEDS_POLICIES_CREATE',
            message: 'Approving this policy creates it as you, so it needs permission to create policies.',
        },
        UPDATE: {
            reason: 'POLICY_APPROVER_NEEDS_POLICIES_EDIT',
            message: 'Approving this change edits the policy as you, so it needs permission to edit policies.',
        },
    },
} as const;

type RecordKind = keyof typeof RECORD_APPROVER_REFUSALS;

function isRecordKind(kind: string): kind is RecordKind {
    return Object.prototype.hasOwnProperty.call(RECORD_APPROVER_REFUSALS, kind);
}

/**
 * Refuse an approver of a FINDING, RISK, CONTROL or POLICY proposal who lacks
 * the key. Any other kind returns: its usecase's own floor is the role-tier
 * write the queue has already asserted, or (a process map) it has its own
 * assert.
 */
export async function assertMayApproveRecordProposal(
    ctx: RequestContext,
    proposalId: string,
    kind: string,
    operation: string | null | undefined,
): Promise<void> {
    if (!isRecordKind(kind)) return;
    const key = approvePermissionFor(kind, operation);
    if (!key) return;
    const refusal = RECORD_APPROVER_REFUSALS[kind][operation === 'UPDATE' ? 'UPDATE' : 'CREATE'];
    try {
        await assertPermission(ctx, key, {
            method: 'POST',
            path: `/api/t/:slug/agent-proposals/${proposalId}/approve`,
        });
    } catch (err) {
        if ((err as { status?: unknown } | null)?.status === 403) {
            throw forbidden(refusal.message, { reason: refusal.reason });
        }
        throw err;
    }
}
