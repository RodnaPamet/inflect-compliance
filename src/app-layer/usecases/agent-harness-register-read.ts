/**
 * THE REGISTER, AS A HARNESS SCANNER READS IT (#3686, part c; owner decisions
 * 3, 4 and 7 on the issue, 2026-10-19).
 *
 * The scanner's `inflect-register` source reports each live registered agent,
 * and each service principal a person confirmed as one, so that a scan links a
 * principal to the register from the register's OWN record — never from a
 * label in the estate, which the estate's administrator could write. This is
 * the read behind that source, served through the MCP read tool
 * `get_harness_register`.
 *
 * WHO MAY READ IT. `admin.agent_harness_ingest`, the key a scanner's API key
 * carries and nothing else does: the scanner reads the register with the key
 * it posts its report with (owner decision 3). OWNER and ADMIN hold it too.
 *
 * WHAT IT RETURNS — only what the report's `inflect-register` source carries:
 * ids, statuses, dates and flags. No agent name, no description, no key name
 * or prefix, no free text. Each flag is the register's own rule, decided here
 * rather than by the scanner:
 *
 *   • `axesDeclared` — autonomy, data access, reversibility and provenance are
 *     all set;
 *   • `tierFresh` — a risk tier is set AND the newest completed assessment is
 *     not stale, the rule the governance reports apply (`ASSESSED`); an agent
 *     never assessed is not fresh;
 *   • `policyCardInForce` — the agent has a policy card;
 *   • `apiKeys` — the agent's own keys that are not revoked and not expired:
 *     id, creation and expiry, nothing else;
 *   • `confirmedPrincipals` — the `discoveredId`s a person confirmed as this
 *     agent (#3671), still valid.
 *
 * LIVE means not deleted, not RETIRED, and not a legacy placeholder. Every read
 * takes one past its cap, so a register larger than one report may carry is
 * reported `truncated`, and the source reads it as incomplete.
 *
 * READ-ONLY: `findMany` and nothing else, inside the tenant's RLS context.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { MAX_AGENTS } from '@/lib/agentic/harness-contract';

/** The agents one read returns: as many as one report may carry. */
export const HARNESS_REGISTER_AGENT_CAP = MAX_AGENTS;
/** Live API keys per agent the read returns. A report carries at most 100 credentials per agent. */
export const HARNESS_REGISTER_KEYS_PER_AGENT = 100;

export interface HarnessRegisterAgent {
    readonly registeredAgentId: string;
    readonly status: string;
    readonly ownerUserId: string;
    readonly axesDeclared: boolean;
    readonly tierFresh: boolean;
    readonly policyCardInForce: boolean;
    readonly apiKeys: readonly { readonly id: string; readonly createdAt: string; readonly expiresAt: string | null }[];
    readonly confirmedPrincipals: readonly string[];
}

export interface HarnessRegisterView {
    readonly asOf: string;
    readonly agents: readonly HarnessRegisterAgent[];
    /** More live agents, or more keys on one agent, than the read returns. */
    readonly truncated: boolean;
}

export async function readHarnessRegisterForScanner(ctx: RequestContext, now: Date = new Date()): Promise<HarnessRegisterView> {
    if (!ctx.appPermissions.admin.agent_harness_ingest) {
        throw forbidden('Reading the register for a harness scan requires admin.agent_harness_ingest');
    }
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.registeredAgent.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, isLegacyPlaceholder: false, status: { not: 'RETIRED' } },
            orderBy: { id: 'asc' },
            take: HARNESS_REGISTER_AGENT_CAP + 1,
            select: {
                id: true,
                status: true,
                ownerUserId: true,
                autonomyLevel: true,
                dataAccessScope: true,
                reversibility: true,
                provenance: true,
                riskTier: true,
            },
        });
        let truncated = rows.length > HARNESS_REGISTER_AGENT_CAP;
        const agents = rows.slice(0, HARNESS_REGISTER_AGENT_CAP);
        const ids = agents.map((a) => a.id);
        if (ids.length === 0) return { asOf: now.toISOString(), agents: [], truncated };

        const [keys, cards, assessments, confirmations] = await Promise.all([
            db.tenantApiKey.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    agentId: { in: ids },
                    revokedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                orderBy: [{ agentId: 'asc' }, { id: 'asc' }],
                take: ids.length * HARNESS_REGISTER_KEYS_PER_AGENT + 1,
                select: { id: true, agentId: true, createdAt: true, expiresAt: true },
            }),
            db.agentPolicyCard.findMany({
                where: { tenantId: ctx.tenantId, agentId: { in: ids } },
                take: ids.length,
                select: { agentId: true },
            }),
            // Newest completed first, one per agent: the judgement in force.
            db.agentRiskAssessment.findMany({
                where: { tenantId: ctx.tenantId, agentId: { in: ids }, status: 'COMPLETED' },
                orderBy: [{ agentId: 'asc' }, { completedAt: 'desc' }],
                distinct: ['agentId'],
                take: ids.length,
                select: { agentId: true, staleAt: true },
            }),
            db.agentServicePrincipalConfirmation.findMany({
                where: { tenantId: ctx.tenantId, registeredAgentId: { in: ids }, invalidatedAt: null },
                orderBy: [{ registeredAgentId: 'asc' }, { discoveredId: 'asc' }],
                take: ids.length * HARNESS_REGISTER_KEYS_PER_AGENT + 1,
                select: { registeredAgentId: true, discoveredId: true },
            }),
        ]);
        if (keys.length > ids.length * HARNESS_REGISTER_KEYS_PER_AGENT) truncated = true;
        if (confirmations.length > ids.length * HARNESS_REGISTER_KEYS_PER_AGENT) truncated = true;

        const keysBy = new Map<string, { id: string; createdAt: string; expiresAt: string | null }[]>();
        for (const k of keys) {
            if (k.agentId === null) continue;
            const list = keysBy.get(k.agentId) ?? [];
            if (list.length >= HARNESS_REGISTER_KEYS_PER_AGENT) {
                truncated = true;
                continue;
            }
            list.push({ id: k.id, createdAt: k.createdAt.toISOString(), expiresAt: k.expiresAt?.toISOString() ?? null });
            keysBy.set(k.agentId, list);
        }
        const carded = new Set(cards.map((c) => c.agentId));
        const fresh = new Set(assessments.filter((a) => a.staleAt === null).map((a) => a.agentId));
        const principalsBy = new Map<string, string[]>();
        for (const c of confirmations) {
            const list = principalsBy.get(c.registeredAgentId) ?? [];
            if (!list.includes(c.discoveredId)) list.push(c.discoveredId);
            principalsBy.set(c.registeredAgentId, list);
        }

        return {
            asOf: now.toISOString(),
            truncated,
            agents: agents.map((a) => ({
                registeredAgentId: a.id,
                status: String(a.status),
                ownerUserId: a.ownerUserId,
                axesDeclared:
                    Number.isInteger(a.autonomyLevel) &&
                    a.dataAccessScope !== null &&
                    a.reversibility !== null &&
                    a.provenance !== null,
                tierFresh: a.riskTier !== null && fresh.has(a.id),
                policyCardInForce: carded.has(a.id),
                apiKeys: keysBy.get(a.id) ?? [],
                confirmedPrincipals: principalsBy.get(a.id) ?? [],
            })),
        };
    });
}
