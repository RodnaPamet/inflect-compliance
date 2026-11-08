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
 *     agent (#3671), still valid;
 *   • per key, `mcpCapable` (the `/api/mcp` gate's own predicate admits it)
 *     and `requiresTokenExchange` (#5004) — the facts `H2.audience_tokens`
 *     reads;
 *   • `enforcement` (#5004) — what Inflect's gate ENFORCES on the agent, the
 *     facts the scanner's H3 verdicts read. See `HarnessRegisterEnforcement`.
 *
 * LIVE means not deleted, not RETIRED, and not a legacy placeholder. Every read
 * takes one past its cap, so a register larger than one report may carry is
 * reported `truncated`, and the source reads it as incomplete.
 *
 * READ-ONLY: `findMany` and nothing else, inside the tenant's RLS context.
 */
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { MAX_AGENTS } from '@/lib/agentic/harness-contract';
import {
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    ceilingForRiskTier,
    resolveAutonomyCeiling,
    withinCeiling,
} from '@/lib/agentic/autonomy-ceiling';
import { admitsMcpEndpoint } from '@/lib/mcp/endpoint-scope';
import { isExternalToolName } from '@/lib/mcp/external-tool-name';
import { mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { verifyToolManifest, type ToolDefinition } from '@/lib/mcp/tool-manifest';

/** The agents one read returns: as many as one report may carry. */
export const HARNESS_REGISTER_AGENT_CAP = MAX_AGENTS;
/** Live API keys per agent the read returns. A report carries at most 100 credentials per agent. */
export const HARNESS_REGISTER_KEYS_PER_AGENT = 100;

/** Tool grants per agent the read considers. More is `truncated`. */
export const HARNESS_REGISTER_GRANTS_PER_AGENT = 200;
/** Runs naming a skill mount the read considers, across the whole read. More is "unknown". */
export const HARNESS_REGISTER_SKILL_RUNS_CAP = 2000;

export interface HarnessRegisterKey {
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string | null;
    /** The `/api/mcp` gate's own predicate (`admitsMcpEndpoint`) admits the key's scopes. */
    readonly mcpCapable: boolean;
    /** `TenantApiKey.requiresTokenExchange` (#5004): refused at `/api/mcp` unless exchanged. */
    readonly requiresTokenExchange: boolean;
}

/**
 * What Inflect's own gate ENFORCES on one agent (#5004). Every member is the
 * register's rule, decided here, never by the scanner:
 *
 *   • `autonomyCeiling` — the ceiling the MCP funnel applies to any key bound to
 *     the agent before a key's own narrowing: the agent's autonomy and its
 *     scored-tier cap, through the funnel's `resolveAutonomyCeiling`. An
 *     unscored agent is `DENY_CEILING` (-1). A key can only narrow it further,
 *     and so can a policy card.
 *   • `proposeRefused` / `orchestrateRefused` — that ceiling is below the
 *     propose / orchestrate rung, so the gate refuses every such call.
 *   • `grants` — the agent's tool grants by class. A built-in name the
 *     catalogue does not list as a read counts as propose, and every external
 *     tool counts as `external`, whatever it declares: the conservative side.
 *   • `manifestsPinned` — the agent holds at least one grant, every grant is a
 *     built-in tool, and each verifies `APPROVED` against the tenant's pin as
 *     the funnel would verify it now. An external tool's live definition is
 *     its server's to state, so it is never vouched for here.
 *   • `profileInForce` — an agent profile has an approved version in force.
 *   • `skillsMounted` — a run of the agent has mounted at least one skill;
 *     `null` when the runs could not be read in full.
 */
export interface HarnessRegisterEnforcement {
    readonly autonomyCeiling: number;
    readonly proposeRefused: boolean;
    readonly orchestrateRefused: boolean;
    readonly grants: { readonly read: number; readonly propose: number; readonly external: number };
    readonly manifestsPinned: boolean;
    readonly profileInForce: boolean;
    readonly skillsMounted: boolean | null;
}

export interface HarnessRegisterAgent {
    readonly registeredAgentId: string;
    readonly status: string;
    readonly ownerUserId: string;
    readonly axesDeclared: boolean;
    readonly tierFresh: boolean;
    readonly policyCardInForce: boolean;
    readonly apiKeys: readonly HarnessRegisterKey[];
    readonly confirmedPrincipals: readonly string[];
    readonly enforcement: HarnessRegisterEnforcement;
}

export interface HarnessRegisterReadOptions {
    readonly now?: Date;
    /**
     * This build's built-in tool definitions, by name — what the funnel hashes
     * against the tenant's pins. The MCP tool passes the registries' own
     * definitions (it may import them; this module may not without a cycle).
     * Absent, no grant verifies and `manifestsPinned` is false.
     */
    readonly builtInTools?: ReadonlyMap<string, ToolDefinition>;
}

export interface HarnessRegisterView {
    readonly asOf: string;
    readonly agents: readonly HarnessRegisterAgent[];
    /** More live agents, or more keys on one agent, than the read returns. */
    readonly truncated: boolean;
}

export async function readHarnessRegisterForScanner(
    ctx: RequestContext,
    options: HarnessRegisterReadOptions = {},
): Promise<HarnessRegisterView> {
    const now = options.now ?? new Date();
    const builtInTools = options.builtInTools ?? new Map<string, ToolDefinition>();
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

        const [keys, cards, assessments, confirmations, grants, profiles, skillRuns] = await Promise.all([
            db.tenantApiKey.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    agentId: { in: ids },
                    revokedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                orderBy: [{ agentId: 'asc' }, { id: 'asc' }],
                take: ids.length * HARNESS_REGISTER_KEYS_PER_AGENT + 1,
                select: { id: true, agentId: true, createdAt: true, expiresAt: true, scopes: true, requiresTokenExchange: true },
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
            db.registeredAgentTool.findMany({
                where: { tenantId: ctx.tenantId, agentId: { in: ids } },
                orderBy: [{ agentId: 'asc' }, { toolName: 'asc' }],
                take: ids.length * HARNESS_REGISTER_GRANTS_PER_AGENT + 1,
                select: { agentId: true, toolName: true },
            }),
            db.agentProfile.findMany({
                where: { tenantId: ctx.tenantId, agentId: { in: ids }, currentApprovedVersion: { not: null } },
                take: ids.length,
                select: { agentId: true },
            }),
            // Only runs that recorded a mount at all; `[]` ("mounted nothing")
            // is told apart in memory below.
            db.workflowRun.findMany({
                where: { tenantId: ctx.tenantId, agentId: { in: ids }, mountedSkills: { not: Prisma.DbNull } },
                orderBy: { id: 'asc' },
                take: HARNESS_REGISTER_SKILL_RUNS_CAP + 1,
                select: { agentId: true, mountedSkills: true },
            }),
        ]);
        if (grants.length > ids.length * HARNESS_REGISTER_GRANTS_PER_AGENT) truncated = true;
        const skillRunsRead = skillRuns.length <= HARNESS_REGISTER_SKILL_RUNS_CAP;
        if (keys.length > ids.length * HARNESS_REGISTER_KEYS_PER_AGENT) truncated = true;
        if (confirmations.length > ids.length * HARNESS_REGISTER_KEYS_PER_AGENT) truncated = true;

        const keysBy = new Map<string, HarnessRegisterKey[]>();
        for (const k of keys) {
            if (k.agentId === null) continue;
            const list = keysBy.get(k.agentId) ?? [];
            if (list.length >= HARNESS_REGISTER_KEYS_PER_AGENT) {
                truncated = true;
                continue;
            }
            // `scopes` is a Json column; a malformed value admits nothing.
            const scopes = Array.isArray(k.scopes) ? k.scopes.filter((v): v is string => typeof v === 'string') : [];
            list.push({
                id: k.id,
                createdAt: k.createdAt.toISOString(),
                expiresAt: k.expiresAt?.toISOString() ?? null,
                mcpCapable: admitsMcpEndpoint(scopes),
                requiresTokenExchange: k.requiresTokenExchange,
            });
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

        const grantsBy = new Map<string, string[]>();
        for (const g of grants) {
            const list = grantsBy.get(g.agentId) ?? [];
            list.push(g.toolName);
            grantsBy.set(g.agentId, list);
        }
        const builtInGranted = [...new Set(grants.map((g) => g.toolName).filter((n) => !isExternalToolName(n)))];
        const pins = builtInGranted.length
            ? await db.mcpToolManifestPin.findMany({
                  where: { tenantId: ctx.tenantId, toolName: { in: builtInGranted } },
                  take: builtInGranted.length,
                  select: {
                      toolName: true,
                      descriptionHash: true,
                      annotationsHash: true,
                      schemaHash: true,
                      manifestHash: true,
                      revision: true,
                      approvedByUserId: true,
                      approvalSource: true,
                  },
              })
            : [];
        const pinBy = new Map(pins.map((p) => [p.toolName, p]));
        // The funnel's own question, asked of stored rows: does this build's
        // definition verify against the tenant's pin? A tool with no definition
        // in this build, or no pin, does not.
        const verifies = (toolName: string): boolean => {
            const def = builtInTools.get(toolName);
            const pin = pinBy.get(toolName);
            if (!def || !pin) return false;
            return verifyToolManifest(def, pin).status === 'APPROVED';
        };
        const profiled = new Set(profiles.map((p) => p.agentId));
        const mounted = new Set(
            skillRuns
                .filter((r) => Array.isArray(r.mountedSkills) && r.mountedSkills.length > 0)
                .map((r) => r.agentId),
        );

        const enforcementOf = (a: (typeof agents)[number]): HarnessRegisterEnforcement => {
            const autonomyCeiling = resolveAutonomyCeiling({
                keyMax: null,
                agentAutonomy: a.autonomyLevel,
                riskTierCeiling: ceilingForRiskTier(a.riskTier),
            });
            const names = grantsBy.get(a.id) ?? [];
            const counts = { read: 0, propose: 0, external: 0 };
            for (const n of names) {
                if (isExternalToolName(n)) counts.external += 1;
                else if (mcpToolCapabilityClass(n) === 'read') counts.read += 1;
                else counts.propose += 1;
            }
            return {
                autonomyCeiling,
                proposeRefused: !withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.propose, autonomyCeiling),
                orchestrateRefused: !withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.orchestrate, autonomyCeiling),
                grants: counts,
                // At least one grant, in ONE expression with "every": zero
                // grants pin nothing.
                manifestsPinned: names.length > 0 && counts.external === 0 && names.every(verifies),
                profileInForce: profiled.has(a.id),
                skillsMounted: skillRunsRead ? mounted.has(a.id) : null,
            };
        };

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
                enforcement: enforcementOf(a),
            })),
        };
    });
}
