/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * A LATCHED breaker stops the agent at the tool boundary, and the ledger records
 * only what was allowed.
 *
 * `agent-circuit-breaker.test.ts` proves the judgement. This proves the two
 * things the judgement is worthless without:
 *
 *   1. An OPEN breaker actually REFUSES — at `authorizeToolCall`, per call, so a
 *      run already in flight stops rather than finishing its remaining steps.
 *      A status code cannot tell "stopped" from "the next dispatch will be
 *      stopped", so the property is asserted as "the tool function is never
 *      entered", which is prevention rather than detection.
 *
 *   2. Only AUTHORIZED calls reach the ledger — and that is a SECURITY property,
 *      not tidiness. If refused calls counted, a caller could steer its own
 *      baseline with calls that never execute: spray reads that get refused,
 *      raise the read baseline, and dilute the distribution distance of a later
 *      propose burst. The detector would then be calibrated by the thing it is
 *      watching.
 *
 * Driven through the REAL funnel (`runReadTool` → `authorizeToolCall`) with
 * Prisma doubled. A test that called the store directly would assert the store
 * works, which is not the claim.
 */
jest.mock('@/lib/prisma', () => {
    const tenantApiKey = { findFirst: jest.fn() };
    // Nothing pinned — trust-on-first-use, so the manifest step contributes no
    // term and these assertions stay about the breaker.
    const mcpToolManifestPin = {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const agentCircuitBreaker = { findUnique: jest.fn() };
    const agentBehaviourWindow = {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const agentProposal = { count: jest.fn().mockResolvedValue(0) };
    const $executeRaw = jest.fn().mockResolvedValue(1);
    const client = {
        tenantApiKey,
        mcpToolManifestPin,
        agentCircuitBreaker,
        agentBehaviourWindow,
        agentProposal,
        $executeRaw,
    };
    return { __esModule: true, default: client, prisma: client };
});

const appendAuditEntry = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ appendAuditEntry }));

jest.mock('@/lib/agentic/policy-card-store', () => ({
    loadPolicyCardInForce: jest.fn().mockResolvedValue(null),
    reserveDailyAction: jest.fn().mockResolvedValue(1),
    utcDay: (d: Date) => d.toISOString().slice(0, 10),
}));

const recordAgentBreakerRefusal = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordAgentBreakerRefusal: (attrs: unknown) => recordAgentBreakerRefusal(attrs),
}));

import prisma from '@/lib/prisma';
import { type McpInvocation } from '@/lib/mcp/authorize';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import { windowKeyFor } from '@/lib/agentic/circuit-breaker';

const findFirst = (prisma as any).tenantApiKey.findFirst as jest.Mock;
const breakerFind = (prisma as any).agentCircuitBreaker.findUnique as jest.Mock;
const ledgerFindMany = (prisma as any).agentBehaviourWindow.findMany as jest.Mock;
const executeRaw = (prisma as any).$executeRaw as jest.Mock;

const TENANT = 'tenant-1';
const AGENT = 'agent-7';
const T0 = new Date('2026-09-05T12:00:00.000Z');

/** A latch row as the store selects it. */
function latch(over: Partial<Record<string, unknown>> = {}) {
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

function invocationFor(over: Partial<McpInvocation> = {}): McpInvocation {
    const ctx = makeRequestContext('OWNER', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: 'key-1',
        apiKeyScopes: ['mcp:read', 'risks:read'],
    });
    return {
        ctx,
        principal: {
            userId: 'user-1',
            role: 'OWNER',
            appPermissions: getPermissionsForRole('OWNER'),
            permissions: ctx.permissions,
        },
        agentId: AGENT,
        grantedTools: new Set(['list_risks']),
        offeredTools: [...MCP_TOOL_NAMES],
        audience: null,
        autonomyCeiling: 6,
        riskTier: 'LOW',
        policyCard: null,
        credential: { apiKeyId: 'key-1', tokenExpiresAt: null },
        now: () => T0,
        ...over,
    };
}

function denials() {
    return appendAuditEntry.mock.calls
        .map((c) => c[0] as { action: string; detailsJson: Record<string, unknown> })
        .filter((e) => e.action === 'AUTHZ_DENIED');
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
    try {
        await fn();
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected a refusal, got a result');
}

let risksRun: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
    ledgerFindMany.mockResolvedValue([]);
    executeRaw.mockResolvedValue(1);
    risksRun = jest.spyOn(listRisksTool, 'run').mockResolvedValue({ risks: [] });
});

afterEach(() => {
    risksRun.mockRestore();
});

describe('an OPEN breaker stops the agent', () => {
    beforeEach(() => {
        breakerFind.mockResolvedValue(
            latch({
                state: 'OPEN',
                trippedAt: new Date('2026-09-05T09:00:00.000Z'),
                trippedSignals: ['TOOL_MIX'],
            }),
        );
    });

    it('refuses the call, and the tool function is never entered', async () => {
        const message = await refusalOf(() => runReadTool(invocationFor(), 'list_risks', {}));

        expect(message).toMatch(/circuit breaker latched open/i);
        // Prevention, not detection: the usecase behind `list_risks` was never
        // called, so no read of the tenant's risk register happened on the way
        // to the 403.
        expect(risksRun).not.toHaveBeenCalled();
    });

    it('writes exactly one AUTHZ_DENIED row naming the breaker as the cause', async () => {
        await refusalOf(() => runReadTool(invocationFor(), 'list_risks', {}));

        expect(denials()).toHaveLength(1);
        expect(denials()[0].detailsJson).toMatchObject({
            reason: 'circuit_breaker_open',
            tool: 'list_risks',
            agentId: AGENT,
            breakerSignals: ['TOOL_MIX'],
        });
    });

    it('does NOT tell the caller which signal fired', async () => {
        // What tripped a breaker is a fact about how the detector reads this
        // agent. Handing it back is handing an attacker the shape of the
        // threshold to stay under — so it goes in the audit row (asserted
        // above) and nowhere the caller can see.
        const message = await refusalOf(() => runReadTool(invocationFor(), 'list_risks', {}));

        expect(message).not.toMatch(/TOOL_MIX|PROPOSAL_RATE|REJECTION_RATE/);
    });

    it('counts the refusal, so a stopped agent still pushing is visible', async () => {
        await refusalOf(() => runReadTool(invocationFor(), 'list_risks', {}));
        expect(recordAgentBreakerRefusal).toHaveBeenCalledWith({ agentId: AGENT });
    });

    it('records NOTHING in the ledger — a stopped agent does not shape its own baseline', async () => {
        await refusalOf(() => runReadTool(invocationFor(), 'list_risks', {}));
        expect(executeRaw).not.toHaveBeenCalled();
    });
});

describe('a CLOSED breaker is invisible to the call', () => {
    beforeEach(() => {
        breakerFind.mockResolvedValue(latch());
    });

    it('lets the call through and records the observation', async () => {
        await expect(runReadTool(invocationFor(), 'list_risks', {})).resolves.toBeDefined();

        expect(risksRun).toHaveBeenCalledTimes(1);
        expect(denials()).toHaveLength(0);
        // The upsert against the agent's current hour.
        expect(executeRaw).toHaveBeenCalledTimes(1);
    });

    it('judges the previous window when the evaluation pointer is stale', async () => {
        breakerFind.mockResolvedValue(latch({ lastEvaluatedWindow: '1970-01-01T00' }));

        await runReadTool(invocationFor(), 'list_risks', {});

        // The lazy trigger: one evaluation per ACTIVE window per agent, driven
        // by the agent's own traffic rather than by a scheduled scan.
        expect(ledgerFindMany).toHaveBeenCalledTimes(1);
    });
});

describe('a call that any gate refuses leaves no trace in the ledger', () => {
    it('an ungranted tool is refused, and nothing is observed', async () => {
        // THE STEERING DEFENCE. The observation is the last step of
        // `authorizeToolCall` on purpose: a caller that could get refused calls
        // counted would be able to move its own baseline with traffic that never
        // executes.
        breakerFind.mockResolvedValue(latch());

        const message = await refusalOf(() =>
            runReadTool(invocationFor({ grantedTools: new Set<string>() }), 'list_risks', {}),
        );

        expect(message).toMatch(/not granted/i);
        expect(executeRaw).not.toHaveBeenCalled();
        expect(denials()).toHaveLength(1);
    });
});

describe('an invocation with no registered agent never touches the breaker', () => {
    it('reads no latch and writes no observation', async () => {
        // `agentId: null` is the tenant not enforcing the register. The breaker
        // is a control that LEARNS, and there is nothing to attribute a window
        // to — deny-by-default lives in the tool grants, which already are.
        await expect(
            runReadTool(invocationFor({ agentId: null, grantedTools: null }), 'list_risks', {}),
        ).resolves.toBeDefined();

        expect(breakerFind).not.toHaveBeenCalled();
        expect(executeRaw).not.toHaveBeenCalled();
    });
});
