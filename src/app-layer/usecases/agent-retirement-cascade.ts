/**
 * THE RETIREMENT CASCADE — what retiring an agent takes away (#3698, step 2a).
 *
 * `retireRegisteredAgent` (`agent-registry.ts`) is the act: it resolves the
 * agent, writes the RETIRED status, then calls the two functions here — the
 * effects, then their audit rows — inside its one transaction. They live apart
 * from the register usecase because that file is already the register's whole
 * write surface, and because the cascade is the one place that writes four
 * other subsystems' tables and should be readable as one unit.
 *
 * ## The effects, and the column each one changes
 *
 *   keys          `TenantApiKey.revokedAt` set on every unrevoked key bound to
 *                 the agent — expired ones too, so "no key bound to a retired
 *                 agent is unrevoked" holds without reference to a clock
 *   scanner keys  `AgentHarnessScannerKey.revokedAt` / `revokedByUserId`, through
 *                 that table's one write seam
 *   tool grants   `RegisteredAgentTool` rows DELETED (a grant is authority, not
 *                 history; its audit row is the trail)
 *   proposals     `AgentProposal.status` PENDING → EXPIRED, exactly as the expiry
 *                 sweep writes it: `reviewedByUserId` stays NULL because nobody
 *                 reviewed it, and the payload, guard verdict and pins stay put
 *   policy card   nothing written. The freeze is a REFUSAL — at the card's write
 *                 seam and in a trigger — so this only reads the version in force
 *                 to record it. Writing the card head here would take its row
 *                 lock against an edit in flight that already holds it and is
 *                 waiting on the agent row this transaction locked first.
 *   transfer      the agent's open `AgentOwnershipTransfer` closed — CANCELLED,
 *                 attributed to the retiring actor, while live (a retired agent
 *                 can never be completed into); stamped EXPIRED with no actor once
 *                 lapsed. See `closeOpenForAgent`
 *   evidence      the agent's PER-AGENT `AgenticEvidenceArtefact`s of the periods
 *                 still open moved to WITHDRAWN `AGENT_RETIRED`, their Evidence
 *                 archived with a notice (#3700). Tenant-wide artefacts and closed
 *                 periods are untouched; nothing is deleted. Written by
 *                 `withdrawRetiredAgentEvidenceInTx`, the emitter's own file,
 *                 which stays the only writer of the table
 *
 * ## One key, by construction
 *
 * 0e decided retirement takes `admin.agent_registry` ALONE, because every effect
 * takes authority away and a narrower key holder keeps the standalone verb they
 * already have. So every effect here is written DIRECTLY — never through
 * `revokeApiKey` (`admin.manage`), `revokeAgentTool` (`agent_tool_exposure`) or
 * `updateAgentPolicyCard` (`agent_policy_card`). Calling one of those would add
 * its gate to retirement without anybody deciding it should.
 *
 * ## Bounded lists, unbounded writes
 *
 * Each id list is a bounded read (the query-shape guardrails), and it exists
 * only for the audit row. Each WRITE is an unbounded `updateMany`/`deleteMany`,
 * because "zero open proposals" has to be true of the table rather than of the
 * first page; the write's own count is authoritative, and a list cut short says
 * so (`idsTruncated`).
 */
import type { AgentStatus } from '@prisma/client';

import type { PrismaTx } from '@/lib/db-context';
import {
    boundedIds,
    RETIREMENT_ARTEFACT_ID_CAP,
    RETIREMENT_KEY_ID_CAP,
    RETIREMENT_PROPOSAL_ID_CAP,
    summariseRetirementCascade,
    type RetirementCascadeEffects,
    type RetirementCascadeSummary,
} from '@/lib/agentic/agent-retirement';

import { logEvent } from '../events/audit';
import { AgentOwnershipTransferRepository } from '../repositories/AgentOwnershipTransferRepository';
import { AgentPolicyCardRepository } from '../repositories/AgentPolicyCardRepository';
import { RegisteredAgentToolRepository } from '../repositories/RegisteredAgentToolRepository';
import type { RequestContext } from '../types';
import { revokeScannerKeysForAgentInTx } from './agent-harness-scanner-keys';
import { withdrawRetiredAgentEvidenceInTx } from './agentic-evidence-emission';

/**
 * Apply every effect of retirement, in one transaction the caller holds, and
 * write NO audit row.
 *
 * The caller must already have moved the agent to RETIRED. That order is what
 * closes the race with every writer still in flight — the agent queueing a
 * proposal, a human minting a key or a scanner key, granting a tool, editing
 * the card, proposing a transfer. The status UPDATE holds the agent row's lock
 * until commit, and every one of those inserts takes `FOR SHARE` on that row in
 * a trigger (the retirement migration, sections 1, 2, 4 and 5). So a row for
 * this agent either committed before this transaction's UPDATE — and is revoked,
 * deleted, expired or closed below, and listed — or waits for the commit and
 * then reads RETIRED and is refused. Nothing for this agent can commit between
 * the two statements of one effect either, which is what lets each id list
 * describe its write.
 */
export async function applyRetirementCascadeInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    now: Date,
): Promise<RetirementCascadeEffects> {
    // ── Credentials ──────────────────────────────────────────────────
    const unrevokedKeys = { tenantId: ctx.tenantId, agentId, revokedAt: null };
    const keyRows = await db.tenantApiKey.findMany({
        where: unrevokedKeys,
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: RETIREMENT_KEY_ID_CAP + 1,
    });
    // The LIVE subset, by `getById`'s `_count.apiKeys` predicate — the figure the
    // retire dialog previewed. Counted before the write, because afterwards every
    // one of them is revoked and the distinction is gone.
    const liveKeyCount = await db.tenantApiKey.count({
        where: {
            ...unrevokedKeys,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
    });
    const revokedKeys = await db.tenantApiKey.updateMany({
        where: unrevokedKeys,
        data: { revokedAt: now },
    });

    // ── Harness scanner signing keys ─────────────────────────────────
    const scanner = await revokeScannerKeysForAgentInTx(db, ctx, agentId, now);

    // ── Tool grants ──────────────────────────────────────────────────
    // `listForAgent` is bounded (the catalogue is a handful of tools); the
    // delete is not.
    const grants = await RegisteredAgentToolRepository.listForAgent(db, ctx, agentId);
    const droppedGrants = await RegisteredAgentToolRepository.revokeAllForAgent(db, ctx, agentId);

    // ── Open proposals ───────────────────────────────────────────────
    const pending = { tenantId: ctx.tenantId, agentId, status: 'PENDING' as const };
    const pendingRows = await db.agentProposal.findMany({
        where: pending,
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: RETIREMENT_PROPOSAL_ID_CAP + 1,
    });
    const expired = await db.agentProposal.updateMany({
        where: pending,
        data: { status: 'EXPIRED' },
    });

    // ── Policy card: read, never written ─────────────────────────────
    const card = await AgentPolicyCardRepository.findForAgent(db, ctx, agentId);

    // ── Open ownership transfer: closed ──────────────────────────────
    // After the status write, like every other effect, so the transfer row's
    // lock is taken AFTER the agent row's — the order step one and step two of
    // a transfer take them in too, which is what keeps them from deadlocking.
    const transfer = await AgentOwnershipTransferRepository.closeOpenForAgent(
        db,
        ctx,
        agentId,
        now,
    );

    // ── Per-agent evidence of the open periods: withdrawn ────────────
    // Last, after the status write like every other effect: an emitter write
    // for this agent locks the agent row before it touches an artefact, so it
    // either committed before the status UPDATE — and its row is withdrawn
    // here — or it waits for this commit and is refused.
    const evidence = await withdrawRetiredAgentEvidenceInTx(db, ctx, agentId, now);

    return {
        apiKeys: {
            count: revokedKeys.count,
            liveCount: liveKeyCount,
            ...boundedIds(
                keyRows.map((k) => k.id),
                revokedKeys.count,
                RETIREMENT_KEY_ID_CAP,
            ),
        },
        scannerKeys: {
            count: scanner.count,
            ...boundedIds(scanner.ids, scanner.count, RETIREMENT_KEY_ID_CAP),
        },
        toolGrants: { count: droppedGrants, names: grants.map((g) => g.toolName) },
        proposals: {
            count: expired.count,
            ...boundedIds(
                pendingRows.map((p) => p.id),
                expired.count,
                RETIREMENT_PROPOSAL_ID_CAP,
            ),
        },
        policyCard: card ? { cardId: card.id, frozenAtVersion: card.currentVersion } : null,
        ownershipTransfer: transfer
            ? { transferId: transfer.id, toOwnerUserId: transfer.toOwnerUserId }
            : null,
        evidenceArtefacts: {
            count: evidence.count,
            ...boundedIds(evidence.ids, evidence.count, RETIREMENT_ARTEFACT_ID_CAP),
            deferredToSweep: evidence.deferredToSweep,
        },
    };
}

/**
 * The audit rows for one retirement: the summary, then one row per effect that
 * changed something.
 *
 * Called LAST, after every domain write. `logEvent` appends on its own
 * connection, outside the caller's transaction, so a row written before an
 * effect that then threw would survive the rollback and describe a retirement
 * that never happened.
 *
 * One row per effect KIND, not per entity: per-entity rows would be up to
 * hundreds of hash-chain appends under one advisory lock, and each row here
 * lists the ids it covers anyway. An effect that changed nothing writes no row
 * of its own — its zero is on the summary, once, rather than a row asserting an
 * act that did not happen.
 *
 * Every value is named at the sink (`local/no-raw-prompt-logging`): ids,
 * counts, tool names and versions only.
 */
export async function writeRetirementAuditRows(
    db: PrismaTx,
    ctx: RequestContext,
    agent: { readonly id: string; readonly status: AgentStatus },
    effects: RetirementCascadeEffects,
): Promise<RetirementCascadeSummary> {
    const cascade = summariseRetirementCascade(effects);

    await logEvent(db, ctx, {
        action: 'AGENT_RETIRED',
        entityType: 'RegisteredAgent',
        entityId: agent.id,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'RegisteredAgent',
            operation: 'update',
            reason: 'agent_retired',
            fromStatus: agent.status,
            toStatus: 'RETIRED',
            summary:
                `Retired registered agent ${agent.id}: ${cascade.apiKeysRevoked} API key(s) and ` +
                `${cascade.scannerKeysRevoked} scanner key(s) revoked, ` +
                `${cascade.toolGrantsDropped} tool grant(s) dropped, ` +
                `${cascade.proposalsExpired} pending proposal(s) expired, ` +
                `${cascade.evidenceArtefactsWithdrawn} open-period evidence artefact(s) withdrawn`,
            after: { status: 'RETIRED' },
            cascade: {
                apiKeysRevoked: cascade.apiKeysRevoked,
                liveApiKeysRevoked: cascade.liveApiKeysRevoked,
                scannerKeysRevoked: cascade.scannerKeysRevoked,
                toolGrantsDropped: cascade.toolGrantsDropped,
                proposalsExpired: cascade.proposalsExpired,
                policyCardFrozenAtVersion: cascade.policyCardFrozenAtVersion,
                ownershipTransferCancelled: cascade.ownershipTransferCancelled,
                // The agent's per-agent artefacts of the open periods; never a
                // tenant-wide one, never a closed period — see
                // `RETIREMENT_EVIDENCE_BASIS`.
                evidenceArtefactsWithdrawn: cascade.evidenceArtefactsWithdrawn,
                evidenceBasis: cascade.evidenceBasis,
            },
        },
    });

    if (effects.apiKeys.count > 0) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_KEYS_REVOKED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'access',
                entityName: 'TenantApiKey',
                operation: 'revoked',
                reason: 'agent_retired',
                summary: `Revoked ${effects.apiKeys.count} API key(s) bound to retired agent ${agent.id}`,
                keyIds: effects.apiKeys.ids,
                count: effects.apiKeys.count,
                liveCount: effects.apiKeys.liveCount,
                idsTruncated: effects.apiKeys.idsTruncated,
            },
        });
    }

    if (effects.scannerKeys.count > 0) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_SCANNER_KEYS_REVOKED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentHarnessScannerKey',
                operation: 'revoked',
                reason: 'agent_retired',
                summary: `Revoked ${effects.scannerKeys.count} harness scanner key(s) of retired agent ${agent.id}`,
                keyIds: effects.scannerKeys.ids,
                count: effects.scannerKeys.count,
                idsTruncated: effects.scannerKeys.idsTruncated,
            },
        });
    }

    if (effects.toolGrants.count > 0) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_TOOLS_DROPPED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'access',
                entityName: 'RegisteredAgentTool',
                operation: 'delete',
                reason: 'agent_retired',
                summary: `Dropped ${effects.toolGrants.count} tool grant(s) of retired agent ${agent.id}`,
                before: { toolNames: effects.toolGrants.names },
                count: effects.toolGrants.count,
            },
        });
    }

    if (effects.proposals.count > 0) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_PROPOSALS_EXPIRED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'status_change',
                entityName: 'AgentProposal',
                operation: 'update',
                reason: 'agent_retired',
                fromStatus: 'PENDING',
                toStatus: 'EXPIRED',
                summary: `Expired ${effects.proposals.count} pending proposal(s) of retired agent ${agent.id}`,
                proposalIds: effects.proposals.ids,
                count: effects.proposals.count,
                idsTruncated: effects.proposals.idsTruncated,
            },
        });
    }

    if (effects.policyCard) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_POLICY_CARD_FROZEN',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentPolicyCard',
                operation: 'frozen',
                reason: 'agent_retired',
                summary: `Froze the policy card of retired agent ${agent.id} at version ${effects.policyCard.frozenAtVersion}`,
                cardId: effects.policyCard.cardId,
                frozenAtVersion: effects.policyCard.frozenAtVersion,
            },
        });
    }

    if (effects.ownershipTransfer) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentOwnershipTransfer',
                operation: 'cancelled',
                reason: 'agent_retired',
                summary: `Cancelled the open ownership transfer of retired agent ${agent.id}`,
                transferId: effects.ownershipTransfer.transferId,
                targetUserId: effects.ownershipTransfer.toOwnerUserId,
                fromStatus: 'PENDING',
                toStatus: 'CANCELLED',
            },
        });
    }

    if (effects.evidenceArtefacts.count > 0) {
        await logEvent(db, ctx, {
            action: 'AGENT_RETIREMENT_EVIDENCE_WITHDRAWN',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'status_change',
                entityName: 'AgenticEvidenceArtefact',
                operation: 'update',
                reason: 'agent_retired',
                fromStatus: 'CURRENT',
                toStatus: 'WITHDRAWN',
                summary:
                    `Withdrew ${effects.evidenceArtefacts.count} open-period per-agent evidence ` +
                    `artefact(s) of retired agent ${agent.id}`,
                artefactIds: effects.evidenceArtefacts.ids,
                count: effects.evidenceArtefacts.count,
                idsTruncated: effects.evidenceArtefacts.idsTruncated,
                deferredToSweep: effects.evidenceArtefacts.deferredToSweep,
            },
        });
    }

    return cascade;
}
