/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * The policy card is evaluated BEFORE the tool runs.
 *
 * ## The one assertion this file exists for
 *
 * Post-hoc detection and pre-execution prevention are INDISTINGUISHABLE from a
 * status code. Both answer the next request with 403; both write an audit row;
 * both leave the operator reading the same trail. The difference is whether the
 * side effect happened, and the only way to assert it is to put a spy on the
 * tool and check it was never entered.
 *
 * So the refusals below are driven through the REAL funnel — `runReadTool`, the
 * same function `/api/mcp` and the workflow engine call — with a spy on the real
 * tool's `run`. Nothing here reimplements the gate; a test against a
 * hand-assembled evaluator would prove the evaluator refuses and say nothing
 * about whether anything asks it.
 *
 * The database is mocked down to the two things this path touches: the
 * `TenantApiKey` liveness read, and the daily-budget reservation. Everything
 * else — the ladders, the argument-derived data rung, the budget arithmetic, the
 * audit payload — runs for real.
 */

jest.mock('@/lib/prisma', () => {
    const tenantApiKey = { findFirst: jest.fn() };
    return { __esModule: true, default: { tenantApiKey }, prisma: { tenantApiKey } };
});

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

// The reservation is the one WRITE the gate makes. Mocked so the budget can be
// driven to its boundary without a database, and so the test can assert it is
// NOT called when an earlier rule already refused — which is the ordering that
// keeps a misconfiguration from silently eating the agent's day.
jest.mock('@/lib/agentic/policy-card-store', () => ({
    loadPolicyCardInForce: jest.fn(),
    reserveDailyAction: jest.fn(),
    utcDay: (d: Date) => d.toISOString().slice(0, 10),
}));

import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { reserveDailyAction } from '@/lib/agentic/policy-card-store';
import {
    DATA_SCOPE_LADDER,
    POLICY_CARD_RULES,
    type AgentPolicyCardValue,
} from '@/lib/agentic/policy-card';
import {
    evaluateCardDailyBudget,
    evaluateCardReach,
    seedPolicyCardValue,
    type PolicyCardInForce,
} from '@/lib/agentic/policy-card-evaluation';
import {
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    DENY_CEILING,
} from '@/lib/agentic/autonomy-ceiling';
import { MCP_TOOL_NAMES, mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { baseDataScopeForTool, dataScopeForToolCall } from '@/lib/mcp/tool-data-scope';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { getFrameworkStatusTool } from '@/lib/mcp/tools/framework-tools';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const findFirst = (prisma as any).tenantApiKey.findFirst as jest.Mock;
const auditRows = appendAuditEntry as unknown as jest.Mock;
const reserve = reserveDailyAction as unknown as jest.Mock;

const TENANT = 'tenant-1';
const API_KEY_ID = 'key-1';
const T0 = new Date('2026-09-05T12:00:00.000Z');

/**
 * A card that permits both tools under test, with room on every other
 * dimension — so a refusal below is the rule the test names and not a
 * neighbouring one that happened to fire first.
 */
const PERMISSIVE: AgentPolicyCardValue = {
    permittedTools: ['list_risks', 'get_framework_status'],
    maxDataScope: 'READ_TENANT_DATA',
    maxAutonomyLevel: 4,
    maxActionsPerRun: 50,
    maxActionsPerDay: 500,
    escalationTriggers: [...POLICY_CARD_RULES],
    approvalRung: 'SINGLE_APPROVER',
};

function inForce(value: Partial<AgentPolicyCardValue> = {}, version = 3): PolicyCardInForce {
    return { cardId: 'card-1', version, value: { ...PERMISSIVE, ...value } };
}

function invocationFor(
    card: PolicyCardInForce | null,
    actionsThisRun = 0,
): McpInvocation {
    const ctx = makeRequestContext('OWNER', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: API_KEY_ID,
        // Wide enough that the SCOPE and PERMISSION steps never refuse — every
        // assertion here is about the card.
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
        agentId: 'agent-1',
        grantedTools: new Set(['list_risks', 'get_framework_status']),
        // The catalogue snapshot `buildMcpInvocation` takes. Everything this
        // suite calls is on it, so the loader never refuses and every assertion
        // below stays about the CARD.
        offeredTools: [...MCP_TOOL_NAMES],
        audience: null,
        // Above every rung any tool here requires, so the SEPARATE autonomy
        // ceiling of 2/10 is never what refuses.
        autonomyCeiling: 6,
        riskTier: 'LOW',
        policyCard: card ? { inForce: card, actionsThisRun } : null,
        credential: { apiKeyId: API_KEY_ID, tokenExpiresAt: null },
        now: () => T0,
    };
}

/** The refusal message, or `null` when the call was allowed. */
async function refusalOf(fn: () => Promise<unknown>): Promise<string | null> {
    try {
        await fn();
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

/** The `AUTHZ_DENIED` rows written during the current test. */
function denials(): any[] {
    return auditRows.mock.calls
        .map((c) => c[0])
        .filter((row) => row.action === 'AUTHZ_DENIED');
}

let risksRun: jest.SpyInstance;
let frameworkRun: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
    reserve.mockResolvedValue(1);
    // THE SPIES. Both tools are stubbed to a trivial result, so a call that
    // reaches the usecase layer would SUCCEED — which is what makes "never
    // invoked" a real assertion rather than a side effect of the tool throwing.
    risksRun = jest.spyOn(listRisksTool, 'run').mockResolvedValue({ risks: [] });
    frameworkRun = jest
        .spyOn(getFrameworkStatusTool, 'run')
        .mockResolvedValue({ frameworks: [] });
});

afterEach(() => {
    risksRun.mockRestore();
    frameworkRun.mockRestore();
});

describe('a tool outside the card cannot execute', () => {
    it('REFUSES, and the tool function is never entered', async () => {
        const inv = invocationFor(inForce({ permittedTools: ['get_framework_status'] }));

        const message = await refusalOf(() => runReadTool(inv, 'list_risks', {}));

        expect(message).toMatch(/does not permit "list_risks"/);
        // The assertion a status code cannot make. Prevention, not detection:
        // the usecase behind `list_risks` was never called, so no read of the
        // tenant's risk register happened on the way to the 403.
        expect(risksRun).not.toHaveBeenCalled();
    });

    it('records WHICH RULE fired and WHICH VERSION refused, not merely "denied"', async () => {
        const inv = invocationFor(inForce({ permittedTools: [] }, 7));

        await refusalOf(() => runReadTool(inv, 'list_risks', {}));

        expect(denials()).toHaveLength(1);
        expect(denials()[0].detailsJson).toMatchObject({
            reason: 'policy_card_denied',
            policyCardRule: 'TOOL_NOT_PERMITTED',
            policyCardVersion: 7,
            // The card declared every rule as an escalation trigger, so this one
            // is worth waking somebody for.
            escalate: true,
        });
    });

    it('a card that does NOT declare the rule refuses just as hard, but quietly', async () => {
        // `escalate` decides whether an alert fires, never whether the call is
        // allowed. A card that has stopped asking to be told still refuses.
        const inv = invocationFor(inForce({ permittedTools: [], escalationTriggers: [] }));

        const message = await refusalOf(() => runReadTool(inv, 'list_risks', {}));

        expect(message).toMatch(/does not permit/);
        expect(risksRun).not.toHaveBeenCalled();
        expect(denials()[0].detailsJson.escalate).toBe(false);
    });

    it('an agent with NO card is bounded exactly as 2/10 left it', async () => {
        // An absent card contributes no term. If it read as "may do nothing",
        // creating the register's own governance artefact would be the outage —
        // and never creating one would be the safe move, which is the opposite
        // of what this subsystem is for.
        const inv = invocationFor(null);

        await expect(runReadTool(inv, 'list_risks', {})).resolves.toBeDefined();
        expect(risksRun).toHaveBeenCalledTimes(1);
        expect(denials()).toHaveLength(0);
    });
});

describe('a permitted tool with an out-of-scope ARGUMENT cannot execute', () => {
    it('the same tool is allowed without the argument and refused with it', async () => {
        // `get_framework_status` returns the INSTALLABLE-FRAMEWORK CATALOGUE
        // with no arguments — global reference content — and this tenant's
        // coverage breakdown when given a `frameworkKey`. One tool, two data
        // rungs, decided by an argument, so a card capped at metadata must
        // permit the first call and refuse the second.
        const card = inForce({ maxDataScope: 'READ_METADATA' });

        await expect(
            runReadTool(invocationFor(card), 'get_framework_status', {}),
        ).resolves.toBeDefined();
        expect(frameworkRun).toHaveBeenCalledTimes(1);

        frameworkRun.mockClear();
        const message = await refusalOf(() =>
            runReadTool(invocationFor(card), 'get_framework_status', {
                frameworkKey: 'iso27001',
            }),
        );

        expect(message).toMatch(/reaches READ_TENANT_DATA/);
        expect(frameworkRun).not.toHaveBeenCalled();
        expect(denials()[0].detailsJson).toMatchObject({
            policyCardRule: 'DATA_SCOPE_EXCEEDED',
            reached: 'READ_TENANT_DATA',
            permitted: 'READ_METADATA',
        });
    });

    it('the rung is read from RAW arguments, before validation', () => {
        // The gate necessarily runs before the tool's Zod schema, because
        // nothing may run ahead of the gate. So a malformed argument still
        // raises the rung — a caller cannot reach a higher one by sending
        // something the schema would later reject.
        expect(dataScopeForToolCall('get_framework_status', {})).toBe('READ_METADATA');
        expect(dataScopeForToolCall('get_framework_status', { frameworkKey: 42 })).toBe(
            'READ_TENANT_DATA',
        );
        // An argument rule may only RAISE. A tool with no rule of its own sits
        // at its class default whatever it is handed.
        expect(dataScopeForToolCall('list_risks', {})).toBe('READ_TENANT_DATA');
        expect(dataScopeForToolCall('propose_risks', { items: [] })).toBe(
            'WRITE_TENANT_DATA',
        );
    });
});

describe('the action budgets bound a run and a day', () => {
    it('the per-run budget refuses the call AFTER the cap, not the one at it', async () => {
        const card = inForce({ maxActionsPerRun: 5 });

        // Five already made: the sixth is the one over the line.
        await expect(
            runReadTool(invocationFor(card, 4), 'list_risks', {}),
        ).resolves.toBeDefined();

        risksRun.mockClear();
        const message = await refusalOf(() =>
            runReadTool(invocationFor(card, 5), 'list_risks', {}),
        );
        expect(message).toMatch(/whole action budget/);
        expect(risksRun).not.toHaveBeenCalled();
    });

    it('the run counter advances only on calls that were ALLOWED', async () => {
        const inv = invocationFor(inForce({ maxActionsPerRun: 5 }));
        await runReadTool(inv, 'list_risks', {});
        await runReadTool(inv, 'list_risks', {});
        expect(inv.policyCard?.actionsThisRun).toBe(2);

        await refusalOf(() => runReadTool(inv, 'list_risks_that_do_not_exist', {}));
        expect(inv.policyCard?.actionsThisRun).toBe(2);
    });

    it('the daily budget is RESERVED, and only after the reach rules pass', async () => {
        // Ordering, and it is the whole reason the evaluator is split in two: a
        // call refused for naming a tool the card does not permit must not spend
        // a unit of the day. Otherwise one misconfiguration exhausts the budget
        // and the operator reads DAILY_ACTION_CAP_EXCEEDED while the fault was
        // TOOL_NOT_PERMITTED.
        await refusalOf(() =>
            runReadTool(invocationFor(inForce({ permittedTools: [] })), 'list_risks', {}),
        );
        expect(reserve).not.toHaveBeenCalled();

        await runReadTool(invocationFor(inForce()), 'list_risks', {});
        expect(reserve).toHaveBeenCalledWith(TENANT, 'card-1', T0);
    });

    it('a spent daily budget refuses, and the tool is never entered', async () => {
        reserve.mockResolvedValue(101);
        const message = await refusalOf(() =>
            runReadTool(invocationFor(inForce({ maxActionsPerDay: 100 })), 'list_risks', {}),
        );

        expect(message).toMatch(/whole action budget for today/);
        expect(risksRun).not.toHaveBeenCalled();
        expect(denials()[0].detailsJson).toMatchObject({
            policyCardRule: 'DAILY_ACTION_CAP_EXCEEDED',
            used: 101,
            permitted: 100,
        });
    });

    it('an unreservable budget refuses rather than passes', () => {
        // `reserveDailyAction` returns MAX_SAFE_INTEGER when its UPDATE matched
        // no row. The comparison is what turns that into a refusal, so it is
        // pinned here rather than left to the reader of the store.
        expect(evaluateCardDailyBudget(inForce(), Number.MAX_SAFE_INTEGER).allowed).toBe(
            false,
        );
    });
});

describe('a successful call records the version that allowed it', () => {
    it('the MCP_TOOL_INVOKED row names the card version', async () => {
        await runReadTool(invocationFor(inForce({}, 9)), 'list_risks', {});

        const invoked = auditRows.mock.calls
            .map((c) => c[0])
            .find((row) => row.action === 'MCP_TOOL_INVOKED');
        expect(invoked.detailsJson).toMatchObject({ tool: 'list_risks', policyCardVersion: 9 });
    });

    it('an agent with no card records a NULL version, not a missing field', async () => {
        await runReadTool(invocationFor(null), 'list_risks', {});
        const invoked = auditRows.mock.calls
            .map((c) => c[0])
            .find((row) => row.action === 'MCP_TOOL_INVOKED');
        expect(invoked.detailsJson).toHaveProperty('policyCardVersion', null);
    });
});

describe('the pure evaluator, at its edges', () => {
    it('names the NARROWEST thing that is wrong when several rules could fire', () => {
        // A call that is both an ungranted tool and over the data rung reports
        // the tool, because granting the tool is the decision being asked for.
        const verdict = evaluateCardReach(inForce({ permittedTools: [], maxDataScope: 'NONE' }), {
            tool: 'list_risks',
            dataScope: 'EXTERNAL_EGRESS',
            requiredAutonomy: 6,
            actionsThisRun: 999,
        });
        expect(verdict.allowed).toBe(false);
        expect(verdict).toMatchObject({ rule: 'TOOL_NOT_PERMITTED' });
    });

    it('a RESOURCE read skips the tool list and nothing else', () => {
        // `tool: null` is the resources surface — there is no catalogue entry
        // for a resource, so there is nothing for a tool list to name. Every
        // other rule still applies.
        expect(
            evaluateCardReach(inForce({ permittedTools: [] }), {
                tool: null,
                dataScope: 'READ_TENANT_DATA',
                requiredAutonomy: 1,
                actionsThisRun: 0,
            }).allowed,
        ).toBe(true);

        expect(
            evaluateCardReach(inForce({ permittedTools: [], maxDataScope: 'READ_METADATA' }), {
                tool: null,
                dataScope: 'READ_TENANT_DATA',
                requiredAutonomy: 1,
                actionsThisRun: 0,
            }),
        ).toMatchObject({ allowed: false, rule: 'DATA_SCOPE_EXCEEDED' });
    });
});

describe('what a new card opens at', () => {
    it('seeds from the assessed tier, the register\'s own data axis, and the grants', () => {
        const seeded = seedPolicyCardValue({
            riskTier: 'HIGH',
            dataAccessScope: 'READ_TENANT_DATA',
            grantedTools: ['list_risks', 'list_controls'],
        });

        // Nothing invented: the autonomy cap is the tier's, the budgets are the
        // tier's, the data rung is the register's, the tools are the grants'.
        expect(seeded.value).toEqual({
            permittedTools: ['list_risks', 'list_controls'],
            maxDataScope: 'READ_TENANT_DATA',
            maxAutonomyLevel: 2,
            maxActionsPerRun: 10,
            maxActionsPerDay: 100,
            escalationTriggers: [...POLICY_CARD_RULES],
            approvalRung: 'SECOND_APPROVER',
        });
        // And nothing was dropped on the way — the whole grant list survived,
        // which is what makes the withholding cases below findings rather than
        // the normal shape of a seed.
        expect(seeded.withheld).toEqual([]);
    });

    it('creating a card changes NOTHING about what the agent may already do', async () => {
        // The property that makes a card safe to add to a live agent. Seeded
        // from the grants, the seeded card permits exactly the calls that were
        // already passing — so the artefact starts as a record and only becomes
        // a constraint when somebody narrows it.
        const seeded = seedPolicyCardValue({
            riskTier: 'LOW',
            dataAccessScope: 'READ_TENANT_DATA',
            grantedTools: ['list_risks'],
        });
        const inv = invocationFor({ cardId: 'card-1', version: 1, value: seeded.value });

        await expect(runReadTool(inv, 'list_risks', {})).resolves.toBeDefined();
        expect(risksRun).toHaveBeenCalledTimes(1);
    });

    it('an UNSCORED agent seeds to something that can do nothing at all', () => {
        const seeded = seedPolicyCardValue({
            riskTier: null,
            dataAccessScope: 'EXTERNAL_EGRESS',
            grantedTools: ['list_risks'],
        });

        // Every axis at its floor independently, so softening any one of them
        // still leaves nothing runnable. The register's declared EXTERNAL_EGRESS
        // is deliberately NOT honoured here — an unscored agent's declaration is
        // the thing nobody has checked.
        expect(seeded.value.maxAutonomyLevel).toBe(DENY_CEILING);
        expect(seeded.value.maxDataScope).toBe('NONE');
        expect(seeded.value.maxActionsPerRun).toBe(0);
        expect(seeded.value.maxActionsPerDay).toBe(0);
        expect(seeded.value.approvalRung).toBe('SECOND_APPROVER');

        // The grant is WITHHELD rather than written into a card that refuses it:
        // a card is not allowed to permit what it forbids, and the tool is named
        // so the operator can see it is the assessment, not the grant, that is
        // missing.
        expect(seeded.value.permittedTools).toEqual([]);
        expect(seeded.withheld).toEqual([
            {
                toolName: 'list_risks',
                reason: 'AUTONOMY_ABOVE_CARD',
                requires: '1',
                permits: String(DENY_CEILING),
            },
        ]);

        expect(
            evaluateCardReach({ cardId: 'c', version: 1, value: seeded.value }, {
                tool: 'list_risks',
                dataScope: 'READ_TENANT_DATA',
                requiredAutonomy: 1,
                actionsThisRun: 0,
            }).allowed,
        ).toBe(false);
    });
});

describe('a seeded card never permits what it forbids', () => {
    /**
     * The defect this whole section exists for. The three inputs a seed draws on
     * — the tier, the register's data axis, and the grant list — are independent,
     * and nothing made them agree. A card seeded from all three could therefore
     * permit a tool its own ceiling refuses on every call: legible in the
     * register, deliberate-looking, and dark at runtime.
     */
    it('withholds a granted tool whose BASE data rung is above the seeded ceiling', () => {
        const seeded = seedPolicyCardValue({
            riskTier: 'LOW',
            dataAccessScope: 'READ_METADATA',
            grantedTools: ['list_risks'],
        });

        expect(seeded.value.permittedTools).toEqual([]);
        expect(seeded.withheld).toEqual([
            {
                toolName: 'list_risks',
                reason: 'DATA_SCOPE_ABOVE_CARD',
                requires: 'READ_TENANT_DATA',
                permits: 'READ_METADATA',
            },
        ]);
    });

    it('keeps a tool whose base is within the ceiling even when its MAXIMUM is not', () => {
        // The paired positive, and the one that says the rule is about the BASE
        // rung. `get_framework_status` bases at READ_METADATA and only reaches
        // tenant data with a `frameworkKey`, so a metadata card keeps it: the
        // catalogue read works and the wider ARGUMENT is refused at the
        // boundary. A rule written against the maximum would have deleted this
        // tool from the card and made the argument-derived rung pointless.
        const seeded = seedPolicyCardValue({
            riskTier: 'LOW',
            dataAccessScope: 'READ_METADATA',
            grantedTools: ['get_framework_status'],
        });

        expect(seeded.value.permittedTools).toEqual(['get_framework_status']);
        expect(seeded.withheld).toEqual([]);
    });

    it('withholds a granted tool whose autonomy rung is above the tier cap', () => {
        // CRITICAL caps autonomy at 1; `propose_finding` needs 2. The grant seam
        // refuses this pairing today, so reaching it means a grant that predates
        // that gate or a tier that rose after the grant — both real, and both
        // arriving here rather than at the agent's next call.
        const seeded = seedPolicyCardValue({
            riskTier: 'CRITICAL',
            dataAccessScope: 'WRITE_TENANT_DATA',
            grantedTools: ['list_risks', 'propose_finding'],
        });

        expect(seeded.value.permittedTools).toEqual(['list_risks']);
        expect(seeded.withheld).toEqual([
            {
                toolName: 'propose_finding',
                reason: 'AUTONOMY_ABOVE_CARD',
                requires: '2',
                permits: '1',
            },
        ]);
    });

    it('withholds a grant naming a tool this build no longer offers', () => {
        const seeded = seedPolicyCardValue({
            riskTier: 'LOW',
            dataAccessScope: 'WRITE_TENANT_DATA',
            grantedTools: ['list_risks', 'list_everything'],
        });

        expect(seeded.value.permittedTools).toEqual(['list_risks']);
        expect(seeded.withheld.map((w) => [w.toolName, w.reason])).toEqual([
            ['list_everything', 'NOT_IN_CATALOGUE'],
        ]);
    });

    it('every seeded card is one the boundary can actually exercise', () => {
        // The invariant itself, over the whole catalogue and the whole data
        // ladder, rather than over the four examples above. For every (tier,
        // axis) pair, each tool the seeded card PERMITS must pass the boundary's
        // own reach evaluation at that tool's base rung — and each tool it
        // WITHHOLDS must fail it. A seeder that filtered on a different rule
        // than the boundary enforces would show up here as one of the two
        // halves going wrong.
        for (const riskTier of ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const) {
            for (const dataAccessScope of DATA_SCOPE_LADDER) {
                const seeded = seedPolicyCardValue({
                    riskTier,
                    dataAccessScope,
                    grantedTools: MCP_TOOL_NAMES,
                });
                const card = { cardId: 'c', version: 1, value: seeded.value };

                expect(
                    [...seeded.value.permittedTools, ...seeded.withheld.map((w) => w.toolName)]
                        .sort(),
                ).toEqual([...MCP_TOOL_NAMES].sort());

                for (const tool of seeded.value.permittedTools) {
                    expect(
                        evaluateCardReach(card, {
                            tool,
                            dataScope: baseDataScopeForTool(tool),
                            requiredAutonomy:
                                AUTONOMY_REQUIRED_BY_CAPABILITY[mcpToolCapabilityClass(tool)],
                            actionsThisRun: 0,
                        }).allowed,
                    ).toBe(true);
                }

                for (const { toolName } of seeded.withheld) {
                    expect(
                        evaluateCardReach(card, {
                            tool: toolName,
                            dataScope: baseDataScopeForTool(toolName),
                            requiredAutonomy:
                                AUTONOMY_REQUIRED_BY_CAPABILITY[mcpToolCapabilityClass(toolName)],
                            actionsThisRun: 0,
                        }).allowed,
                    ).toBe(false);
                }
            }
        }
    });
});
