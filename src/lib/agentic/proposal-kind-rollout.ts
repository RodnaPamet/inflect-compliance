/**
 * The brake on the PROCESS_MAP proposal kind (#5053).
 *
 * `AgentProposalKind.PROCESS_MAP` reaches the database in two deploys, because
 * a generated Prisma client fails the whole read on a stored enum value it was
 * not generated with. Deploy 1 adds the value and teaches every reader; it
 * writes none. `createAgentProposal` refuses the kind by name, and
 * `approveAgentProposal` refuses it while this flag is false — before any
 * signature is written and before the claim, so a row written by a newer
 * container stays PENDING. The review surfaces withhold Approve on such a row
 * (`buildProposalDiffs`).
 *
 * Deploy 2 flips this to true in a commit of its own. Setting it back to false
 * is a one-line, reviewed diff that stops new map proposals and their approval
 * while every reader keeps reading the rows.
 *
 * Typed `boolean`, not the literal `false`, so a reader's branch on it is not
 * dead code to the compiler (the precedent is `AGENT_CAMPAIGNS_IMPLEMENTED` in
 * `src/lib/access-review/scope.ts`). A leaf module, so tests and the rollout
 * ratchet read it without loading the usecase graph.
 *
 * TYPE IMPORTS ONLY, so a client component and a rendered test can read it.
 */
import type { ProposalDiff } from '@/lib/agentic/proposal-diff-status';

export const PROCESS_MAP_PROPOSALS_IMPLEMENTED: boolean = false;

/**
 * The diff a row of a kind this release does not approve is shown with, or
 * `null` for a kind it does.
 *
 * `KIND_NOT_APPROVABLE` is a non-reviewable status of its own:
 * `isDiffReviewable` answers false, so the queue and the canvas checkpoint
 * review panel both withhold Approve, and the row can still be rejected.
 * It is NOT `PAYLOAD_UNREADABLE`: that status's copy tells the reviewer the
 * content is broken and to reject it, which is false of a well-formed row a
 * newer container wrote, and which becomes approvable once the rollout ends.
 * `ProposalDiffPanel` renders this status with its own sentence.
 * `buildProposalDiffs` is the one caller on the server.
 */
export function withheldProposalDiff(kind: string): ProposalDiff | null {
    if (kind === 'PROCESS_MAP' && !PROCESS_MAP_PROPOSALS_IMPLEMENTED) {
        return { status: 'KIND_NOT_APPROVABLE', fields: [], baseDigest: null, comparedFieldCount: 0 };
    }
    return null;
}
