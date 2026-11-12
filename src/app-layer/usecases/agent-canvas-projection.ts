/**
 * ONE AGENT, PROJECTED FOR THE CANVAS (Phase 2.1 of
 * `docs/ai-architecture/langflow.md`).
 *
 * Read-only, and it stores nothing: no layout, no snapshot, no audit row. Every
 * layer is read through the surface that already owns it, so the canvas can
 * never show more than the tab it summarises, nor disagree with it:
 *
 *   • THE ENVELOPE: `getRegisteredAgent` (the inventory read, which is also the
 *     tenant boundary — another tenant's id is the same 404 as a missing one)
 *     and `listAgentTools` (grants, the effective ceiling, the rung each tool
 *     needs). The policy-card version, the breaker state and the kill switch
 *     are the three facts the agent page's other tabs show, read here as the
 *     single columns this view draws.
 *   • THE PROFILE: `getAgentProfile`, whose own gate (the profile switch, then
 *     `admin.agent_registry`) decides whether the layer exists. Its refusal is
 *     caught and NAMED, never re-implemented: a second copy of that gate is the
 *     one that drifts.
 *   • TOOL STATES: `offerToolSet`, the function every engine calls, run against
 *     the invocation a run of this agent started by the viewer would get
 *     (`resolveMcpInvocation({ ...ctx, agentId })`, the seam the Test run and
 *     the interactive run use). So the view's "offered" is a run's "offered".
 *     It is NOT run for an agent that is not ACTIVE: admission refuses that
 *     agent's runs, and the probe's answer would describe a run that cannot
 *     exist, so every tool reads `AGENT_NOT_ACTIVE` instead.
 *   • REGISTRY WORKFLOWS and WHERE IT IS USED: the `INVOKE_AGENT` rules that
 *     name this agent, the process maps whose nodes own them, and the steps of
 *     each workflow key that is a code-registered definition.
 *
 * Building the invocation is not free: like a run's, it lists the tools of
 * every external connection the agent holds a grant on. That is the price of
 * "the view cannot disagree with a run", and it is paid once per open.
 */
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { offerToolSet } from '@/lib/agentic/engine-tools';
import { mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { withinCeiling } from '@/lib/agentic/autonomy-ceiling';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { isReasoningEngine } from '@/lib/agentic/agent-driver';
import type {
    AgentCanvasGrant,
    AgentCanvasProfileLayer,
    AgentCanvasProfileToolState,
    AgentCanvasProjection,
    AgentCanvasWorkflow,
} from '@/lib/agentic/agent-canvas-projection';
import { runInTenantContext } from '@/lib/db-context';
import { AppError } from '@/lib/errors/types';
import type { RequestContext } from '../types';
import { getRegisteredAgent } from './agent-registry';
import { listAgentTools } from './agent-tool-exposure';
import { getAgentProfile, type AgentProfileView } from './agent-profiles';

/** The guard source prefix the probe names; its `run` closures are never called. */
const CANVAS_VIEW_SOURCE = 'agent-canvas-view';

/** At most this many `INVOKE_AGENT` rules are read for one agent. */
const MAX_INVOKING_RULES = 200;

/**
 * The profile layer, or why there is none. `getAgentProfile` is the gate: its
 * 404 `PROFILES_DISABLED` is "the surface does not exist here", its 403 is "you
 * may not read a profile". Any other failure is not a gate and is re-thrown.
 */
async function readProfile(ctx: RequestContext, agentId: string): Promise<AgentProfileView | 'OFF' | 'NOT_PERMITTED'> {
    try {
        return await getAgentProfile(ctx, agentId);
    } catch (err) {
        if (err instanceof AppError) {
            const reason = (err.details as { reason?: unknown } | undefined)?.reason;
            if (err.status === 404 && reason === 'PROFILES_DISABLED') return 'OFF';
            if (err.status === 403) return 'NOT_PERMITTED';
        }
        throw err;
    }
}

/**
 * Which version the canvas shows: the one asked for, else the approved one in
 * force, else the newest. The layer says which it is (`inForce`, `status`), so
 * a draft is never drawn as if it ran.
 */
function pickVersion(view: AgentProfileView, versionId: string | undefined) {
    if (versionId) return view.versions.find((v) => v.id === versionId) ?? null;
    const inForce = view.profile?.currentApprovedVersion ?? null;
    return view.versions.find((v) => v.version === inForce) ?? view.versions[0] ?? null;
}

/**
 * Each profile tool as a run of this agent, started by this viewer, is offered
 * it. The builder hands back the tool's name and nothing else; no `run`
 * closure is ever invoked, so the probe performs no call and writes no row.
 */
async function profileToolStates(
    ctx: RequestContext,
    agentId: string,
    agentStatus: string,
    toolNames: readonly string[],
    readOnly: boolean,
): Promise<AgentCanvasProfileToolState[]> {
    if (agentStatus !== 'ACTIVE') {
        return toolNames.map((name) => ({ name, offered: false, reason: 'AGENT_NOT_ACTIVE' as const }));
    }
    const inv = await resolveMcpInvocation({ ...ctx, agentId });
    const set = offerToolSet(inv, (offered) => offered.tool.name, {
        sourcePrefix: CANVAS_VIEW_SOURCE,
        readOnly,
        profileTools: toolNames,
    });
    const offered = new Set(set.tools);
    const omitted = new Map(set.omitted.map((o) => [o.name, o.reason]));
    return toolNames.map((name): AgentCanvasProfileToolState => {
        if (offered.has(name)) return { name, offered: true };
        // A name the probe neither offered nor listed cannot happen (every
        // profile tool is offered, omitted by a probe term, or lost), and is
        // reported as lost rather than as offered if it ever does.
        return { name, offered: false, reason: omitted.get(name) ?? 'PROFILE_TOOL_NOT_GRANTED' };
    });
}

async function profileLayer(
    ctx: RequestContext,
    agentId: string,
    agentStatus: string,
    versionId: string | undefined,
): Promise<AgentCanvasProjection['profile']> {
    const view = await readProfile(ctx, agentId);
    if (view === 'OFF' || view === 'NOT_PERMITTED') return { state: view };
    const v = pickVersion(view, versionId);
    if (!v) return { state: 'NONE' };
    // The resolver's rule (`agent-profile-runs.ts`): an ANSWER_ONLY version is
    // offered the read surface only.
    const readOnly = v.outputKind === 'ANSWER_ONLY';
    const mountable = new Set(view.options.skills.map((s) => `${s.origin}:${s.name}`));
    const layer: AgentCanvasProfileLayer = {
        state: 'SHOWN',
        version: v.version,
        status: v.status,
        inForce: view.profile?.currentApprovedVersion === v.version,
        modelTier: v.modelTier,
        effort: v.effort,
        maxTurns: v.maxTurns,
        outputKind: v.outputKind,
        readOnly,
        allowedTriggers: [...v.allowedTriggers],
        tools: await profileToolStates(ctx, agentId, agentStatus, v.toolNames, readOnly),
        skills: v.skillRefs.map((s) => ({ origin: s.origin, name: s.name, mountable: mountable.has(`${s.origin}:${s.name}`) })),
        instructions: v.instructions,
    };
    return layer;
}

/**
 * The envelope's grants, or null for a retired agent: retirement took every
 * grant away and is permanent, which is why `listAgentTools` refuses to list
 * one. Asked by status rather than by catching that refusal, so a different
 * 400 is never mistaken for a retirement.
 */
async function grantsOf(
    ctx: RequestContext,
    agentId: string,
    agentStatus: string,
): Promise<{ grants: AgentCanvasGrant[] | null; ceiling: number | null }> {
    if (agentStatus === 'RETIRED') return { grants: null, ceiling: null };
    const tools = await listAgentTools(ctx, agentId);
    const grants = tools.granted.map((g): AgentCanvasGrant => {
        const required = tools.requiredAutonomy[g.toolName];
        return {
            name: g.toolName,
            capability: mcpToolCapabilityClass(g.toolName),
            // A tool the catalogue no longer carries has no rung, and is not
            // reachable at any ceiling.
            requiredAutonomy: required ?? -1,
            withinCeiling: required !== undefined && withinCeiling(required, tools.autonomyCeiling),
        };
    });
    return { grants, ceiling: tools.autonomyCeiling };
}

/**
 * The rules that invoke this agent, the maps whose nodes own them, and the
 * code-registered workflows those rules name. A profile run key is not a
 * registry workflow and is left to the profile layer.
 */
async function usageOf(ctx: RequestContext, agentId: string) {
    return runInTenantContext(ctx, async (db) => {
        const [policyCard, breaker, rules] = await Promise.all([
            db.agentPolicyCard.findFirst({ where: { tenantId: ctx.tenantId, agentId }, select: { currentVersion: true } }),
            db.agentCircuitBreaker.findFirst({ where: { tenantId: ctx.tenantId, agentId }, select: { state: true } }),
            db.automationRule.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    actionType: 'INVOKE_AGENT',
                    deletedAt: null,
                    actionConfigJson: { path: ['agentId'], equals: agentId },
                },
                select: { id: true, actionConfigJson: true },
                orderBy: { id: 'asc' },
                take: MAX_INVOKING_RULES,
            }),
        ]);
        const ruleIds = rules.map((r) => r.id);
        const nodes =
            ruleIds.length === 0
                ? []
                : await db.processNode.findMany({
                      where: {
                          tenantId: ctx.tenantId,
                          nodeType: 'agent',
                          OR: ruleIds.map((id) => ({ dataJson: { path: ['ruleId'], equals: id } })),
                      },
                      select: { nodeKey: true, processMap: { select: { id: true, name: true } } },
                      orderBy: [{ processMapId: 'asc' }, { nodeKey: 'asc' }],
                      take: MAX_INVOKING_RULES,
                  });
        const keys = [
            ...new Set(
                rules
                    .map((r) => (r.actionConfigJson as { workflowKey?: unknown } | null)?.workflowKey)
                    .filter((k): k is string => typeof k === 'string'),
            ),
        ].sort();
        const workflows: AgentCanvasWorkflow[] = keys.flatMap((key) => {
            const def = getWorkflowDefinition(key);
            if (!def) return [];
            return [
                {
                    key,
                    name: def.name,
                    orderEnforced: !(def.driver && isReasoningEngine(def.driver)),
                    steps: def.steps.map((s) => ({ kind: s.kind, label: s.label, tool: 'tool' in s ? s.tool : null })),
                },
            ];
        });
        return {
            policyCardVersion: policyCard?.currentVersion ?? null,
            breakerState: breaker?.state ?? null,
            workflows,
            usedIn: nodes.map((n) => ({ mapId: n.processMap.id, mapName: n.processMap.name, nodeKey: n.nodeKey })),
        };
    });
}

/**
 * Project one agent for the canvas. Throws the register's own 404 for an agent
 * this tenant does not hold, and its own 403 for a reader without the inventory
 * read, before anything else is read.
 */
export async function projectAgentForCanvas(
    ctx: RequestContext,
    agentId: string,
    opts: { versionId?: string } = {},
): Promise<AgentCanvasProjection> {
    const agent = await getRegisteredAgent(ctx, agentId);
    const [{ grants, ceiling }, usage, profile, kill] = await Promise.all([
        grantsOf(ctx, agent.id, agent.status),
        usageOf(ctx, agent.id),
        profileLayer(ctx, agent.id, agent.status, opts.versionId),
        resolveKillState(ctx.tenantId, agent.id),
    ]);
    return {
        agent: {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            autonomyLevel: agent.autonomyLevel,
            riskTier: agent.riskTier ?? null,
            effectiveCeiling: ceiling ?? -1,
        },
        envelope: {
            grants,
            policyCardVersion: usage.policyCardVersion,
            breakerState: usage.breakerState,
            killScope: kill?.scope ?? null,
        },
        profile,
        workflows: usage.workflows,
        usedIn: usage.usedIn,
    };
}
