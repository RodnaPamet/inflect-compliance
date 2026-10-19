/**
 * PROCEDURE 5 — `agent.authority_conformance` (library v1, #3676).
 *
 * Did every tool an agent used sit inside the authority approved for it at the
 * time? A test of CONDUCT: the unit is one `AgentBehaviourWindow` (one agent,
 * one hour, the calls `authorizeToolCall` allowed), and for every tool in it:
 *
 *   A1 a grant was held                → TOOL_NOT_GRANTED
 *   A2 the card version in force permitted it
 *                                      → TOOL_NOT_ON_CARD / NO_CARD_IN_FORCE /
 *                                        INVOCATION_UNRECORDED (untestable)
 *   A3 that card version could exercise it
 *                                      → TOOL_UNEXERCISABLE /
 *                                        TOOL_NOT_IN_CURRENT_CATALOGUE (untestable)
 *   A4 the agent was ACTIVE            → AGENT_NOT_ACTIVE
 *   A5 the window is the complete record → WINDOW_UNDERCOUNTS (untestable)
 *
 * Re-performed by REBUILDING each agent's grant and status history from the
 * hash-chained `AuditLog`, resolving the card version each call names, and
 * re-applying `withholdingReasonForTool`. It never reads
 * `AgentPolicyCard.actionsInWindow`, the circuit breaker's verdicts on the
 * window, or the outcome of the `AGENTIC_POLICY_CARD_CONFORMANCE` control
 * test. Because the history is audit rows, a tenant whose chain does not verify
 * to the period end is INCONCLUSIVE (`AUDIT_CHAIN_BROKEN`).
 *
 * ── "FOR THE HOUR", READ AT THE CALLS ───────────────────────────────────────
 *
 * A1 and A4 are asked at each recorded call inside the hour, and over the whole
 * hour only when the hour holds no per-call record. A tool granted at 10:20 and
 * called at 10:25 was held for every call the window counts; reading the
 * catalogue's "for the whole hour" against 10:00 would raise an exception
 * against a legitimate grant. A call made before the grant is still caught: it
 * is checked at its own time. This reading is library v1's, proposed to
 * internal audit with the rest of it.
 */
import { verifyTenantChain } from '@/lib/audit/verify';
import type { AttributeResult } from '@/lib/agentic/audit-procedure-library';
import { judgeUnit } from '@/lib/agentic/audit-procedure-library';
import { withholdingReasonForTool } from '@/lib/agentic/policy-card-evaluation';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';

import { groupBy, POPULATION_CAP, type PopulationReading, type ProcedureModule, type ProcedureReadContext } from './shared';

const HOUR_MS = 3_600_000;
/** Per-call records read across the sampled windows (at most 25 hours of calls). */
const INVOCATION_CAP = 20_000;
/** Grant and status history rows read for the sampled agents. */
const HISTORY_CAP = 20_000;

const GRANT_EVENTS = ['AGENT_TOOL_GRANTED', 'AGENT_TOOL_REVOKED', 'AGENT_RETIREMENT_TOOLS_DROPPED'] as const;
const STATUS_EVENTS = ['AGENT_REGISTERED', 'AGENT_ACTIVATED', 'AGENT_SUSPENDED', 'AGENT_RETIRED'] as const;
const PROPOSE_KIND = new Map(PROPOSE_TOOLS.map((t) => [t.name, t.kind as string] as const));

interface HistoryRow {
    entityId: string;
    action: string;
    createdAt: Date;
    detailsJson: unknown;
}

function detailsOf(json: unknown): { before?: Record<string, unknown>; after?: Record<string, unknown> } {
    return typeof json === 'object' && json !== null ? (json as never) : {};
}

/** The agent an `MCP_TOOL_INVOKED` row names, or null. */
function agentIdOf(json: unknown): string | null {
    const v = typeof json === 'object' && json !== null ? (json as { agentId?: unknown }).agentId : null;
    return typeof v === 'string' ? v : null;
}

/** Does this grant event concern `tool`? A retirement drops every tool. */
function concernsTool(row: HistoryRow, tool: string): boolean {
    if (row.action === 'AGENT_RETIREMENT_TOOLS_DROPPED') return true;
    const d = detailsOf(row.detailsJson);
    return d.after?.toolName === tool || d.before?.toolName === tool;
}

/**
 * Was `tool` granted to the agent at time `t`, from its grant history? The
 * latest event at or before `t` decides. With none: a history that begins with
 * a revoke means it was held before (granted before the trail recorded
 * grants); one that begins with a grant means it was not; and no history at
 * all falls back to the current grant row, held when it existed by `t`.
 */
export function grantHeldAt(
    events: readonly HistoryRow[],
    currentGrantCreatedAt: Date | null,
    t: number,
): boolean {
    let last: HistoryRow | null = null;
    for (const e of events) if (e.createdAt.getTime() <= t) last = e;
    if (last) return last.action === 'AGENT_TOOL_GRANTED';
    if (events.length > 0) return events[0].action !== 'AGENT_TOOL_GRANTED';
    return currentGrantCreatedAt !== null && currentGrantCreatedAt.getTime() <= t;
}

/** The agent's status at time `t` from its status history, or null when nothing recorded one by then. */
export function statusAt(events: readonly HistoryRow[], t: number): string | null {
    let status: string | null = null;
    for (const e of events) {
        if (e.createdAt.getTime() > t) break;
        if (e.action === 'AGENT_ACTIVATED') status = 'ACTIVE';
        else if (e.action === 'AGENT_SUSPENDED') status = 'SUSPENDED';
        else if (e.action === 'AGENT_RETIRED') status = 'RETIRED';
        else if (e.action === 'AGENT_REGISTERED') {
            const s = detailsOf(e.detailsJson).after?.status;
            status = typeof s === 'string' ? s : status;
        }
    }
    return status;
}

export const agentAuthorityConformance: ProcedureModule = {
    async read(rc: ProcedureReadContext): Promise<PopulationReading> {
        const { db, tenantId } = rc;
        // The agents first, so the window read is anchored on the table's index
        // prefix (tenantId, agentId, windowStart) and bounded by the period's
        // range on its third column: its cost is one month of hours per agent,
        // never the ledger's whole history (`AgentBehaviourWindow` has no
        // retention sweep; docs/adr/0002). Soft-deleted, suspended and retired
        // agents are in: the calls happened. The legacy placeholder is out.
        const agents = await db.registeredAgent.findMany({
            where: { tenantId, isLegacyPlaceholder: false },
            select: { id: true, isAuditor: true },
            orderBy: { id: 'asc' },
            take: POPULATION_CAP + 1,
        });
        const agentIds = agents.slice(0, POPULATION_CAP).map((a) => a.id);
        // An AUDITOR's own windows are not in the population: the auditor is
        // not the auditee (rule 8), and the independence rule already counts
        // no auditor as an audited agent. They are counted, not tested.
        const auditorIds = new Set(agents.filter((a) => a.isAuditor).map((a) => a.id));
        const windows =
            agentIds.length === 0
                ? []
                : await db.agentBehaviourWindow.findMany({
                      where: {
                          tenantId,
                          agentId: { in: agentIds },
                          windowStart: { gte: rc.periodStart, lt: rc.periodEnd },
                      },
                      select: { id: true, agentId: true },
                      orderBy: { id: 'asc' },
                      take: POPULATION_CAP + 1,
                  });
        const audited = windows.slice(0, POPULATION_CAP).filter((w) => !auditorIds.has(w.agentId));
        const auditorWindows = windows.slice(0, POPULATION_CAP).length - audited.length;
        // Reported, not tested: refused calls are the boundary working, and a
        // credential bound to no agent writes no window.
        const [counts] = await db.$queryRaw<{ refused: number; unbound: number }[]>`
            SELECT
                count(*) FILTER (WHERE "action" = 'AUTHZ_DENIED'
                                   AND "detailsJson"->>'gate' = 'mcp_tool_invocation')::int AS refused,
                count(*) FILTER (WHERE "action" = 'MCP_TOOL_INVOKED'
                                   AND ("detailsJson"->>'agentId') IS NULL)::int AS unbound
              FROM "AuditLog"
             WHERE "tenantId" = ${tenantId}
               AND "createdAt" >= ${rc.periodStart}
               AND "createdAt" < ${rc.periodEnd}
               AND "action" IN ('AUTHZ_DENIED', 'MCP_TOOL_INVOKED')`;

        return {
            unitIds: audited.map((w) => w.id),
            truncated: agents.length > POPULATION_CAP || windows.length > POPULATION_CAP,
            populationExceptions: [],
            facts: [
                `refusedToolCalls=${counts?.refused ?? 0}`,
                `unboundToolCalls=${counts?.unbound ?? 0}`,
                `auditorWindowsExcluded=${auditorWindows}`,
            ],
            async preconditions() {
                const chain = await verifyTenantChain(tenantId, { to: rc.periodEnd, maxBreaks: 1 });
                return chain.valid ? null : 'AUDIT_CHAIN_BROKEN';
            },
            async evaluate(sampled) {
                const sampledWindows =
                    agentIds.length === 0
                        ? []
                        : await db.agentBehaviourWindow.findMany({
                              where: { tenantId, agentId: { in: agentIds }, id: { in: [...sampled] } },
                              select: { id: true, agentId: true, windowStart: true, readCalls: true, toolNames: true },
                              take: POPULATION_CAP,
                          });
                const sampledAgentIds = [...new Set(sampledWindows.map((w) => w.agentId))];
                const hours = sampledWindows.map((w) => ({
                    createdAt: { gte: w.windowStart, lt: new Date(w.windowStart.getTime() + HOUR_MS) },
                }));
                const latestEnd = Math.max(0, ...sampledWindows.map((w) => w.windowStart.getTime() + HOUR_MS));

                const [invocations, proposals, history, grants, cards] =
                    sampledWindows.length === 0
                        ? [[], [], [], [], []]
                        : await Promise.all([
                              db.auditLog.findMany({
                                  where: { tenantId, action: 'MCP_TOOL_INVOKED', OR: hours },
                                  select: { entityId: true, createdAt: true, detailsJson: true },
                                  take: INVOCATION_CAP + 1,
                              }),
                              db.agentProposal.findMany({
                                  where: { tenantId, agentId: { in: sampledAgentIds }, OR: hours },
                                  select: { agentId: true, kind: true, createdAt: true, policyCardVersion: true },
                                  take: INVOCATION_CAP + 1,
                              }),
                              db.auditLog.findMany({
                                  where: {
                                      tenantId,
                                      entity: 'RegisteredAgent',
                                      entityId: { in: sampledAgentIds },
                                      action: { in: [...GRANT_EVENTS, ...STATUS_EVENTS] },
                                      createdAt: { lt: new Date(latestEnd) },
                                  },
                                  select: { entityId: true, action: true, createdAt: true, detailsJson: true },
                                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                                  take: HISTORY_CAP + 1,
                              }),
                              db.registeredAgentTool.findMany({
                                  where: { tenantId, agentId: { in: sampledAgentIds } },
                                  select: { agentId: true, toolName: true, createdAt: true },
                                  take: POPULATION_CAP,
                              }),
                              db.agentPolicyCard.findMany({
                                  where: { tenantId, agentId: { in: sampledAgentIds } },
                                  select: { id: true, agentId: true },
                                  take: sampledAgentIds.length,
                              }),
                          ]);
                const cardIds = cards.map((c) => c.id);
                const versions =
                    cardIds.length === 0
                        ? []
                        : await db.agentPolicyCardVersion.findMany({
                              where: { tenantId, cardId: { in: cardIds } },
                              select: {
                                  cardId: true,
                                  version: true,
                                  permittedTools: true,
                                  maxDataScope: true,
                                  maxAutonomyLevel: true,
                              },
                              take: POPULATION_CAP,
                          });

                const invocationsTruncated = invocations.length > INVOCATION_CAP || proposals.length > INVOCATION_CAP;
                const historyTruncated = history.length > HISTORY_CAP;
                const historyByAgent = groupBy(history, (h) => h.entityId);
                const cardOfAgent = new Map(cards.map((c) => [c.agentId, c.id] as const));
                const versionOf = new Map(versions.map((v) => [`${v.cardId}:${v.version}`, v] as const));
                const grantCreated = new Map(grants.map((g) => [`${g.agentId}|${g.toolName}`, g.createdAt] as const));
                const windowById = new Map(sampledWindows.map((w) => [w.id, w] as const));

                const units = sampled.map((unitId) => {
                    const w = windowById.get(unitId);
                    if (!w) return judgeUnit(unitId, [{ attribute: 'A1', result: 'UNTESTABLE', code: 'UNIT_NOT_FOUND' }]);
                    const start = w.windowStart.getTime();
                    const end = start + HOUR_MS;
                    const inHour = (t: Date) => t.getTime() >= start && t.getTime() < end;
                    const agentHistory = historyByAgent.get(w.agentId) ?? [];
                    const statusHistory = agentHistory.filter((h) => (STATUS_EVENTS as readonly string[]).includes(h.action));
                    const myInvocations = invocations.filter(
                        (i) => inHour(i.createdAt) && agentIdOf(i.detailsJson) === w.agentId,
                    );
                    const myProposals = proposals.filter((p) => p.agentId === w.agentId && inHour(p.createdAt));
                    const results: AttributeResult[] = [];

                    for (const tool of w.toolNames) {
                        const kind = PROPOSE_KIND.get(tool);
                        // Each per-call record: when it was made, and the card version that allowed it.
                        const calls: { at: number; version: number | null; recorded: boolean }[] = kind
                            ? myProposals
                                  .filter((p) => p.kind === kind)
                                  .map((p) => ({ at: p.createdAt.getTime(), version: p.policyCardVersion, recorded: p.policyCardVersion !== null }))
                            : myInvocations
                                  .filter((i) => i.entityId === tool)
                                  .map((i) => {
                                      const v = (i.detailsJson as { policyCardVersion?: unknown }).policyCardVersion;
                                      return { at: i.createdAt.getTime(), version: typeof v === 'number' ? v : null, recorded: true };
                                  });
                        const times = calls.map((c) => c.at);

                        // A1 — the grant, from the history, at each call (or for the whole hour).
                        if (historyTruncated) {
                            results.push({ attribute: 'A1', result: 'UNTESTABLE', code: 'HISTORY_READ_TRUNCATED' });
                        } else {
                            const events = agentHistory.filter(
                                (h) => (GRANT_EVENTS as readonly string[]).includes(h.action) && concernsTool(h, tool),
                            );
                            const created = grantCreated.get(`${w.agentId}|${tool}`) ?? null;
                            const held =
                                times.length > 0
                                    ? times.every((t) => grantHeldAt(events, created, t))
                                    : grantHeldAt(events, created, start) &&
                                      !events.some(
                                          (e) => e.action !== 'AGENT_TOOL_GRANTED' && e.createdAt.getTime() > start && e.createdAt.getTime() < end,
                                      );
                            results.push(
                                held
                                    ? { attribute: 'A1', result: 'MET' }
                                    : { attribute: 'A1', result: 'EXCEPTION', code: 'TOOL_NOT_GRANTED' },
                            );
                        }

                        // A2 and A3 — the card version each call names.
                        if (invocationsTruncated) {
                            results.push({ attribute: 'A2', result: 'UNTESTABLE', code: 'INVOCATION_READ_TRUNCATED' });
                        } else if (calls.length === 0) {
                            results.push({ attribute: 'A2', result: 'UNTESTABLE', code: 'INVOCATION_UNRECORDED' });
                        } else {
                            for (const call of new Map(calls.map((c) => [`${c.recorded}:${c.version}`, c] as const)).values()) {
                                if (!call.recorded) {
                                    results.push({ attribute: 'A2', result: 'UNTESTABLE', code: 'CARD_VERSION_UNRECORDED' });
                                    continue;
                                }
                                if (call.version === null || call.version === 0) {
                                    results.push({ attribute: 'A2', result: 'EXCEPTION', code: 'NO_CARD_IN_FORCE' });
                                    continue;
                                }
                                const cardId = cardOfAgent.get(w.agentId);
                                const version = cardId ? versionOf.get(`${cardId}:${call.version}`) : undefined;
                                if (!version) {
                                    results.push({ attribute: 'A2', result: 'UNTESTABLE', code: 'CARD_VERSION_UNRESOLVABLE' });
                                    continue;
                                }
                                results.push(
                                    version.permittedTools.includes(tool)
                                        ? { attribute: 'A2', result: 'MET' }
                                        : { attribute: 'A2', result: 'EXCEPTION', code: 'TOOL_NOT_ON_CARD' },
                                );
                                const withheld = withholdingReasonForTool(tool, {
                                    maxDataScope: version.maxDataScope,
                                    maxAutonomyLevel: version.maxAutonomyLevel,
                                });
                                if (withheld === null) results.push({ attribute: 'A3', result: 'MET' });
                                else if (withheld.reason === 'NOT_IN_CATALOGUE') {
                                    results.push({ attribute: 'A3', result: 'UNTESTABLE', code: 'TOOL_NOT_IN_CURRENT_CATALOGUE' });
                                } else {
                                    results.push({ attribute: 'A3', result: 'EXCEPTION', code: 'TOOL_UNEXERCISABLE' });
                                }
                            }
                        }

                        // A4 — ACTIVE, from the status history, at each call (or for the whole hour).
                        if (historyTruncated) {
                            results.push({ attribute: 'A4', result: 'UNTESTABLE', code: 'HISTORY_READ_TRUNCATED' });
                        } else {
                            const asked = times.length > 0 ? times : [start];
                            const statuses = asked.map((t) => statusAt(statusHistory, t));
                            const movedOff =
                                times.length === 0 &&
                                statusHistory.some(
                                    (h) =>
                                        h.createdAt.getTime() > start &&
                                        h.createdAt.getTime() < end &&
                                        (h.action === 'AGENT_SUSPENDED' || h.action === 'AGENT_RETIRED'),
                                );
                            if (statuses.some((s) => s === null)) {
                                results.push({ attribute: 'A4', result: 'UNTESTABLE', code: 'STATUS_HISTORY_UNRECORDED' });
                            } else if (statuses.every((s) => s === 'ACTIVE') && !movedOff) {
                                results.push({ attribute: 'A4', result: 'MET' });
                            } else {
                                results.push({ attribute: 'A4', result: 'EXCEPTION', code: 'AGENT_NOT_ACTIVE' });
                            }
                        }
                    }

                    // A5 — the window counts at least every read call the trail recorded.
                    if (invocationsTruncated) {
                        results.push({ attribute: 'A5', result: 'UNTESTABLE', code: 'INVOCATION_READ_TRUNCATED' });
                    } else {
                        const recordedReads = myInvocations.filter((i) => !PROPOSE_KIND.has(i.entityId)).length;
                        results.push(
                            w.readCalls >= recordedReads
                                ? { attribute: 'A5', result: 'MET' }
                                : { attribute: 'A5', result: 'UNTESTABLE', code: 'WINDOW_UNDERCOUNTS' },
                        );
                    }
                    if (w.toolNames.length === 0) {
                        results.push({ attribute: 'A1', result: 'NOT_APPLICABLE', code: 'NO_TOOL_IN_WINDOW' });
                    }
                    return judgeUnit(unitId, results);
                });
                return { units, facts: [`sampledAgents=${sampledAgentIds.length}`] };
            },
        };
    },
};
