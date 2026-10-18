/**
 * WHICH ENTRA SERVICE PRINCIPAL BELONGS TO A CONTAINED AGENT (#3671, agentic
 * IAM 2c) — the one read both the request path and the target population use.
 *
 * Two facts, read together, and both must hold:
 *
 *   1. THE AGENT IS CONTAINED. An `AgentKillSwitch` row of AGENT scope with
 *      `reasonCode = 'OWNER_DEPARTED'` and no `liftedAt`. Only the owner-orphan
 *      pass can write that code (a CHECK pins it to the system actor) and only a
 *      completed ownership transfer can lift it (a trigger), so "contained" is a
 *      fact the database holds rather than a status somebody can toggle.
 *      Suspension is NOT the test: an agent reactivated without the kill lifted
 *      is still stopped at the tool boundary and still contained.
 *   2. THE AGENT NAMES A PRINCIPAL. A `DiscoveredAgent` whose `discoveredId` is
 *      `entra:sp:<objectId>` and whose `registeredAgentId` is the agent — the
 *      harness ingest's reconciliation, set only when the register row exists
 *      in this tenant. `discoveredId` is unique per tenant, so one principal
 *      belongs to at most one agent; an agent with several is ambiguous and is
 *      reported as such, never resolved by order.
 *
 * ONE module because two callers need exactly this and they must not disagree:
 * the request path decides what to propose or open, and the population decides
 * — at the moment the dispatch sends — whether that target is still admissible.
 * A second copy of the predicate is the copy that drifts, and here the drift
 * would be a directory write the bound no longer covers.
 *
 * @module usecases/agent-service-principal-links
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { internal } from '@/lib/errors/types';
import { isOwnerDepartedKill } from '@/lib/agentic/owner-orphan';
import {
    ENTRA_SP_DISCOVERED_PREFIX,
    servicePrincipalObjectIdOf,
} from '@/lib/agentic/service-principal-disable';

/** One agent's principal link, as read. */
export interface AgentServicePrincipalLink {
    readonly agentId: string;
    readonly discoveredAgentId: string;
    /** Lower-cased object id, or null when the harness id is not a GUID. */
    readonly servicePrincipalId: string | null;
}

export interface ContainedAgentLinks {
    /** Agents (of those asked about) with an OWNER_DEPARTED kill in force. */
    readonly containedAgentIds: ReadonlySet<string>;
    /** Every `entra:sp:` link of a CONTAINED, non-deleted agent. */
    readonly links: readonly AgentServicePrincipalLink[];
}

/**
 * Read the contained agents and their principal links.
 *
 * `agentIds` narrows to those agents (the request path asks about one); absent,
 * every contained agent in the tenant (the population).
 *
 * `limit` bounds BOTH reads, and reaching it on either THROWS rather than
 * returning a truncated answer: a population that silently omitted members
 * would refuse a legitimate target, and one that silently omitted the cap would
 * stop acting as a bound. `resolveTargetPopulation` turns the throw into
 * `unresolvable`, which is the honest outcome — "we could not decide", not
 * "nothing matched".
 */
export async function readContainedAgentServicePrincipalLinks(
    ctx: RequestContext,
    opts: { readonly agentIds?: readonly string[]; readonly limit: number },
): Promise<ContainedAgentLinks> {
    return runInTenantContext(ctx, async (db) => {
        const kills = await db.agentKillSwitch.findMany({
            where: {
                tenantId: ctx.tenantId,
                reasonCode: 'OWNER_DEPARTED',
                liftedAt: null,
                agentId: opts.agentIds ? { in: [...opts.agentIds] } : { not: null },
            },
            select: { agentId: true, reasonCode: true },
            orderBy: { id: 'asc' },
            take: opts.limit + 1,
        });
        if (kills.length > opts.limit) {
            // `internal`, a typed error: the read could not be answered whole,
            // which is our limit and not the caller's mistake.
            throw internal(
                `more than ${opts.limit} agents are contained, so the set cannot be read whole`,
            );
        }
        // Re-checked through the shared predicate rather than trusted from the
        // `where`, so "an OWNER_DEPARTED kill" has one definition in the code.
        const containedAgentIds = new Set(
            kills.filter((k) => isOwnerDepartedKill(k)).flatMap((k) => (k.agentId ? [k.agentId] : [])),
        );
        if (containedAgentIds.size === 0) return { containedAgentIds, links: [] };

        const rows = await db.discoveredAgent.findMany({
            where: {
                tenantId: ctx.tenantId,
                registeredAgentId: { in: [...containedAgentIds] },
                discoveredId: { startsWith: ENTRA_SP_DISCOVERED_PREFIX },
                // A deleted register row is not an agent anybody answers for,
                // and a principal reconciled to one is not this pass's to touch.
                registeredAgent: { deletedAt: null },
            },
            select: { id: true, discoveredId: true, registeredAgentId: true },
            orderBy: { id: 'asc' },
            take: opts.limit + 1,
        });
        if (rows.length > opts.limit) {
            throw internal(
                `more than ${opts.limit} principals are linked to contained agents, so the set `
                    + 'cannot be read whole',
            );
        }
        const links = rows.flatMap((r) =>
            r.registeredAgentId
                ? [
                      {
                          agentId: r.registeredAgentId,
                          discoveredAgentId: r.id,
                          servicePrincipalId: servicePrincipalObjectIdOf(r.discoveredId),
                      },
                  ]
                : [],
        );
        return { containedAgentIds, links };
    });
}

/**
 * The principals the population admits: one per contained agent that names
 * EXACTLY ONE well-formed principal.
 *
 * An agent with two links contributes neither — the request path refuses it as
 * ambiguous, and a population that admitted both would let the bound approve
 * what the request path will not ask for.
 */
export function admissibleServicePrincipalIds(links: readonly AgentServicePrincipalLink[]): string[] {
    const byAgent = new Map<string, AgentServicePrincipalLink[]>();
    for (const l of links) byAgent.set(l.agentId, [...(byAgent.get(l.agentId) ?? []), l]);
    const out: string[] = [];
    for (const group of byAgent.values()) {
        if (group.length !== 1) continue;
        const id = group[0].servicePrincipalId;
        if (id !== null) out.push(id);
    }
    return out;
}
