/**
 * What APPROVING an external-write proposal actually does (#2861).
 *
 * It opens the journal row, and nothing else. The call itself goes out in the
 * `external-write-dispatch` job, which sweeps journal rows left `PENDING`.
 *
 * ## Why the journal row is opened HERE and not in the job
 *
 * Three reasons, and the first is the one that decides it:
 *
 *   1. `beginWrite` refuses `DRY_RUN` and `DISABLED`, so opening the row at
 *      approval RE-CHECKS THE RUNG at the moment a human commits to the write.
 *      A connection narrowed between proposal and approval must not be written
 *      to, and this is where an operator's withdrawal actually takes effect. Put
 *      the row in the job instead and that check moves hours later, past the
 *      point where the approver was told it succeeded.
 *   2. `AgentProposal.createdEntityId` wants the record the proposal resolved
 *      to. With the row opened here it is the journal id — a real record — so
 *      `ApproveResult.createdEntityId` stays non-null and the route's
 *      distinction between `AWAITING_APPROVAL` (null) and an applied approval
 *      keeps working. Opening it in the job would force that field nullable and
 *      blur exactly the discrimination that route exists to preserve.
 *   3. `beginWrite`'s own contract is that the row is written BEFORE the call,
 *      so a process that dies mid-dispatch still leaves evidence. Approval is
 *      before the call by definition.
 *
 * ## Nothing is sent from here
 *
 * The row lands `PENDING`, which is precisely "journalled; the far end has not
 * reported back". The sweep the journal's own `@@index([tenantId, outcome])`
 * was built for is what picks it up.
 */
import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { coerceStoredMode } from '@/lib/integrations/external-write-ladder';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { ExternalWriteProposalPayloadSchema } from '@/lib/agentic/external-write-proposal';

import type { RequestContext } from '../types';
import { beginWrite } from './external-write-journal';

/**
 * Open the journal row for an approved external write.
 *
 * Returns the journal id, which the caller stores as the proposal's
 * `createdEntityId`.
 */
export async function openApprovedExternalWrite(
    ctx: RequestContext,
    proposal: { id: string; payloadJson: string; agentId: string | null; runId: string | null },
): Promise<string> {
    const parsed = ExternalWriteProposalPayloadSchema.safeParse(JSON.parse(proposal.payloadJson));
    if (!parsed.success) {
        // A stored payload that no longer satisfies its own schema is not a
        // reviewer error and must not be dispatched on a guess.
        throw badRequest(
            `Proposal ${proposal.id} does not carry a well-formed external write: ${parsed.error.message}`,
        );
    }
    const payload = parsed.data;

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: {
                id: payload.connectionId,
                tenantId: ctx.tenantId,
                provider: MCP_SERVER_PROVIDER_ID,
            },
            select: { id: true, externalWriteMode: true },
        }),
    );
    if (!connection) {
        // Deleted between proposal and approval. The payload denormalises the
        // NAME and URL so the row stays readable, but a write still needs a live
        // connection to be sent through.
        throw notFound('The connection this write was proposed against no longer exists');
    }

    // Coerced at the read boundary, before any comparison — an unrecognised
    // stored value fails closed to DISABLED rather than sailing past.
    const rung = coerceStoredMode(connection.externalWriteMode);
    if (rung === 'DISABLED' || rung === 'DRY_RUN') {
        // The authority was withdrawn after the write was proposed. Narrowing is
        // never gated, so this is the expected consequence of an operator using
        // that freedom, and it must be stated plainly rather than deferred to a
        // job that fails later out of the approver's sight.
        throw badRequest(
            `This connection is now at ${rung}, so the write cannot be sent. It was proposed `
                + 'while the connection permitted external writes and that permission has since '
                + 'been narrowed. Nothing was sent.',
        );
    }

    const handle = await beginWrite(ctx, {
        connectionId: payload.connectionId,
        connectionName: payload.connectionName,
        endpointUrl: payload.endpointUrl,
        toolName: payload.toolName,
        advertisedToolName: payload.advertisedToolName,
        mode: rung,
        argumentsJson: JSON.stringify(payload.arguments),
        // The state read when the write was PROPOSED. The dispatch re-reads it
        // and refuses on drift, so this is the copy the approver saw and the
        // thing that comparison is against.
        priorStateJson: JSON.stringify(payload.priorState),
        agentId: proposal.agentId,
        runId: proposal.runId,
    });
    return handle.journalId;
}
