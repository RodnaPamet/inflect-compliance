/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * TABLE C — THE FUNNEL. What a SUSPENDED agent's five skipped controls do now.
 *
 * #2399: `evaluateAgentRegistration` answered "there is no agent", "the bound id
 * resolves to nothing" and "the agent here is stopped" with the same `null`, so
 * the boundary gave the stopped one the WIDEST answer available — an absent
 * narrowing term is correctly read as no narrowing. Suspension did not fail to
 * stop an agent; it WIDENED its credential at five controls at once.
 *
 * ## Why this file drives the REAL assembly and not a hand-built invocation
 *
 * Every other unit suite in this subsystem writes an `McpInvocation` literal,
 * and for what those files claim that is right. It cannot work here. The defect
 * was a COMPOSITION defect: the gate produced a shape, `buildMcpInvocation`
 * read it, and the doors keyed their controls off the wrong field of it. A
 * hand-built invocation asserts the doors against a shape the test author
 * chose, which is precisely the mistake being tested for — the doubles would
 * all agree with each other and be wrong together.
 *
 * So each case starts from a `RegisteredAgent` ROW and runs
 * `evaluateAgentRegistration` → `buildMcpInvocation` → the real
 * `authorizeToolCall` / `authorizeResourceRead`. Prisma is doubled; nothing
 * between the row and the refusal is.
 *
 * ## The load-bearing assertion is the TRACE, not the refusal
 *
 * A deny-all at step 4 satisfies every refusal assertion in this file while
 * leaving the kill switch, the breaker, the ceiling and the card as dead as
 * they were. So each case asserts the EXACT ORDERED LIST of controls the funnel
 * actually consulted, spied at the Prisma seam:
 *
 *   grants      `registeredAgentTool.findMany`   — the exposure allowlist
 *   card:read   `agentPolicyCard.findUnique`     — the card LOADED at assembly
 *   kill        `$queryRaw` (kill-switch SQL)    — step 0
 *   credential  `tenantApiKey.findFirst`         — step 2 liveness
 *   breaker     `agentCircuitBreaker.findUnique` — step 2b
 *   manifest    `mcpToolManifestPin.findUnique`  — step 3
 *   card:spend  `$queryRaw` (reservation UPDATE) — step 5/6, the card APPLIED
 *   ledger      `$executeRaw`                    — step 11 behavioural window
 *
 * `toEqual` on an array, never `arrayContaining`: an ordering that changes, a
 * control that stops being read, and a control that is read twice all have to
 * be a failure, because each of those has been the shape of a real regression
 * in this subsystem.
 *
 * `card:read` and `card:spend` are separated deliberately, and the split is
 * where this file departs from the brief's table. The card row IS now read at
 * assembly for a suspended agent — that is half the fix — but on the tool door
 * step 4 refuses before step 6 applies it, so the reservation never happens.
 * Collapsing the two into one "card" column would make those two states
 * indistinguishable, and "the card is loaded but never spent" is exactly the
 * state the resources door and the tool door differ in.
 *
 * ## And the honest negative
 *
 * The last describe block is not decoration. This fix denies TOOLS. It does not
 * close the resources door: a suspended agent that is scored, unkilled,
 * unlatched and inside its card is STILL SERVED `inflect://frameworks` and its
 * per-framework coverage. A suite that only proved refusals would licence a
 * "deny-all" claim the code does not support, and the copy on this PR rests on
 * the difference.
 */

/** Ordered record of which control the funnel consulted, in the order it did. */
const trace: string[] = [];

jest.mock('@/lib/prisma', () => {
    const tenantSecuritySettings = { findUnique: jest.fn() };
    const registeredAgent = { findFirst: jest.fn() };
    const registeredAgentTool = {
        findMany: jest.fn(async () => {
            trace.push('grants');
            return grantRows;
        }),
    };
    const agentPolicyCard = {
        findUnique: jest.fn(async () => {
            trace.push('card:read');
            return cardRow;
        }),
    };
    const agentPolicyCardVersion = { findUnique: jest.fn(async () => cardVersionRow) };
    const tenantApiKey = {
        findFirst: jest.fn(async () => {
            trace.push('credential');
            return { revokedAt: null, expiresAt: null };
        }),
    };
    // Trust-on-first-use: nothing pinned, so the manifest step contributes no
    // term. Present rather than omitted — an absent method throws, and a throw
    // here would read exactly like a refusal.
    const mcpToolManifestPin = {
        findUnique: jest.fn(async () => {
            trace.push('manifest');
            return null;
        }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
    };
    const agentCircuitBreaker = {
        findUnique: jest.fn(async () => {
            trace.push('breaker');
            return latchRow;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const agentBehaviourWindow = {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const agentProposal = { count: jest.fn().mockResolvedValue(0) };
    // ONE `$queryRaw` double for two different statements, dispatched on the
    // SQL itself. The kill switch and the policy card's daily reservation both
    // go through raw SQL, and a double that could not tell them apart would let
    // "the kill switch was consulted" be satisfied by a budget reservation.
    const $queryRaw = jest.fn(async (...args: unknown[]) => {
        const strings = args[0] as readonly string[];
        const sql = Array.isArray(strings) ? strings.join(' ') : '';
        if (sql.includes('AgentKillSwitch')) {
            trace.push('kill');
            // The double MODELS THE PREDICATE rather than ignoring it:
            // `("agentId" IS NULL OR "agentId" = $2)`. A double that returned
            // its fixture rows whatever the funnel bound would let a regression
            // that reverted step 0 to the VOUCHED id — null for a suspended
            // agent — keep every kill-switch refusal in this file green, which
            // is the precise failure mode both audits warned about. With the
            // predicate here, an AGENT-scope row stops matching the moment the
            // bound id goes back to null.
            const boundAgentId = args[2] as string | null;
            return killRows.filter(
                (r) => r.agentId === null || r.agentId === boundAgentId,
            );
        }
        if (sql.includes('AgentPolicyCard')) {
            trace.push('card:spend');
            return [{ actionsInWindow: reservedToday }];
        }
        return [];
    });
    const $executeRaw = jest.fn(async () => {
        trace.push('ledger');
        return 1;
    });
    const client = {
        tenantSecuritySettings,
        registeredAgent,
        registeredAgentTool,
        agentPolicyCard,
        agentPolicyCardVersion,
        tenantApiKey,
        mcpToolManifestPin,
        agentCircuitBreaker,
        agentBehaviourWindow,
        agentProposal,
        $queryRaw,
        $executeRaw,
    };
    return { __esModule: true, default: client, prisma: client };
});

const appendAuditEntry = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ appendAuditEntry: (e: unknown) => appendAuditEntry(e) }));

/**
 * The PRINCIPAL seam, and the only thing stubbed above Prisma.
 *
 * `resolveAgentAuthority` resolves the human a credential speaks for through
 * `resolveTenantContext` — memberships, custom roles, the whole intersection.
 * That is `agent-authority-intersection.test.ts`'s subject and it is upstream
 * of every field this file reads. Stubbing it keeps these assertions about the
 * REGISTER's answer; leaving it real would only add a second, unrelated set of
 * doubled tables that could make a case pass or fail for a reason with no
 * bearing on suspension.
 */
jest.mock('@/lib/agentic/agent-authority', () => ({
    ...jest.requireActual('@/lib/agentic/agent-authority'),
    resolveAgentAuthority: jest.fn(async (keyCtx: any) => ({
        ctx: keyCtx,
        principal: {
            userId: keyCtx.userId,
            role: keyCtx.role,
            appPermissions: keyCtx.appPermissions,
            permissions: keyCtx.permissions,
        },
    })),
}));

import type { AgentStatus, AgentRiskTier } from '@prisma/client';

import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { buildMcpInvocation } from '@/lib/mcp/auth';
import {
    authorizeToolCall,
    authorizeResourceRead,
    type McpInvocation,
} from '@/lib/mcp/authorize';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { MCP_RESOURCES_AUDIENCE } from '@/lib/mcp/token-exchange';
import { windowKeyFor } from '@/lib/agentic/circuit-breaker';
import { makeRequestContext } from '../helpers/make-context';

const TENANT = 'tenant-1';
const AGENT = 'agent-7';
const T0 = new Date('2026-09-10T12:00:00.000Z');
const SURFACE = { method: 'POST', path: '/api/mcp' };

// ─── Mutable fixture state the doubles read ─────────────────────────────

let grantRows: { toolName: string }[] = [];
let cardRow: { id: string; currentVersion: number } | null = null;
let cardVersionRow: Record<string, unknown> | null = null;
let latchRow: Record<string, unknown> | null = null;
/**
 * `AgentKillSwitch` / `PlatformAgentKillSwitch` rows, as the union in
 * `resolveKillState` projects them, plus the `agentId` the double filters on —
 * `null` for a TENANT- or PLATFORM-scope row, an id for an AGENT-scope one.
 */
let killRows: { agentId: string | null; [k: string]: unknown }[] = [];
let reservedToday = 1;

import prisma from '@/lib/prisma';

const settingsFind = (prisma as any).tenantSecuritySettings.findUnique as jest.Mock;
const agentFind = (prisma as any).registeredAgent.findFirst as jest.Mock;
const queryRaw = (prisma as any).$queryRaw as jest.Mock;
const grantsFind = (prisma as any).registeredAgentTool.findMany as jest.Mock;

/** A `RegisteredAgent` row as the gate's one query selects it. */
function agentRow(status: AgentStatus, riskTier: AgentRiskTier | null) {
    return { id: AGENT, status, autonomyLevel: 3, riskTier };
}

/** A latch row as `readBreakerLatch` selects it. */
function latch(over: Record<string, unknown> = {}) {
    return {
        state: 'CLOSED',
        lastEvaluatedWindow: windowKeyFor(T0),
        anomalousStreak: 0,
        streakSignals: [],
        baselineEpoch: new Date('2026-08-01T00:00:00.000Z'),
        trippedAt: null,
        trippedSignals: [],
        ...over,
    };
}

/** A card version row that permits the two things this file drives. */
function cardVersion(over: Record<string, unknown> = {}) {
    return {
        version: 4,
        permittedTools: ['list_risks'],
        maxDataScope: 'READ_TENANT_DATA',
        maxAutonomyLevel: 3,
        maxActionsPerRun: 25,
        maxActionsPerDay: 100,
        escalationTriggers: [],
        approvalRung: 'SINGLE_APPROVER',
        ...over,
    };
}

/**
 * The whole funnel, from the register's row to the door.
 *
 * `requireRegisteredAgent: false` throughout. That is not a convenience: it is
 * the STATE THIS BUG LIVES IN. In an enforcing tenant `assertRegisteredAgent`
 * refuses a suspended agent at the gate and none of the five controls below is
 * ever reached, so a suspended agent arrives at these doors in exactly two
 * situations — a tenant that opted out, and the workflow-engine path in any
 * tenant, which uses the non-throwing evaluator. Both produce the invocation
 * this helper builds.
 */
async function invocationFor(over: { agentId?: string | null } = {}): Promise<McpInvocation> {
    const ctx = makeRequestContext('OWNER', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: 'key-1',
        apiKeyScopes: ['mcp:read', 'risks:read', 'frameworks:read'],
        // No key ceiling, so the KEY contributes no term and the arithmetic
        // below is the agent's own — which is the term suspension used to drop.
        apiKeyMaxAutonomy: null,
        ...('agentId' in over ? { agentId: over.agentId ?? undefined } : { agentId: AGENT }),
    });
    const verdict = await evaluateAgentRegistration(ctx);
    return buildMcpInvocation(ctx, verdict, SURFACE, { now: () => T0 });
}

/** The tool descriptor `runReadTool` hands the gate, unchanged. */
const READ_TOOL = { ...listRisksTool, capabilityClass: 'read' as const };

async function callTool(inv: McpInvocation): Promise<void> {
    await authorizeToolCall(inv, READ_TOOL, {});
}

function denials() {
    return appendAuditEntry.mock.calls
        .map((c) => c[0] as { action: string; detailsJson: Record<string, unknown> })
        .filter((e) => e.action === 'AUTHZ_DENIED');
}

/** The one denial row, or a failure that says how many there were instead. */
function theDenial(): Record<string, unknown> {
    const rows = denials();
    expect(rows).toHaveLength(1);
    return rows[0].detailsJson;
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
    try {
        await fn();
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected a refusal, got a result');
}

beforeEach(() => {
    jest.clearAllMocks();
    trace.length = 0;
    grantRows = [];
    cardRow = { id: 'card-1', currentVersion: 4 };
    cardVersionRow = cardVersion();
    latchRow = latch();
    killRows = [];
    reservedToday = 1;
    settingsFind.mockResolvedValue({ requireRegisteredAgent: false });
    agentFind.mockResolvedValue(agentRow('SUSPENDED', 'LOW'));
});

// ─────────────────────────────────────────────────────────────────────────
// C1 — the tool door refuses, and names SUSPENSION rather than the grants
// ─────────────────────────────────────────────────────────────────────────

describe('a SUSPENDED agent on the tool door', () => {
    it('is refused with reason `agent_suspended`', async () => {
        const message = await refusalOf(async () => callTool(await invocationFor()));

        expect(theDenial()).toMatchObject({
            reason: 'agent_suspended',
            tool: 'list_risks',
            // The GOVERNED id, not the vouched one. `verdict.agentId` is null
            // for a suspended agent, so before #2399 every row this funnel
            // wrote about it said `agentId: null` — a refusal an operator
            // cannot attribute to the agent it was about.
            agentId: AGENT,
            standing: 'suspended',
        });
        expect(message).toMatch(/suspended in the register/i);
    });

    it('does NOT tell the operator to grant a tool — the grant rows are intact', async () => {
        // THE MESSAGE IS THE POINT. Reusing `tool_not_granted` here would send
        // an operator to the agent's grant list, which is unchanged and is not
        // what refused; they would widen the grants, see no change, and widen
        // them further. The two refusals have opposite fixes: activate the
        // agent, versus grant it a tool.
        const message = await refusalOf(async () => callTool(await invocationFor()));

        // The message DOES say the word "grants", and it has to: it tells the
        // operator their grant rows are untouched. What it must never do is
        // send them to EDIT that list — which is the one instruction
        // `tool_not_granted` gives and the one this refusal must not.
        expect(message).not.toMatch(/must grant it in the agent register/i);
        expect(message).not.toMatch(/is not granted the/i);
        expect(message).toMatch(/administrator must activate it/i);
        expect(message).toMatch(/tool grants are unchanged/i);
        // And that claim about the grants is TRUE, which is the harder half:
        // they were never read, so nothing about them can have decided this.
        // Without the spy, "the grant rows are intact and unread" is a comment.
        expect(grantsFind).not.toHaveBeenCalled();
    });

    it('consulted the kill switch and the breaker on the way to that refusal', async () => {
        await refusalOf(async () => callTool(await invocationFor()));

        // The exact list, in order. A deny-all bolted on at step 4 would refuse
        // this call identically and produce ['card:read', 'kill'] or less.
        expect(trace).toEqual(['card:read', 'kill', 'credential', 'breaker', 'manifest']);
    });

    it('loads the policy card but never spends its budget', async () => {
        // The card is READ at assembly — that is half the fix, and it is what
        // makes the resources door below applicable. It is not APPLIED here,
        // because step 4 refuses before step 6 runs, so the day's budget is not
        // burnt by a call that never happened.
        await refusalOf(async () => callTool(await invocationFor()));

        expect(trace).toContain('card:read');
        expect(trace).not.toContain('card:spend');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C2 — the AGENT arm of the kill switch. The largest single win in the PR.
// ─────────────────────────────────────────────────────────────────────────

describe('an AGENT-scope kill switch engaged against a suspended agent', () => {
    beforeEach(() => {
        killRows = [
            {
                rank: 2,
                scope: 'AGENT',
                switchId: 'kill-9',
                engagedAt: new Date('2026-09-10T11:00:00.000Z'),
                // AGENT scope: this row matches only when the funnel binds THIS
                // agent's id. That is the whole defect — step 0 used to bind
                // the vouched id, which is null for a suspended agent, so this
                // row could never match and the kill stopped nothing.
                agentId: AGENT,
            },
        ];
    });

    it('refuses the call, naming the kill and not the suspension', async () => {
        // BEFORE #2399 THIS COMBINATION STOPPED NOTHING. The kill query is
        // `("agentId" IS NULL OR "agentId" = $2)`, and step 0 passed the VOUCHED
        // id — null for a suspended agent — so only TENANT and PLATFORM rows
        // could ever match. An operator who suspended an agent and then pulled
        // its kill switch got a 200.
        const message = await refusalOf(async () => callTool(await invocationFor()));

        expect(theDenial()).toMatchObject({ reason: 'agent_killed', killScope: 'AGENT' });
        expect(message).toMatch(/stopped by an administrator's kill switch/i);
    });

    it('WRITES THE `agent_killed` AUDIT ROW, which is the evidence the stop worked', async () => {
        // The refusal and the row are two claims. A kill switch that refused
        // but wrote nothing leaves an operator during an incident with no
        // evidence the control did anything at all — and before this fix there
        // was neither the refusal nor the row.
        await refusalOf(async () => callTool(await invocationFor()));

        const row = theDenial();
        expect(row).toMatchObject({
            reason: 'agent_killed',
            gate: 'mcp_tool_invocation',
            killScope: 'AGENT',
            killSwitchId: 'kill-9',
            agentId: AGENT,
            // Loud, unconditionally. A tool call arriving after somebody pulled
            // the stop switch is not routine under any configuration.
            escalate: true,
            drill: false,
        });
        expect(row.killEngagedAt).toBe('2026-09-10T11:00:00.000Z');
    });

    it('bound the GOVERNED agent id into the query, so the AGENT arm can match', async () => {
        // The mechanism, asserted separately from the outcome. A doubled
        // `$queryRaw` returns whatever it is told, so "it refused" cannot prove
        // the SQL was given an id to match on — this can, and Table D proves
        // the same SQL matches a real row.
        await refusalOf(async () => callTool(await invocationFor()));

        const killCall = queryRaw.mock.calls.find((c) =>
            (c[0]?.raw ?? c[0] ?? []).join(' ').includes('AgentKillSwitch'),
        );
        expect(killCall).toBeDefined();
        expect(killCall!.slice(1)).toEqual([TENANT, AGENT]);
    });

    it('short-circuits — the breaker and everything after it are not consulted', async () => {
        await refusalOf(async () => callTool(await invocationFor()));

        expect(trace).toEqual(['card:read', 'kill']);
    });

    it('stops the RESOURCES door too', async () => {
        // A stop that covered one of `/api/mcp`'s two doors is a stop somebody
        // can walk around.
        await refusalOf(async () => authorizeResourceRead(await invocationFor()));

        expect(theDenial()).toMatchObject({
            reason: 'agent_killed',
            tool: MCP_RESOURCES_AUDIENCE,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C3 — the breaker
// ─────────────────────────────────────────────────────────────────────────

describe('a circuit breaker latched OPEN against a suspended agent', () => {
    beforeEach(() => {
        latchRow = latch({
            state: 'OPEN',
            trippedAt: new Date('2026-09-10T09:00:00.000Z'),
            trippedSignals: ['TOOL_MIX'],
        });
    });

    it('refuses the tool call, where before the latch was never read', async () => {
        // `assertCircuitBreakerClosed` returned early on a null VOUCHED id, so
        // the latch was skipped — not consulted and found closed. A breaker
        // latched open against a suspended agent refused nothing on either door.
        const message = await refusalOf(async () => callTool(await invocationFor()));

        expect(theDenial()).toMatchObject({
            reason: 'circuit_breaker_open',
            agentId: AGENT,
            breakerSignals: ['TOOL_MIX'],
        });
        expect(message).toMatch(/circuit breaker latched open/i);
        // What tripped it is a fact about how the detector reads this agent;
        // handing it back is handing an attacker the threshold to stay under.
        expect(message).not.toMatch(/TOOL_MIX/);
    });

    it('reads the latch AFTER the kill switch and refuses before the manifest', async () => {
        await refusalOf(async () => callTool(await invocationFor()));

        expect(trace).toEqual(['card:read', 'kill', 'credential', 'breaker']);
    });

    it('refuses the resources door as well', async () => {
        const message = await refusalOf(async () => authorizeResourceRead(await invocationFor()));

        expect(message).toMatch(/circuit breaker latched open/i);
        expect(theDenial()).toMatchObject({ reason: 'circuit_breaker_open' });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C4 — the autonomy ceiling is min(key, registered, tierCap), not UNCLAMPED
// ─────────────────────────────────────────────────────────────────────────

describe('the autonomy ceiling of a suspended agent', () => {
    it('is the min of the terms that are present, not UNCLAMPED', async () => {
        // Both agent-side terms used to be absent at once while the credential
        // stayed bound, so `min` collapsed to `min([UNCLAMPED])` = 6 — strictly
        // above what any tier can reach. Suspending a CRITICAL agent PROMOTED
        // it from read-only to propose-capable. Key max is null here, so the
        // ceiling is min(registered 3, LOW's cap 4) = 3.
        const inv = await invocationFor();

        expect(inv.autonomyCeiling).toBe(3);
        expect(inv.riskTier).toBe('LOW');
        expect(inv.governedAgentId).toBe(AGENT);
        expect(inv.agentId).toBeNull();
    });

    it('takes the TIER cap when the tier is the binding term', async () => {
        // CRITICAL caps at 1 while the registration still claims rung 3. Adding
        // terms to a `min` cannot widen, which is what makes this change
        // one-directional by construction rather than by argument.
        agentFind.mockResolvedValue(agentRow('SUSPENDED', 'CRITICAL'));

        expect((await invocationFor()).autonomyCeiling).toBe(1);
    });

    it('DENIES an UNSCORED suspended agent outright, on the resources door', async () => {
        // The one cell where the restored ceiling closes the resources door by
        // itself: `null` tier is UNSCORED, which resolves to DENY_CEILING = -1,
        // below every rung including `read`'s rung 1. Before the fix this agent
        // held rung 6 here.
        agentFind.mockResolvedValue(agentRow('SUSPENDED', null));

        const inv = await invocationFor();
        expect(inv.autonomyCeiling).toBe(-1);

        const message = await refusalOf(() => authorizeResourceRead(inv));

        expect(theDenial()).toMatchObject({
            reason: 'autonomy_denied',
            tool: MCP_RESOURCES_AUDIENCE,
            ceiling: -1,
            required: 1,
            unscored: true,
            riskTier: null,
        });
        // The message names the UNASSESSED case, not a number to raise: a
        // ceiling of -1 can only have come from the tier term, and telling this
        // operator to raise an autonomy level would send them to edit a field
        // that would change nothing.
        expect(message).toMatch(/has not been risk-assessed/i);
        expect(message).toMatch(/agent risk assessment in the register/i);
    });

    it('and consults the ceiling only after the kill switch and the breaker', async () => {
        agentFind.mockResolvedValue(agentRow('SUSPENDED', null));

        await refusalOf(async () => authorizeResourceRead(await invocationFor()));

        expect(trace).toEqual(['card:read', 'kill', 'breaker', 'credential']);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C5 — the policy card is applied
// ─────────────────────────────────────────────────────────────────────────

describe('the policy card of a suspended agent', () => {
    it('is loaded for it — the artefact existed and was silently not applied', async () => {
        const inv = await invocationFor();

        expect(inv.policyCard?.inForce.version).toBe(4);
        expect(inv.policyCard?.inForce.cardId).toBe('card-1');
    });

    it('refuses a resource read whose DAILY budget is spent', async () => {
        // The card's own terms binding on a suspended agent's resource read.
        // `reserveDailyAction` returns a count that INCLUDES this call, so 101
        // against a cap of 100 is the call that goes over.
        reservedToday = 101;

        const message = await refusalOf(async () => authorizeResourceRead(await invocationFor()));

        expect(theDenial()).toMatchObject({
            reason: 'policy_card_denied',
            policyCardRule: 'DAILY_ACTION_CAP_EXCEEDED',
            policyCardVersion: 4,
            agentId: AGENT,
            used: 101,
            permitted: 100,
        });
        expect(message).toMatch(/action budget for today/i);
        expect(trace).toEqual(['card:read', 'kill', 'breaker', 'credential', 'card:spend']);
    });

    it('refuses a resource read the card`s DATA RUNG does not reach', async () => {
        // A resource read is a tenant-data read: `RESOURCE_READ_DATA_SCOPE` is
        // READ_TENANT_DATA, so a card that stops at metadata stops this door.
        // The permitted-TOOL rule is the one rule a resource read skips, and
        // this proves the other rungs are not skipped with it.
        cardVersionRow = cardVersion({ maxDataScope: 'READ_METADATA' });

        await refusalOf(async () => authorizeResourceRead(await invocationFor()));

        expect(theDenial()).toMatchObject({
            reason: 'policy_card_denied',
            policyCardRule: 'DATA_SCOPE_EXCEEDED',
            reached: 'READ_TENANT_DATA',
            permitted: 'READ_METADATA',
        });
        // Refused on REACH, before the budget was spent: a misconfigured card
        // must not burn the agent's day on its way out.
        expect(trace).not.toContain('card:spend');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C6 — THE HONEST NEGATIVE. This fix denies TOOLS, not everything.
// ─────────────────────────────────────────────────────────────────────────

describe('a suspended agent that is scored, unkilled, unlatched and in-card', () => {
    it('IS STILL SERVED on the resources door', async () => {
        // The sentence the whole PR's honesty rests on. `read` requires rung 1
        // and even CRITICAL caps at 1, so no SCORED tier is refused by the
        // ceiling; the exposure allowlist is not applied here because
        // `RegisteredAgentTool` names catalogue TOOLS and resources have no
        // entries in it. So this door is NARROWED — kill, breaker, ceiling and
        // card all apply again — and it is not CLOSED.
        //
        // Deleting this case would let the changelog say "deny-all" and leave
        // the suite green. It must never say that: every TOOL call is refused,
        // the resources door still serves the framework catalogue and this
        // tenant's framework coverage, and the REST surface is unchanged.
        await expect(authorizeResourceRead(await invocationFor())).resolves.toBeUndefined();

        expect(denials()).toHaveLength(0);
    });

    it('is served with every restored control actually consulted', async () => {
        // Not served because the controls were skipped — served because each
        // one was asked and each one said yes. That distinction is the entire
        // difference between this row and the pre-fix behaviour, which produced
        // the same allow for the opposite reason.
        await authorizeResourceRead(await invocationFor());

        expect(trace).toEqual(['card:read', 'kill', 'breaker', 'credential', 'card:spend']);
    });

    it('spends its day on that read, and writes NOTHING to the behavioural ledger', async () => {
        // `reserveDailyAction` wrote: a resource read spends the agent's day
        // like any other call. The ledger did not, by design — the breaker's
        // baseline is fed from the TOOL door, where a call has a capability
        // class to be counted under, and letting the resources surface feed it
        // would let that surface steer the very baseline that judges it.
        await authorizeResourceRead(await invocationFor());

        expect(trace).toContain('card:spend');
        expect(trace).not.toContain('ledger');
    });

    it('but is refused EVERY tool, including ones its card and grants permit', async () => {
        // Both lists say `list_risks` is fine. The standing is what refuses,
        // and it refuses without reading the grants at all.
        grantRows = [{ toolName: 'list_risks' }];

        await refusalOf(async () => callTool(await invocationFor()));

        expect(theDenial()).toMatchObject({ reason: 'agent_suspended' });
        expect(grantsFind).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// C7 — the paired positives. Without these, a deny-all passes everything above.
// ─────────────────────────────────────────────────────────────────────────

describe('the standings that do NOT govern keep today’s behaviour', () => {
    it('an unbound credential calls the tool, and no agent-keyed control fires', async () => {
        // `no_binding` — a human or an ordinary integration key. `grantedTools`
        // is `null`, which admits: there is no list to consult, so no term. The
        // kill switch still runs, but with a NULL id, so only its TENANT and
        // PLATFORM arms can match.
        const inv = await invocationFor({ agentId: null });

        expect(inv.agentStanding).toBe('no_binding');
        expect(inv.grantedTools).toBeNull();
        await expect(callTool(inv)).resolves.toBeUndefined();

        expect(trace).toEqual(['kill', 'credential', 'manifest']);
        expect(queryRaw.mock.calls[0].slice(1)).toEqual([TENANT, null]);
        expect(denials()).toHaveLength(0);
    });

    it.each([
        ['DRAFT' as AgentStatus, 'draft'],
        ['RETIRED' as AgentStatus, 'retired'],
    ])('a %s agent is admitted exactly as it is today', async (status, standing) => {
        // DELIBERATELY UNCHANGED, and recorded rather than quietly settled.
        // Neither state is reachable by a supported path — `createApiKey`
        // refuses a non-ACTIVE binding, ACTIVE→DRAFT is not expressible, and
        // RETIRED lives on delete — so #2399 does not move them. RETIRED is the
        // open asymmetry: it keeps UNCLAMPED autonomy and an unmatched AGENT
        // kill arm while a SUSPENDED agent now has neither.
        agentFind.mockResolvedValue(agentRow(status, 'LOW'));

        const inv = await invocationFor();
        expect(inv.agentStanding).toBe(standing);
        expect(inv.governedAgentId).toBeNull();
        expect(inv.grantedTools).toBeNull();
        expect(inv.autonomyCeiling).toBe(6);

        await expect(callTool(inv)).resolves.toBeUndefined();
        expect(trace).toEqual(['kill', 'credential', 'manifest']);
        expect(queryRaw.mock.calls[0].slice(1)).toEqual([TENANT, null]);
    });

    it('a VOUCHED, granted agent is served, and every control is consulted', async () => {
        // The row that keeps every refusal above honest: a fix that denied
        // everything would satisfy all of them and fail this. It is also the
        // only cell where the behavioural ledger is written, because it is the
        // only cell where a tool call is actually authorized.
        agentFind.mockResolvedValue(agentRow('ACTIVE', 'LOW'));
        grantRows = [{ toolName: 'list_risks' }];

        const inv = await invocationFor();
        expect(inv.agentStanding).toBe('vouched');
        expect(inv.agentId).toBe(AGENT);
        expect(inv.governedAgentId).toBe(AGENT);

        await expect(callTool(inv)).resolves.toBeUndefined();

        expect(trace).toEqual([
            'grants',
            'card:read',
            'kill',
            'credential',
            'breaker',
            'manifest',
            'card:spend',
            'ledger',
        ]);
        expect(denials()).toHaveLength(0);
    });

    it('a VOUCHED agent granted nothing still gets `tool_not_granted`', async () => {
        // THE ROW THAT STOPS `agent_suspended` SWALLOWING `tool_not_granted`.
        // Step 4 has one condition and two reasons; a version that keyed the
        // new reason off "the grant set is empty" rather than off the STANDING
        // would pass every suspension case in this file and mislabel this one.
        agentFind.mockResolvedValue(agentRow('ACTIVE', 'LOW'));
        grantRows = [];

        const message = await refusalOf(async () => callTool(await invocationFor()));

        expect(theDenial()).toMatchObject({ reason: 'tool_not_granted', agentId: AGENT });
        // And this message DOES name the grant list, because here that is the
        // record the operator has to edit.
        expect(message).toMatch(/not granted the "list_risks" tool/i);
        expect(message).toMatch(/grant it in the agent register/i);
    });
});
