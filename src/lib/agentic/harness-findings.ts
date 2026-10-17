/**
 * WHAT ONE VERIFIED HARNESS REPORT MEANS (#3665) — a pure planner.
 *
 * Input: a report body that has already passed `verifyAndParseHarnessReport`
 * (signature by a trusted key, then the strict schema), and what the tenant
 * already knows — the levels the previous scans derived, which register rows
 * exist, which shortfalls are under an active acceptance. Output: each agent's
 * DERIVED level and reach, and the findings that are currently true or that
 * this scan proves resolved. `usecases/agent-harness-scans.ts` executes the
 * plan; nothing here touches a database, so every rule below is a unit test.
 *
 * ── LEVELS ARE DERIVED, NEVER READ ──────────────────────────────────────────
 *
 * The contract has no `level` member and the strict schema refuses one. The
 * level is `scoreHarness` over the reported verdicts, where unanswered counts
 * as no and a "met" with no evidence is not met.
 *
 * ── REACH ───────────────────────────────────────────────────────────────────
 *
 *   WRITE_OR_EXTERNAL  any tool not declared read-only (an undeclared hint is a
 *                      write, as the contract says)
 *   UNKNOWN            no such tool, but the `mcp` source was not read in full,
 *                      so a write tool may be missing from the report
 *   READ_ONLY          every tool declared read-only, and the `mcp` source was
 *                      read in full
 *
 * UNKNOWN is held to the higher bar (`shortfallBarFor`). "External" is not
 * distinguished from "write-capable" yet: both meet the higher bar, and
 * telling a read-only external tool from an internal one needs an inventory
 * of which servers are internal, which the contract does not carry.
 *
 * ── FINDINGS, AND WHEN THIS SCAN MAY CLOSE ONE ──────────────────────────────
 *
 * Every finding is keyed by a `sourceRef` so re-ingesting is idempotent:
 *
 *   SHADOW_AGENT:<discoveredId>              not in the register (whatever the
 *                                            report claims, the register decides)
 *   UNPINNED_WRITE_TOOL:<discoveredId>       a write-capable tool with no pin
 *   LEVEL_DROP:<discoveredId>:<scanRef>      the level fell since the last scan —
 *                                            an event, never closed by a scan
 *   HARNESS_SHORTFALL:<discoveredId>         below the report-only bar
 *   EMPTY_SCAN:<scannerAgentId>              the scanner found no agents at all
 *   INCOMPLETE_SOURCE:<scannerAgentId>:<kind> a source it could not read in full
 *
 * A scan closes a finding only on POSITIVE evidence: an agent now in the
 * register, a level now at the bar, a source now read in full, a population now
 * non-empty, and "no unpinned write tool" only when the `mcp` source was read
 * in full. An agent ABSENT from a scan closes nothing — a tenant may run more
 * than one scanner, and one scanner not seeing an agent is not evidence that
 * the agent is gone.
 *
 * ── THE BAR IS REPORT-ONLY ──────────────────────────────────────────────────
 *
 * A shortfall is a finding, never a refusal. Nothing here is consulted by the
 * authority funnel, and `eslint.config.mjs` keeps the ladder out of it.
 *
 * PURE: no clock, no I/O.
 */
import {
    isShortfall,
    rungOf,
    scoreHarness,
    shortfallBarFor,
    type CriterionVerdict,
    type HarnessCriterionId,
    type HarnessLevel,
    type HarnessReach,
} from './harness-ladder';
import type { HarnessReportAgent, HarnessReportBody } from './harness-contract';

/** The `Finding.sourceKind` every harness finding carries — its reconcile key space. */
export const HARNESS_FINDING_SOURCE_KIND = 'AGENT_HARNESS';

export const HARNESS_FINDING_CODES = [
    'SHADOW_AGENT',
    'UNPINNED_WRITE_TOOL',
    'LEVEL_DROP',
    'HARNESS_SHORTFALL',
    'EMPTY_SCAN',
    'INCOMPLETE_SOURCE',
] as const;
export type HarnessFindingCode = (typeof HARNESS_FINDING_CODES)[number];

/** The stored reach, as the `AgentHarnessReach` enum spells it. */
export type StoredReach = 'READ_ONLY' | 'WRITE_OR_EXTERNAL' | 'UNKNOWN';

const LADDER_REACH: Record<StoredReach, HarnessReach | 'unknown'> = {
    READ_ONLY: 'read-only',
    WRITE_OR_EXTERNAL: 'write-or-external',
    UNKNOWN: 'unknown',
};

/** How many unpinned tools a finding names before it stops listing. */
const MAX_TOOLS_NAMED = 10;

export interface PlannedFinding {
    readonly code: HarnessFindingCode;
    readonly sourceRef: string;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    readonly type: 'NONCONFORMITY' | 'OBSERVATION';
    readonly title: string;
    readonly description: string;
}

export interface PlannedAgent {
    readonly discoveredId: string;
    readonly discoveredVia: readonly string[];
    /** The register row, when it exists in this tenant; null is SHADOW. */
    readonly registeredAgentId: string | null;
    readonly ownerKind: 'user' | 'group' | null;
    readonly ownerRef: string | null;
    readonly level: HarnessLevel;
    readonly reach: StoredReach;
    readonly blockingNextRung: readonly HarnessCriterionId[];
    readonly verdicts: readonly CriterionVerdict[];
    readonly tools: HarnessReportAgent['tools'];
}

export interface PriorHarnessState {
    /** The level each already-known discovered agent was last derived at. */
    readonly previousLevels: ReadonlyMap<string, HarnessLevel>;
    /** Register rows that exist (and are not deleted) in this tenant. */
    readonly registeredAgentIds: ReadonlySet<string>;
    /** Discovered agents whose shortfall is under an unexpired, unrevoked acceptance. */
    readonly acceptedShortfalls: ReadonlySet<string>;
}

export interface HarnessPlan {
    readonly agents: readonly PlannedAgent[];
    /** Conditions true as of this scan: open, or reopen if closed. */
    readonly assert: readonly PlannedFinding[];
    /** Findings this scan proves resolved, by `sourceRef`. */
    readonly resolve: readonly string[];
}

/** Is this tool one the bar treats as a write? An undeclared hint is a write. */
export function isWriteCapable(tool: { readOnlyHint: boolean | null }): boolean {
    return tool.readOnlyHint !== true;
}

export function reachOf(agent: Pick<HarnessReportAgent, 'tools'>, mcpReadInFull: boolean): StoredReach {
    if (agent.tools.some(isWriteCapable)) return 'WRITE_OR_EXTERNAL';
    return mcpReadInFull ? 'READ_ONLY' : 'UNKNOWN';
}

export function shortfallRefOf(discoveredId: string): string {
    return `HARNESS_SHORTFALL:${discoveredId}`;
}

/** Is this stored (level, reach) below the report-only bar? */
export function isHarnessShortfall(level: HarnessLevel, reach: StoredReach): boolean {
    return isShortfall(level, LADDER_REACH[reach]);
}

/**
 * The shortfall finding, in one place: the ingest raises it and the expiry
 * monitor reopens it, and the two must describe it alike.
 */
export function shortfallFinding(
    discoveredId: string,
    level: HarnessLevel,
    reach: StoredReach,
    because: string,
    blocking: readonly string[] = [],
): PlannedFinding {
    const bar = shortfallBarFor(LADDER_REACH[reach]);
    return {
        code: 'HARNESS_SHORTFALL',
        sourceRef: shortfallRefOf(discoveredId),
        severity: reach === 'READ_ONLY' ? 'MEDIUM' : 'HIGH',
        type: 'NONCONFORMITY',
        title: `Agent ${discoveredId} is below the harness bar (${level}, bar ${bar})`,
        description:
            `${because} found agent ${discoveredId} at ${level}, whose reach is ${reach}; the bar for that `
            + `reach is ${bar}.`
            + (blocking.length > 0 ? ` Criteria blocking the next rung: ${blocking.join(', ')}.` : '')
            + ' This finding never blocks the agent: it closes when a later scan shows the agent at the '
            + 'bar, or with a time-limited acceptance by the agent’s owner.',
    };
}

function sourceComplete(body: HarnessReportBody, kind: string): boolean {
    return body.population.sources.some((s) => s.kind === kind && s.status === 'COMPLETE');
}

/** Plan what one verified report means for the tenant. */
export function planHarnessScan(body: HarnessReportBody, prior: PriorHarnessState): HarnessPlan {
    const scanRef = body.scan.id;
    const scanner = body.scan.scanner.agentId;
    const mcpReadInFull = sourceComplete(body, 'mcp');
    const assert: PlannedFinding[] = [];
    const resolve: string[] = [];
    const where = `scan ${scanRef}, scanner ${scanner}`;

    const agents: PlannedAgent[] = body.agents.map((a) => {
        const score = scoreHarness(a.verdicts);
        const reach = reachOf(a, mcpReadInFull);
        const registeredAgentId =
            a.registeredAgentId !== null && prior.registeredAgentIds.has(a.registeredAgentId)
                ? a.registeredAgentId
                : null;
        const id = a.discoveredId;

        // SHADOW. Resolved by the register, which is evidence whatever the
        // scan's completeness: the row exists or it does not.
        const shadowRef = `SHADOW_AGENT:${id}`;
        if (registeredAgentId === null) {
            assert.push({
                code: 'SHADOW_AGENT',
                sourceRef: shadowRef,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                title: `Shadow agent ${id}`,
                description:
                    `A harness scan (${where}) found agent ${id} via ${a.discoveredVia.join(', ')}. `
                    + 'It has no row in the agent register, so it has no accountable owner, no '
                    + 'risk tier and no grants on record. Register it, or retire the principal.',
            });
        } else {
            resolve.push(shadowRef);
        }

        // UNPINNED WRITE TOOLS. Absence is evidence only when every MCP
        // server was read.
        const unpinnedRef = `UNPINNED_WRITE_TOOL:${id}`;
        const unpinned = a.tools.filter((t) => isWriteCapable(t) && !t.pinned);
        if (unpinned.length > 0) {
            const named = unpinned.slice(0, MAX_TOOLS_NAMED).map((t) => `${t.name} on ${t.server}`);
            const more = unpinned.length > MAX_TOOLS_NAMED ? ` and ${unpinned.length - MAX_TOOLS_NAMED} more` : '';
            assert.push({
                code: 'UNPINNED_WRITE_TOOL',
                sourceRef: unpinnedRef,
                severity: 'HIGH',
                type: 'NONCONFORMITY',
                title: `Unpinned write-capable tool on agent ${id}`,
                description:
                    `A harness scan (${where}) found ${unpinned.length} write-capable tool(s) with no pinned `
                    + `definition on agent ${id}: ${named.join('; ')}${more}. A tool the agent may call with `
                    + 'a definition nobody reviewed can change under it without anyone noticing.',
            });
        } else if (mcpReadInFull) {
            resolve.push(unpinnedRef);
        }

        // LEVEL DROP — an event, keyed by the scan that saw it.
        const previous = prior.previousLevels.get(id);
        if (previous !== undefined && rungOf(score.level) < rungOf(previous)) {
            assert.push({
                code: 'LEVEL_DROP',
                sourceRef: `LEVEL_DROP:${id}:${scanRef}`,
                severity: 'MEDIUM',
                type: 'OBSERVATION',
                title: `Harness level of agent ${id} fell from ${previous} to ${score.level}`,
                description:
                    `A harness scan (${where}) derived ${score.level} for agent ${id}, down from ${previous}. `
                    + `Criteria now blocking the next rung: ${score.blockingNextRung.join(', ') || 'none'}.`,
            });
        }

        // SHORTFALL against the report-only bar.
        if (isHarnessShortfall(score.level, reach)) {
            if (!prior.acceptedShortfalls.has(id)) {
                assert.push(shortfallFinding(id, score.level, reach, `A harness scan (${where})`, score.blockingNextRung));
            }
        } else {
            resolve.push(shortfallRefOf(id));
        }

        return {
            discoveredId: id,
            discoveredVia: a.discoveredVia,
            registeredAgentId,
            ownerKind: a.owner?.kind ?? null,
            ownerRef: a.owner?.id ?? null,
            level: score.level,
            reach,
            blockingNextRung: score.blockingNextRung,
            verdicts: a.verdicts,
            tools: a.tools,
        };
    });

    // ZERO IS NEVER CLEAN. A scan that found nothing evidences nothing.
    const emptyRef = `EMPTY_SCAN:${scanner}`;
    if (body.agents.length === 0) {
        assert.push({
            code: 'EMPTY_SCAN',
            sourceRef: emptyRef,
            severity: 'HIGH',
            type: 'OBSERVATION',
            title: `Harness scanner ${scanner} found no agents`,
            description:
                `Harness scan ${scanRef} reported no agent-shaped principal at all. An empty population is `
                + 'not a clean result: it is what a scanner reading the wrong tenant, or nothing, looks like.',
        });
    } else {
        resolve.push(emptyRef);
    }

    for (const s of body.population.sources) {
        const ref = `INCOMPLETE_SOURCE:${scanner}:${s.kind}`;
        if (s.status === 'INCOMPLETE') {
            assert.push({
                code: 'INCOMPLETE_SOURCE',
                sourceRef: ref,
                severity: 'MEDIUM',
                type: 'OBSERVATION',
                title: `Harness scanner ${scanner} could not read ${s.kind} in full`,
                description:
                    `Harness scan ${scanRef} read source ${s.kind} incompletely (${s.reason}). Agents and tools `
                    + 'in that source may be missing from the scan, so no finding is closed on its absence.',
            });
        } else {
            resolve.push(ref);
        }
    }

    return { agents, assert, resolve };
}
