/**
 * AGENT OWNERSHIP TRANSFER — `transferAgentOwnership`, in two steps (#3698).
 *
 * Step 0e of the agentic IAM roadmap names one verb, `transferAgentOwnership`,
 * with two steps. It is this pair: `proposeAgentOwnershipTransfer` (step one)
 * and `completeAgentOwnershipTransfer` (step two), plus the cancel and the read
 * a two-step act needs.
 *
 * ## Why ownership has its own two-step act
 *
 * `RegisteredAgent.ownerUserId` is the accountable human: the two-person rules
 * downstream compare against it (an owner cannot approve their own agent's
 * proposal), a harness shortfall can be accepted only by it, and 2b's orphan
 * pass will stop an agent whose owner has left. Moving it in one step lets a
 * single person hand an agent — and its accountability — to somebody who never
 * agreed to carry it, or take an agent away from the person accountable for it
 * without their knowledge. So it moves only when TWO people act: one proposes,
 * and the one named accepts. The register's PATCH refuses the field.
 *
 * ## The key, and who can receive an agent
 *
 * Both steps carry a literal `requirePermission('admin.agent_ownership')` at the
 * route (#3699). Until then they carried `admin.tenant_lifecycle` (0e), which
 * ADMIN does not hold, so with the built-in roles an agent passed only to an
 * OWNER — the narrowing the owner accepted in 0e and again, on 2026-10-18, as
 * the INTERIM state. `admin.agent_ownership` separates accountability for an
 * agent from authority over the tenant's existence: OWNER and the built-in
 * AI_ADMIN hold it, ADMIN does not (owner default), and an OWNER can grant it
 * through a custom role. The person completing step two must hold it too.
 *
 * Step one refuses a recipient who could never pass step two, rather than
 * letting the offer sit until it expired and hold the agent's one open slot.
 * Step two meets TWO gates, so step one asks both: the route's key, and before
 * it the edge middleware's admin-path gate, which reads the BUILT-IN membership
 * role and admits ADMIN and OWNER everywhere under `/admin/`, and AI_ADMIN on
 * the agent paths only. A custom role carrying the key is therefore enough
 * only on an ADMIN membership; on a READER, EDITOR or AUDITOR membership the
 * edge refuses the request before the route runs. See
 * `TRANSFER_RECIPIENT_MEMBERSHIP_ROLES`: the edge reads the role in THIS
 * tenant's membership (#3701), which is the role the step-one check reads.
 *
 * The usecase re-asserts the key (`assertCanTransferAgentOwnership`) as defence in
 * depth — a second caller of these functions cannot reach them with less — but
 * the route's literal is THE gate: only its denial writes the hash-chained
 * `AUTHZ_DENIED` row. No API key carries `admin.agent_ownership`, so both steps
 * are human-only by construction.
 *
 * ## The two-person rule lives in three places
 *
 *   1. here: the initiator is refused at step two FIRST, read from the stored
 *      row and never from the request, before status or expiry are looked at;
 *   2. the completion CLAIM: its WHERE names the recipient, so nobody else's
 *      request can match the row;
 *   3. the table: CHECKs make "started by the recipient" and "completed by
 *      anyone but the recipient" unrepresentable.
 *
 * ## Expiry is lazy, and cancellation is open to every key holder
 *
 * A proposal lasts `AGENT_OWNERSHIP_TRANSFER_TTL_DAYS`. No job sweeps it: the
 * completion claim checks the clock itself, and the next request that finds a
 * lapsed row — a new proposal for the agent, or a refused completion — marks it
 * EXPIRED. That stamp writes no audit row, because nobody acted. Any holder of
 * the key may cancel an open transfer: the initiator withdrawing it, the
 * recipient declining it, or another OWNER. Retiring the agent closes it too
 * (the retirement cascade): a live one CANCELLED, attributed to the retiring
 * actor; a lapsed one stamped EXPIRED, the way every other request stamps it.
 *
 * ## Lock order: the agent row, then the transfer row
 *
 * Every path that locks both takes them in that order — step one (`FOR SHARE`
 * before the lapsed-row stamp), step two (`moveOwner` before the claim) and
 * retirement (status before the cascade). A path that takes only one, like the
 * cancel and step two's expiry branch, cannot close a cycle.
 */
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { permissionsForMembership } from '@/lib/permissions';
import { isAgentRetiredDbRefusal } from '@/lib/agentic/agent-retirement';
import {
    effectiveTransferStatus,
    isTransferRecipientMembershipRole,
    transferExpiresAt,
} from '@/lib/agentic/ownership-transfer';
import { logEvent } from '../events/audit';
import { AgentOwnershipTransferRepository } from '../repositories/AgentOwnershipTransferRepository';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import {
    CancelAgentOwnershipTransferQuerySchema,
    CompleteAgentOwnershipTransferSchema,
    ProposeAgentOwnershipTransferSchema,
} from '../schemas/agent-ownership-transfer.schemas';
import type { RequestContext } from '../types';

type TransferRow = NonNullable<Awaited<ReturnType<typeof AgentOwnershipTransferRepository.findById>>>;

/**
 * Both steps, the cancel and the read take `admin.agent_ownership` — see the
 * module docstring. `assertCanRead` and not `assertCanWrite`: the key is the
 * authority, and the coarse tier comes from a custom role's BASE role. An ADMIN
 * membership carrying a custom role built on a READER base and given this key
 * passes the edge (it reads the membership role) and the route (it reads the
 * key), and resolves `canWrite: false` — a legitimate recipient that
 * `assertCanWrite` would lock out at the last step.
 */
function assertCanTransferAgentOwnership(ctx: RequestContext) {
    assertCanRead(ctx);
    if (!ctx.appPermissions?.admin?.agent_ownership) {
        throw forbidden(
            "Transferring an agent's ownership requires the agent ownership permission, " +
                'which among the built-in roles an OWNER and an AI admin hold.',
        );
    }
}

/**
 * The recipient must be an ACTIVE member who can reach step two: a built-in
 * membership role the edge's admin-path gate admits to these paths
 * (`TRANSFER_RECIPIENT_MEMBERSHIP_ROLES`), AND effective permissions — custom
 * role over its base, or the built-in role — carrying `admin.agent_ownership`,
 * which the route requires. Read from the membership row, never from the
 * caller's claim. Used at step one about the person named, and again at step two
 * about the person completing, so a recipient deactivated or demoted in between
 * cannot complete.
 */
async function assertCanReceiveAgent(db: PrismaTx, ctx: RequestContext, userId: string) {
    const membership = await db.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId, status: 'ACTIVE' },
        select: {
            role: true,
            customRole: { select: { permissionsJson: true, baseRole: true } },
        },
    });
    if (!membership) {
        throw badRequest('The new owner must be an active member of this workspace.');
    }
    if (!isTransferRecipientMembershipRole(membership.role)) {
        throw badRequest(
            'The new owner must be an OWNER, an AI admin, or an ADMIN whose custom role ' +
                'carries the agent ownership permission. Accepting a transfer is an admin ' +
                'request, and agent admin requests are open only to OWNER, ADMIN and AI admin ' +
                'members — a custom role carrying the permission on any other membership role ' +
                'cannot reach it.',
        );
    }
    if (!permissionsForMembership(membership).admin.agent_ownership) {
        throw badRequest(
            'The new owner must hold the agent ownership permission, because completing a ' +
                'transfer requires it. Among the built-in roles an OWNER and an AI admin hold ' +
                'it; an OWNER can give an ADMIN a custom role that carries it.',
        );
    }
}

/** A transfer as the API returns it: the stored row plus the status it has NOW. */
function present(row: TransferRow, now: Date) {
    return { ...row, effectiveStatus: effectiveTransferStatus(row, now) };
}

const RETIRED_MESSAGE =
    "This agent is retired, so its ownership cannot be transferred: retirement is permanent, and a retired agent's register entry is closed.";

/**
 * Step one: record who should become the agent's accountable owner.
 *
 * Refuses, in order: an absent or foreign agent (not found); a RETIRED one (its
 * file is closed); the current owner as recipient; the caller as recipient (they
 * could never complete it); a recipient who is not an active member holding the
 * key; and a second open transfer for the same agent. A DRAFT or SUSPENDED agent
 * may be transferred — 2b's remedy for an agent stopped because its owner left
 * is exactly a transfer of a suspended agent. For the same reason the CURRENT
 * owner's membership is not checked: a transfer away from a departed owner is
 * the case that most needs to work.
 *
 * LOCK ORDER: the agent row FIRST, then any transfer row — the order retirement
 * (status, then the cascade's transfer write) and completion (`moveOwner`, then
 * the claim) take them in. The agent is read `FOR SHARE`, before the lapsed-row
 * stamp below takes a transfer row's lock. Read plain, as it once was, the
 * stamp locked a transfer row and the insert trigger then waited on the agent
 * row — the reverse order — and a retirement or completion holding the agent
 * row while reaching for that same transfer row deadlocked with it whenever the
 * row's deadline fell between the two requests' clocks. `FOR SHARE` is what a
 * retirement's or a completion's UPDATE conflicts with, so this now waits for
 * either to commit and then reads what it left.
 */
export async function proposeAgentOwnershipTransfer(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
) {
    assertCanTransferAgentOwnership(ctx);
    const parsed = ProposeAgentOwnershipTransferSchema.parse(input);
    const now = new Date();

    return runInTenantContext(ctx, async (db) => {
        // FOR SHARE, first — see LOCK ORDER above.
        const agent = await RegisteredAgentRepository.lockLifecycleStateForShare(db, ctx, agentId);
        if (!agent) throw notFound('Registered agent not found');
        if (agent.status === 'RETIRED') throw conflict(RETIRED_MESSAGE);
        if (parsed.toOwnerUserId === agent.ownerUserId) {
            throw badRequest('That person already owns this agent.');
        }
        if (parsed.toOwnerUserId === ctx.userId) {
            throw badRequest(
                'You cannot propose yourself as the new owner. The person who starts a transfer ' +
                    'can never complete it, so it would only wait until it expired — ask another ' +
                    'holder of the agent ownership permission to propose it to you.',
            );
        }
        await assertCanReceiveAgent(db, ctx, parsed.toOwnerUserId);

        // A lapsed proposal still holds the one-open-per-agent slot until
        // something stamps it. This is that something.
        await AgentOwnershipTransferRepository.expireLapsedForAgent(db, ctx, agentId, now);
        const open = await AgentOwnershipTransferRepository.findOpenForAgent(db, ctx, agentId);
        if (open) {
            throw conflict(
                'A transfer of this agent is already waiting for its recipient to accept it. ' +
                    'Cancel it before proposing another.',
            );
        }

        let created: TransferRow;
        try {
            created = await AgentOwnershipTransferRepository.create(db, ctx, {
                agentId: agent.id,
                fromOwnerUserId: agent.ownerUserId,
                toOwnerUserId: parsed.toOwnerUserId,
                expiresAt: transferExpiresAt(now),
            });
        } catch (err) {
            // The partial unique index: a concurrent proposal won the slot
            // between the read above and this insert.
            if ((err as { code?: unknown } | null)?.code === 'P2002') {
                throw conflict(
                    'Another transfer of this agent was proposed at the same moment. ' +
                        'Reload to see it; cancel it before proposing another.',
                );
            }
            // The insert trigger: the agent was retired while this request was in flight.
            if (isAgentRetiredDbRefusal(err)) throw conflict(RETIRED_MESSAGE);
            throw err;
        }

        await logEvent(db, ctx, {
            action: 'AGENT_OWNERSHIP_TRANSFER_PROPOSED',
            entityType: 'AgentOwnershipTransfer',
            entityId: created.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentOwnershipTransfer',
                operation: 'create',
                summary:
                    `Proposed transferring registered agent ${created.agentId} from ` +
                    `${created.fromOwnerUserId} to ${created.toOwnerUserId}`,
                targetUserId: created.toOwnerUserId,
                after: {
                    agentId: created.agentId,
                    fromOwnerUserId: created.fromOwnerUserId,
                    toOwnerUserId: created.toOwnerUserId,
                    initiatedByUserId: created.initiatedByUserId,
                    expiresAt: created.expiresAt.toISOString(),
                },
            },
        });

        return present(created, now);
    });
}

/**
 * Step two: the person the transfer names accepts it, and ownership moves.
 *
 * The refusals are ordered so the two-person rule is the first thing asked:
 *
 *   1. absent, foreign or another agent's transfer → not found;
 *   2. the caller STARTED it → forbidden, whatever its status or deadline;
 *   3. the caller is not the person it names → forbidden;
 *   4. it is no longer PENDING → conflict;
 *   5. its deadline has passed → it is stamped EXPIRED, and the refusal is
 *      thrown AFTER that commits (throwing inside would roll the stamp back);
 *   6. the agent is gone, RETIRED, or no longer owned by the person it was
 *      proposed away from → conflict, nothing changed;
 *   7. the completer is no longer a recipient step one would accept (an active
 *      OWNER or AI_ADMIN holding the key, or an active ADMIN whose custom role
 *      carries it) → refused.
 *
 * Then the writes, AGENT ROW FIRST: `moveOwner` takes the agent row's lock
 * before `claimCompletion` takes the transfer's. Retirement and step one lock in
 * the same order (the agent row, then a transfer row), so they serialise instead
 * of deadlocking: whichever reaches the agent row second waits, re-reads it and
 * refuses. The expiry branch (5) takes a transfer row's lock and no other, which
 * cannot close a cycle.
 */
export async function completeAgentOwnershipTransfer(
    ctx: RequestContext,
    agentId: string,
    input: unknown,
) {
    assertCanTransferAgentOwnership(ctx);
    const parsed = CompleteAgentOwnershipTransferSchema.parse(input);
    const now = new Date();

    const outcome = await runInTenantContext(ctx, async (db) => {
        const transfer = await AgentOwnershipTransferRepository.findById(
            db,
            ctx,
            agentId,
            parsed.transferId,
        );
        if (!transfer) throw notFound('Ownership transfer not found');

        // THE TWO-PERSON RULE, asked before anything else and answered from the
        // stored row. An initiator calling on an expired or cancelled transfer
        // is still told the rule, not the state — the state is not why.
        if (transfer.initiatedByUserId === ctx.userId) {
            throw forbidden(
                'You started this transfer, so you cannot complete it. Only the person it ' +
                    'names can accept it.',
            );
        }
        if (transfer.toOwnerUserId !== ctx.userId) {
            throw forbidden('Only the person this transfer names can accept it.');
        }
        if (transfer.status !== 'PENDING') {
            throw conflict(
                `This transfer is no longer open (${transfer.status.toLowerCase()}), so it ` +
                    'cannot be accepted. Ask for it to be proposed again.',
            );
        }
        if (transfer.expiresAt.getTime() <= now.getTime()) {
            await AgentOwnershipTransferRepository.expireLapsedForAgent(db, ctx, agentId, now);
            return { refused: 'EXPIRED' as const, expiresAt: transfer.expiresAt };
        }

        const agent = await RegisteredAgentRepository.getLifecycleState(db, ctx, agentId);
        if (!agent) {
            throw conflict(
                'This agent was removed after the transfer was proposed. Nothing was changed.',
            );
        }
        if (agent.status === 'RETIRED') throw conflict(RETIRED_MESSAGE);
        if (agent.ownerUserId !== transfer.fromOwnerUserId) {
            throw conflict(
                'This agent changed owner after the transfer was proposed, so the transfer no ' +
                    'longer describes it. Nothing was changed; ask for a new proposal.',
            );
        }
        await assertCanReceiveAgent(db, ctx, ctx.userId);

        const moved = await RegisteredAgentRepository.moveOwner(
            db,
            ctx,
            agentId,
            transfer.fromOwnerUserId,
            ctx.userId,
        );
        if (moved === 0) {
            throw conflict(
                'This agent was retired, removed or re-owned while the transfer was being ' +
                    'accepted. Nothing was changed.',
            );
        }
        const claimed = await AgentOwnershipTransferRepository.claimCompletion(
            db,
            ctx,
            transfer.id,
            now,
        );
        if (claimed === 0) {
            // Rolls the owner move above back with it.
            throw conflict(
                'This transfer was cancelled or accepted while this request was in flight. ' +
                    'Nothing was changed; reload it to see its state.',
            );
        }

        // The agent's EU AI Act register entry has its own owner, which
        // registration set to the agent's. It is NOT moved here: the AI-system
        // owner may legitimately differ, and whether the two should stay in step
        // is a separate question. It is recorded, so a divergence is visible.
        const aiSystem = await db.aiSystem.findFirst({
            where: { id: agent.aiSystemId, tenantId: ctx.tenantId },
            select: { ownerUserId: true },
        });

        await logEvent(db, ctx, {
            action: 'AGENT_OWNERSHIP_TRANSFERRED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'access',
                entityName: 'RegisteredAgent',
                operation: 'update',
                summary:
                    `Transferred registered agent ${agent.id} from ` +
                    `${transfer.fromOwnerUserId} to ${transfer.toOwnerUserId}`,
                targetUserId: transfer.toOwnerUserId,
                changedFields: ['ownerUserId'],
                before: { ownerUserId: transfer.fromOwnerUserId },
                after: { ownerUserId: transfer.toOwnerUserId },
                transferId: transfer.id,
                initiatedByUserId: transfer.initiatedByUserId,
                aiSystemOwnerUserId: aiSystem?.ownerUserId ?? null,
            },
        });

        return {
            refused: null,
            transferId: transfer.id,
            agentId: agent.id,
            ownerUserId: transfer.toOwnerUserId,
            previousOwnerUserId: transfer.fromOwnerUserId,
        };
    });

    if (outcome.refused === 'EXPIRED') {
        throw conflict(
            `This transfer expired on ${outcome.expiresAt.toISOString()} before it was accepted. ` +
                'Ask for it to be proposed again.',
        );
    }
    return {
        transferId: outcome.transferId,
        agentId: outcome.agentId,
        ownerUserId: outcome.ownerUserId,
        previousOwnerUserId: outcome.previousOwnerUserId,
    };
}

/**
 * Cancel an open transfer — the initiator withdrawing it, the recipient
 * declining it, or another holder of the key. A lapsed one is stamped EXPIRED
 * rather than recorded as cancelled, because it was already over.
 */
export async function cancelAgentOwnershipTransfer(
    ctx: RequestContext,
    agentId: string,
    query: unknown,
) {
    assertCanTransferAgentOwnership(ctx);
    const parsed = CancelAgentOwnershipTransferQuerySchema.parse(query);
    const now = new Date();

    const outcome = await runInTenantContext(ctx, async (db) => {
        const transfer = await AgentOwnershipTransferRepository.findById(
            db,
            ctx,
            agentId,
            parsed.transferId,
        );
        if (!transfer) throw notFound('Ownership transfer not found');
        if (transfer.status !== 'PENDING') {
            throw conflict(
                `This transfer is no longer open (${transfer.status.toLowerCase()}); there is ` +
                    'nothing to cancel.',
            );
        }
        if (transfer.expiresAt.getTime() <= now.getTime()) {
            await AgentOwnershipTransferRepository.expireLapsedForAgent(db, ctx, agentId, now);
            return { refused: 'EXPIRED' as const };
        }

        const count = await AgentOwnershipTransferRepository.cancel(db, ctx, transfer.id, now);
        if (count === 0) {
            throw conflict(
                'This transfer was accepted or cancelled while this request was in flight. ' +
                    'Reload it to see its state.',
            );
        }

        await logEvent(db, ctx, {
            action: 'AGENT_OWNERSHIP_TRANSFER_CANCELLED',
            entityType: 'AgentOwnershipTransfer',
            entityId: transfer.id,
            detailsJson: {
                category: 'access',
                entityName: 'AgentOwnershipTransfer',
                operation: 'cancelled',
                summary: `Cancelled the ownership transfer of registered agent ${transfer.agentId}`,
                targetUserId: transfer.toOwnerUserId,
                agentId: transfer.agentId,
                fromStatus: 'PENDING',
                toStatus: 'CANCELLED',
                // Who it was: a recipient declining reads differently in an
                // incident review from an initiator withdrawing.
                declined: transfer.toOwnerUserId === ctx.userId,
                withdrawn: transfer.initiatedByUserId === ctx.userId,
            },
        });

        return {
            refused: null,
            transfer: present(
                { ...transfer, status: 'CANCELLED', cancelledAt: now, cancelledByUserId: ctx.userId },
                now,
            ),
        };
    });

    if (outcome.refused === 'EXPIRED') {
        throw conflict('This transfer had already expired; there is nothing to cancel.');
    }
    return outcome.transfer;
}

/**
 * The agent's open transfer, if any, and its recent history — each row with the
 * status it has NOW, so a lapsed proposal no request has yet stamped does not
 * read as acceptable.
 */
export async function getAgentOwnershipTransfers(ctx: RequestContext, agentId: string) {
    assertCanTransferAgentOwnership(ctx);
    const now = new Date();
    return runInTenantContext(ctx, async (db) => {
        const agent = await RegisteredAgentRepository.getLifecycleState(db, ctx, agentId);
        if (!agent) throw notFound('Registered agent not found');
        const open = await AgentOwnershipTransferRepository.findOpenForAgent(db, ctx, agentId);
        const history = await AgentOwnershipTransferRepository.listForAgent(db, ctx, agentId);
        const presentedOpen = open ? present(open, now) : null;
        return {
            agentId: agent.id,
            ownerUserId: agent.ownerUserId,
            open: presentedOpen && presentedOpen.effectiveStatus === 'PENDING' ? presentedOpen : null,
            history: history.map((row) => present(row, now)),
        };
    });
}
