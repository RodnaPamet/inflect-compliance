/**
 * Reading the policy card in force, and reserving against its daily budget.
 *
 * ## Freshness — read per request, never cached
 *
 * Exactly the rule `agent-tool-exposure.ts` states for the tool allowlist, and
 * for the same reason: an operator who narrows a card during an incident has to
 * see the next call refused, not the next deploy. A cache here would put a TTL
 * between the edit and the effect, and the whole claim of a policy card is that
 * its controls are immediate.
 *
 * ## Why this file talks to Prisma directly
 *
 * Same seam as `agent-tool-exposure.ts`. This runs inside the MCP tool boundary,
 * not inside a usecase, and it has no `RequestContext` to open a tenant
 * transaction with — the boundary is authorizing the request that would have
 * built one. The base client runs as a non-`app_user` session, so
 * `superuser_bypass` applies and the `tenantId` predicate in every WHERE below
 * is the isolation. It is not optional and it is not defence in depth here; it
 * is the only layer, which is why both functions take `tenantId` as their first
 * argument rather than reaching for it from anywhere.
 *
 * ## The reservation is an UPDATE, and it happens before the call proceeds
 *
 * A daily budget read and then incremented is a budget two concurrent calls can
 * both pass. `reserveDailyAction` increments and RETURNS in one statement, so
 * the number the caller compares against the cap already includes the call being
 * authorized and no two callers ever see the same one.
 *
 * The window rolls over inside the same statement: if the stored date is not
 * today the counter is SET to 1 rather than incremented. That makes the daily
 * reset a property of the write rather than a scheduled job — there is nothing
 * to run at midnight, and nothing to fail to run.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

import type { PolicyCardInForce } from './policy-card-evaluation';
import {
    isActionCap,
    narrowApprovalRung,
    narrowEscalationTriggers,
    type AgentPolicyCardValue,
} from './policy-card';

/**
 * The card version in force for one agent, or `null` when the agent has no card.
 *
 * `null` is NOT a refusal. An agent without a card contributes no policy-card
 * term at the boundary and is bounded exactly as 2/10 left it — see the header
 * of `policy-card.ts` for why an absent card must never mean "may do nothing".
 */
export async function loadPolicyCardInForce(
    tenantId: string,
    agentId: string,
): Promise<PolicyCardInForce | null> {
    const card = await prisma.agentPolicyCard.findUnique({
        where: { tenantId_agentId: { tenantId, agentId } },
        select: { id: true, currentVersion: true },
    });
    if (!card) return null;

    // A second point lookup rather than a nested `take: 1` ordered by version
    // descending. The two would agree today — the write path only ever appends
    // and moves the pointer to the new maximum — but "the newest version" and
    // "the version in force" are different claims, and a boundary that reads one
    // while meaning the other is exactly the kind of coincidence this subsystem
    // keeps finding after somebody adds a rollback.
    const version = await prisma.agentPolicyCardVersion.findUnique({
        where: {
            tenantId_cardId_version: {
                tenantId,
                cardId: card.id,
                version: card.currentVersion,
            },
        },
        select: {
            version: true,
            permittedTools: true,
            maxDataScope: true,
            maxAutonomyLevel: true,
            maxActionsPerRun: true,
            maxActionsPerDay: true,
            escalationTriggers: true,
            approvalRung: true,
        },
    });

    if (!version) {
        // A head pointing at a version that is not there. The card exists, so
        // the tenant HAS declared a policy; we simply cannot read it. Refusing
        // is the only defensible answer — falling back to "no card" would turn a
        // broken policy into an absent one, which is the failure direction that
        // makes a governance control worse than not having it.
        logger.error('policy card: current version row is missing', {
            tenantId,
            agentId,
            cardId: card.id,
            currentVersion: card.currentVersion,
        });
        return { cardId: card.id, version: card.currentVersion, value: DENY_EVERYTHING };
    }

    return {
        cardId: card.id,
        version: version.version,
        value: {
            permittedTools: version.permittedTools,
            maxDataScope: version.maxDataScope,
            maxAutonomyLevel: version.maxAutonomyLevel,
            // A budget column carrying a value that is not a rung of the ladder
            // can only have come from outside the usecase. Read as ZERO rather
            // than as itself: an unrecognised ceiling must not be spent.
            maxActionsPerRun: isActionCap(version.maxActionsPerRun)
                ? version.maxActionsPerRun
                : 0,
            maxActionsPerDay: isActionCap(version.maxActionsPerDay)
                ? version.maxActionsPerDay
                : 0,
            // Both String columns narrowed by membership, through the shared
            // helpers — see `policy-card.ts` for why the two defaults point in
            // opposite directions.
            escalationTriggers: narrowEscalationTriggers(version.escalationTriggers),
            approvalRung: narrowApprovalRung(version.approvalRung),
        },
    };
}

/**
 * The value a card resolves to when its policy cannot be read. Every dimension
 * at its floor, so no call passes any rule.
 */
const DENY_EVERYTHING: AgentPolicyCardValue = {
    permittedTools: [],
    maxDataScope: 'NONE',
    maxAutonomyLevel: -1,
    maxActionsPerRun: 0,
    maxActionsPerDay: 0,
    escalationTriggers: [],
    approvalRung: 'SECOND_APPROVER',
};

/** `YYYY-MM-DD` in UTC — the budget window, stated in one timezone. */
export function utcDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * Increment this agent's day counter and return the new value, INCLUDING the
 * call being authorized.
 *
 * Returns `Number.MAX_SAFE_INTEGER` when the UPDATE matched no row — the card
 * was deleted between the read above and here. The caller compares the result
 * against a cap, so an unreservable budget refuses rather than passes.
 */
export async function reserveDailyAction(
    tenantId: string,
    cardId: string,
    now: Date,
): Promise<number> {
    const day = utcDay(now);
    const rows = await prisma.$queryRaw<{ actionsInWindow: number }[]>`
        UPDATE "AgentPolicyCard"
           SET "actionsInWindow" = CASE
                   WHEN "usageWindowDate" = ${day}::date THEN "actionsInWindow" + 1
                   ELSE 1
               END,
               "usageWindowDate" = ${day}::date,
               "updatedAt" = NOW()
         WHERE "id" = ${cardId} AND "tenantId" = ${tenantId}
        RETURNING "actionsInWindow"`;

    const reserved = rows[0]?.actionsInWindow;
    if (typeof reserved !== 'number') {
        logger.error('policy card: daily budget reservation matched no card', {
            tenantId,
            cardId,
        });
        return Number.MAX_SAFE_INTEGER;
    }
    return reserved;
}
