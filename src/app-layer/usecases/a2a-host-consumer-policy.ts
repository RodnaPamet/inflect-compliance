/**
 * THE POLICY LINE ON THE A2A ROUTE, held as a property of the GRANT TABLES
 * (#3864; roadmap #3859).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS BEING HELD, AND WHY IT IS NOT A CONVENTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The A2A route's whole policy argument (#3860) is that **Inflect calls no SAP
 * API**. Joule holds the SAP access; Inflect's agent is handed facts and judges
 * them against the tenant's controls. The moment Inflect's agent can reach an
 * SAP API, §2.2.2(a) re-engages and the route is on the MCP route's terms.
 *
 * On this platform "can reach" is not a property of code — it is a property of
 * what the receiving agent is GRANTED. One stray grant of an external tool and
 * the claim is false, with nothing failing. So the claim is checked against
 * `RegisteredAgentTool`, the grant table itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO FLAG, AND THAT IS THE DECISION (owner, 2026-10-21, on #3864)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The issue asked for a guard on connections flagged as carrying business-system
 * access, and for a flag to be added if none existed. None did. The flag WAS
 * added — `IntegrationConnection.reachesBusinessSystem`, for the MCP route to
 * reuse — and this guard deliberately does not read it.
 *
 * A guard gated on a flag passes for precisely the connection it exists to
 * catch: an ERP connection nobody remembered to flag. Worse, no test could tell
 * "no violation" from "nobody set the flag", so the guard would be green in both
 * worlds and #3860's policy claim would be asserted while false.
 *
 * So the rule is the stricter one the workflow was specified to need anyway —
 * **the receiving agent of a live host consumer may hold NO external tool at
 * all.** `sap-transaction-review`'s tool list is "Inflect's own read tools only
 * — NOTHING from an external connection", so nothing legitimate is refused.
 *
 * ## Why this cannot go stale
 *
 * `isExternalToolName` is a PURE PREFIX TEST on the grant's own stored name
 * (`src/lib/mcp/external-tool-name.ts`). There is no allowlist, no provider
 * list, and no catalogue to keep current: a connection to a system nobody has
 * heard of, advertising a tool nobody has named, still produces a grant whose
 * NAME SHAPE says external. A new integration cannot slip past by being new.
 *
 * ## Which consumers put an agent in scope
 *
 * Only those that can actually receive traffic — `status: ACTIVE` and
 * `revokedAt: null`, the same pair admission re-reads uncached on every request
 * (`a2a-host-consumer-admission.ts`). A revoked consumer receives nothing, so
 * an agent in scope only through a revoked consumer is NOT a violation; holding
 * it against the tenant would be a false alarm about a principal that cannot
 * call.
 */
import { isExternalToolName, parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { runInTenantContext } from '@/lib/db-context';

import type { RequestContext } from '../types';

/** One grant that breaks the policy line. */
export interface HostConsumerExternalGrant {
    readonly hostConsumerId: string;
    readonly receivingAgentId: string;
    /** The grant's stored name, qualified. */
    readonly toolName: string;
    /**
     * The connection the name resolves to, or `null` when the name is external
     * by prefix but unparseable. `null` is STILL a violation: a malformed
     * external grant is not a safe one, and treating it as "not external
     * after all" would make a corrupt row the way through.
     */
    readonly connectionId: string | null;
}

/**
 * Every external tool grant held by the receiving agent of a live host consumer
 * in this tenant. Empty means the policy line holds.
 *
 * Reads two tables and nothing else, so it is cheap enough to call per request:
 * the consumers, then the grants for the agents they name.
 */
export async function findHostConsumerExternalGrants(
    ctx: RequestContext,
): Promise<readonly HostConsumerExternalGrant[]> {
    const consumers = await runInTenantContext(ctx, (db) =>
        db.hostConsumer.findMany({
            where: { tenantId: ctx.tenantId, status: 'ACTIVE', revokedAt: null },
            select: { id: true, receivingAgentId: true },
        }),
    );
    if (consumers.length === 0) return [];

    const agentIds = [...new Set(consumers.map((c) => c.receivingAgentId))];
    const grants = await runInTenantContext(ctx, (db) =>
        db.registeredAgentTool.findMany({
            where: { tenantId: ctx.tenantId, agentId: { in: agentIds } },
            select: { agentId: true, toolName: true },
        }),
    );

    const violations: HostConsumerExternalGrant[] = [];
    for (const consumer of consumers) {
        for (const grant of grants) {
            if (grant.agentId !== consumer.receivingAgentId) continue;
            if (!isExternalToolName(grant.toolName)) continue;
            violations.push({
                hostConsumerId: consumer.id,
                receivingAgentId: consumer.receivingAgentId,
                toolName: grant.toolName,
                connectionId: parseExternalToolName(grant.toolName)?.connectionId ?? null,
            });
        }
    }
    return violations;
}

/**
 * Does THIS agent hold any external tool grant? The per-request form, used by
 * the inbound host-consumer path.
 *
 * Narrower than `findHostConsumerExternalGrants` on purpose: admission already
 * knows which agent is receiving, so re-reading every consumer in the tenant
 * would be work the request does not need. The two are checked against each
 * other by test, because a narrow fast path that disagrees with the broad audit
 * is worse than either alone.
 */
export async function agentHoldsExternalToolGrant(ctx: RequestContext, agentId: string): Promise<boolean> {
    const grants = await runInTenantContext(ctx, (db) =>
        db.registeredAgentTool.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            select: { toolName: true },
        }),
    );
    return grants.some((g) => isExternalToolName(g.toolName));
}
