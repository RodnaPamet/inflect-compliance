/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * The policy card reports itself — one evaluation counted per call, one refusal
 * counted per refusal, and the refusal carries enough to act on.
 *
 * ## Why this needs a test at all
 *
 * A policy-card refusal breaks nothing. No failed job, no error rate, no
 * user-visible symptom — the agent simply gets less done, and a misconfigured
 * card looks from the outside exactly like a quiet week. So the instrument IS
 * the control's observability, and an instrument nobody checks is one that can
 * be removed by an edit that reads as a tidy-up.
 *
 * ## The dimensions are the point, not the count
 *
 * Refusal volume alone cannot separate the two things that produce it:
 *
 *   • a MISCONFIGURED card — one agent, ONE rule, starting at an edit;
 *   • an agent operating outside its envelope (ASI10) — one agent, refusals
 *     SPREAD ACROSS RULES, or repeatedly against the action budgets.
 *
 * Both are "refusals went up". Telling them apart needs the AGENT and the RULE
 * on the same series, which is why the assertions below are about labels rather
 * than about totals, and why the same agent tripping different rules must
 * produce DIFFERENT label sets rather than one counter going up by four.
 *
 * Driven through the REAL funnel (`runReadTool`, `authorizeResourceRead`) with
 * the metrics module mocked at its two new entry points. A test that called the
 * recorders directly would prove they accept arguments and say nothing about
 * whether the gate calls them.
 */

jest.mock('@/lib/prisma', () => {
    const tenantApiKey = { findFirst: jest.fn() };
    // The tool-manifest pin the gate reads before the exposure allowlist.
    // `null` — nothing pinned — is trust-on-first-use, so the manifest step
    // contributes no term and these assertions stay about the policy card.
    const mcpToolManifestPin = {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    return {
        __esModule: true,
        default: { tenantApiKey, mcpToolManifestPin },
        prisma: { tenantApiKey, mcpToolManifestPin },
    };
});

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/agentic/policy-card-store', () => ({
    loadPolicyCardInForce: jest.fn(),
    reserveDailyAction: jest.fn(),
    utcDay: (d: Date) => d.toISOString().slice(0, 10),
}));

// Only the two new entry points are replaced. The rest of the module stays real
// so an unrelated recorder reached through this import graph still works — a
// wholesale mock would turn a missing export into a silent undefined.
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordPolicyCardEvaluation: jest.fn(),
    recordPolicyCardRefusal: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { reserveDailyAction } from '@/lib/agentic/policy-card-store';
import {
    recordPolicyCardEvaluation,
    recordPolicyCardRefusal,
} from '@/lib/observability/integration-metrics';
import { POLICY_CARD_RULES, type AgentPolicyCardValue } from '@/lib/agentic/policy-card';
import type { PolicyCardInForce } from '@/lib/agentic/policy-card-evaluation';
import { authorizeResourceRead, type McpInvocation } from '@/lib/mcp/authorize';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { getFrameworkStatusTool } from '@/lib/mcp/tools/framework-tools';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const findFirst = (prisma as any).tenantApiKey.findFirst as jest.Mock;
const reserve = reserveDailyAction as unknown as jest.Mock;
const evaluations = recordPolicyCardEvaluation as unknown as jest.Mock;
const refusals = recordPolicyCardRefusal as unknown as jest.Mock;

const TENANT = 'tenant-1';
const AGENT = 'agent-7';
const T0 = new Date('2026-09-05T12:00:00.000Z');

const PERMISSIVE: AgentPolicyCardValue = {
    permittedTools: ['list_risks', 'get_framework_status'],
    maxDataScope: 'READ_TENANT_DATA',
    maxAutonomyLevel: 4,
    maxActionsPerRun: 50,
    maxActionsPerDay: 500,
    escalationTriggers: [...POLICY_CARD_RULES],
    approvalRung: 'SINGLE_APPROVER',
};

function inForce(value: Partial<AgentPolicyCardValue> = {}): PolicyCardInForce {
    return { cardId: 'card-1', version: 3, value: { ...PERMISSIVE, ...value } };
}

function invocationFor(
    card: PolicyCardInForce | null,
    opts: { actionsThisRun?: number; riskTier?: McpInvocation['riskTier'] } = {},
): McpInvocation {
    const ctx = makeRequestContext('OWNER', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: 'key-1',
        apiKeyScopes: ['mcp:read', 'risks:read', 'controls:read', 'frameworks:read'],
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
        grantedTools: new Set(['list_risks', 'get_framework_status']),
        audience: null,
        autonomyCeiling: 6,
        riskTier: opts.riskTier === undefined ? 'HIGH' : opts.riskTier,
        policyCard: card ? { inForce: card, actionsThisRun: opts.actionsThisRun ?? 0 } : null,
        credential: { apiKeyId: 'key-1', tokenExpiresAt: null },
        now: () => T0,
    };
}

async function swallow(fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn();
    } catch {
        /* the refusal is what the test is measuring, not the throw */
    }
}

let risksRun: jest.SpyInstance;
let frameworkRun: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
    reserve.mockResolvedValue(1);
    risksRun = jest.spyOn(listRisksTool, 'run').mockResolvedValue({ risks: [] });
    frameworkRun = jest.spyOn(getFrameworkStatusTool, 'run').mockResolvedValue({ frameworks: [] });
});

afterEach(() => {
    risksRun.mockRestore();
    frameworkRun.mockRestore();
});

describe('every evaluation is counted exactly once', () => {
    it('an ALLOWED call emits one evaluation and no refusal', async () => {
        await runReadTool(invocationFor(inForce()), 'list_risks', {});

        expect(evaluations.mock.calls).toEqual([[{ outcome: 'allowed', surface: 'tool' }]]);
        expect(refusals).not.toHaveBeenCalled();
    });

    it('a REFUSED call emits one evaluation and one refusal — not two of either', async () => {
        // The counts are the assertion. Emitting the evaluation twice would make
        // the refusal RATE — the number an alert is written against — wrong by a
        // factor that depends on which rule fired.
        await swallow(() =>
            runReadTool(invocationFor(inForce({ permittedTools: [] })), 'list_risks', {}),
        );

        expect(evaluations.mock.calls).toEqual([[{ outcome: 'refused', surface: 'tool' }]]);
        expect(refusals).toHaveBeenCalledTimes(1);
    });

    it('an AGENT with no card is counted as such, because zero refusals is not evidence', async () => {
        // An agent with no card and an agent whose card permits everything both
        // produce zero refusals for ever. Only this label separates a governance
        // gap from a quiet one.
        await runReadTool(invocationFor(null), 'list_risks', {});

        expect(evaluations.mock.calls).toEqual([[{ outcome: 'no_card', surface: 'tool' }]]);
        expect(refusals).not.toHaveBeenCalled();
    });

    it('a NON-agent caller is a different outcome from an agent with no card', async () => {
        // Both reach the gate with `policyCard: null`. Folded into one label, a
        // tenant that simply does not run agents would be indistinguishable from
        // one running agents nobody has written a card for — and the second is
        // the only one anybody needs to act on.
        // `grantedTools: null` alongside `agentId: null` is what
        // `buildMcpInvocation` actually produces for a non-agent caller — the
        // exposure allowlist has nothing to apply. Spelled out so the fixture is
        // a state the builder can reach rather than a convenient impossibility.
        const human = { ...invocationFor(null), agentId: null, grantedTools: null };
        await runReadTool(human, 'list_risks', {});

        expect(evaluations.mock.calls).toEqual([[{ outcome: 'no_agent', surface: 'tool' }]]);
        expect(refusals).not.toHaveBeenCalled();
    });

    it('the RESOURCES door is labelled as its own surface', async () => {
        // Resources skip the permitted-TOOL rule (there is nothing for a tool
        // list to name) but spend the same budgets. Sharing a label with the
        // tools door would put an unexplained step in the tool series every time
        // a client listed resources.
        await authorizeResourceRead(invocationFor(inForce()));

        expect(evaluations.mock.calls).toEqual([[{ outcome: 'allowed', surface: 'resource' }]]);
    });
});

describe('a refusal carries enough to tell misconfiguration from a rogue agent', () => {
    it('names the agent AND the rule that fired', async () => {
        await swallow(() =>
            runReadTool(invocationFor(inForce({ permittedTools: [] })), 'list_risks', {}),
        );

        expect(refusals).toHaveBeenCalledWith({
            agentId: AGENT,
            rule: 'TOOL_NOT_PERMITTED',
            escalate: true,
            riskTier: 'HIGH',
            surface: 'tool',
        });
    });

    it('DIFFERENT declarations produce DIFFERENT rules — the spread an alert reads', async () => {
        // The discriminator. One agent tripping one rule repeatedly is a card
        // somebody mis-edited; the same agent tripping several is an agent
        // reaching past its envelope. A counter that reported "policy_card"
        // for both would make the two shapes identical on the dashboard.

        // (a) a tool the card does not list
        await swallow(() =>
            runReadTool(invocationFor(inForce({ permittedTools: [] })), 'list_risks', {}),
        );
        // (b) the SAME tool, permitted — refused on the data rung instead
        await swallow(() =>
            runReadTool(invocationFor(inForce({ maxDataScope: 'READ_METADATA' })), 'list_risks', {}),
        );
        // (c) the per-run budget, with the tool and the rung both fine
        await swallow(() =>
            runReadTool(
                invocationFor(inForce({ maxActionsPerRun: 1 }), { actionsThisRun: 1 }),
                'list_risks',
                {},
            ),
        );
        // (d) the per-day budget — the reservation comes back over the cap
        reserve.mockResolvedValueOnce(501);
        await swallow(() =>
            runReadTool(invocationFor(inForce({ maxActionsPerDay: 500 })), 'list_risks', {}),
        );

        expect(refusals.mock.calls.map((c) => c[0].rule)).toEqual([
            'TOOL_NOT_PERMITTED',
            'DATA_SCOPE_EXCEEDED',
            'RUN_ACTION_CAP_EXCEEDED',
            'DAILY_ACTION_CAP_EXCEEDED',
        ]);
        // …all attributed to the one agent, which is what makes the spread
        // readable as one agent's behaviour rather than four unrelated events.
        expect(new Set(refusals.mock.calls.map((c) => c[0].agentId))).toEqual(new Set([AGENT]));
    });

    it('carries the card\'s own escalate declaration, both ways', async () => {
        await swallow(() =>
            runReadTool(
                invocationFor(inForce({ permittedTools: [], escalationTriggers: [] })),
                'list_risks',
                {},
            ),
        );
        expect(refusals.mock.calls[0][0].escalate).toBe(false);

        jest.clearAllMocks();
        findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
        reserve.mockResolvedValue(1);
        await swallow(() =>
            runReadTool(
                invocationFor(inForce({ permittedTools: [], escalationTriggers: ['TOOL_NOT_PERMITTED'] })),
                'list_risks',
                {},
            ),
        );
        expect(refusals.mock.calls[0][0].escalate).toBe(true);
    });

    it('an UNSCORED agent is passed through as null, not dropped', async () => {
        // The recorder turns it into its own `unscored` series. Dropping the
        // label instead would fold these refusals into whichever tier shares the
        // rest of the key — and an unscored agent being refused is the case most
        // worth seeing on its own.
        await swallow(() =>
            runReadTool(
                invocationFor(inForce({ permittedTools: [] }), { riskTier: null }),
                'list_risks',
                {},
            ),
        );
        expect(refusals.mock.calls[0][0].riskTier).toBeNull();
    });
});
