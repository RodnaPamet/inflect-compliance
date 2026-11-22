/**
 * What APPROVING a process-map proposal does (#5053), beyond re-reading it.
 *
 * The payload contract lives in `src/lib/agentic/process-map-proposal.ts`, the
 * layout in `src/lib/processes/proposed-map-layout.ts`, and the one server
 * read the review diff and approval share in
 * `src/lib/processes/proposed-map-read.ts`. This module holds the two parts of
 * approval that need the database: the audited permission check and the
 * creation.
 *
 * Approval's order in `approveAgentProposal` is load-bearing:
 *   1. `prepareProcessMapApproval` (pure; refuses edits and an unreadable
 *      payload) runs before the guard re-scans;
 *   2. `assertMayApproveProcessMap` (an audited `processes.edit` check) runs
 *      after the API-key refusal, so an API key gets that refusal and not
 *      this one;
 *   3. both run BEFORE the signature insert and the claim, so every refusal
 *      leaves the row PENDING with no signature;
 *   4. `applyApprovedProcessMap` runs after the claim and creates the map,
 *      DRAFT in Document mode, in one transaction.
 *
 * Audit rows carry counts and ids, never step labels.
 */
import { forbidden } from '@/lib/errors/types';
import { assertPermission } from '@/lib/security/assert-permission';
import { approvePermissionFor } from '@/lib/agentic/proposal-approve-permission';
import type { PreparedProcessMap } from '@/lib/processes/proposed-map-read';

import type { RequestContext } from '../types';
import { createProcessMapWithGraph } from './process-map';

/** `details.reason` of the refusal of an approver who lacks `processes.edit`. */
export const PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT = 'PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT';

/**
 * The approver holds the key a process map's approval needs
 * (`PROPOSAL_KIND_APPROVE_PERMISSION`). `assertPermission` writes the one
 * hash-chained `AUTHZ_DENIED` row; the refusal is re-thrown with a
 * `details.reason` so the review surfaces can word it.
 */
export async function assertMayApproveProcessMap(ctx: RequestContext, proposalId: string): Promise<void> {
    const key = approvePermissionFor('PROCESS_MAP');
    if (!key) return;
    try {
        await assertPermission(ctx, key, {
            method: 'POST',
            path: `/api/t/:slug/agent-proposals/${proposalId}/approve`,
        });
    } catch (err) {
        if ((err as { status?: unknown } | null)?.status === 403) {
            throw forbidden('Approving a process map needs permission to edit process maps.', {
                reason: PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT,
            });
        }
        throw err;
    }
}

/**
 * Create the approved map: DRAFT, Document mode, created by the approver, in
 * one transaction, with the proposal named on its CREATE audit row. Returns
 * the map id, which the caller stores as the proposal's `createdEntityId`.
 */
export async function applyApprovedProcessMap(
    ctx: RequestContext,
    prepared: PreparedProcessMap,
    sourceProposalId: string,
): Promise<string> {
    return createProcessMapWithGraph(ctx, {
        name: prepared.name,
        description: prepared.description,
        nodes: prepared.graph.nodes,
        edges: prepared.graph.edges,
        sourceProposalId,
    });
}
