/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * Deny-by-default belongs to the REGISTRY, not only to the gate.
 *
 * Two properties, and they fail in different directions.
 *
 * ## 1. A tool the policy card omits is not LOADABLE, even though the server
 *      offers it and the register grants it
 *
 * `authorizeToolCall` already intersected the card with the grants at CALL time,
 * so such a tool always 403'd. What it did NOT do was keep the tool out of
 * `tools/list`: the catalogue filter applied the grants and stopped, so an agent
 * planned against a list wider than its own declared policy and every call it
 * made against the difference produced an `AUTHZ_DENIED` row. That row is the
 * primary rogue-agent signal; a design that manufactures it from ordinary
 * planning is a design that teaches operators to ignore it.
 *
 * The assertions below therefore read the CATALOGUE, and each one has a positive
 * companion — the same tool, listed, once the card permits it. A test that only
 * proved absence would pass equally well against a filter that returned nothing.
 *
 * ## 2. A tool that appears after the session began is not CALLABLE
 *
 * "The session" is an `McpInvocation`: assembled once per `/api/mcp` request, and
 * once per workflow-run SEGMENT, which then drives every step of that segment.
 * So the window is real and, for the engine, long. The mechanism is not
 * detection — nothing notices the addition — it is that RESOLUTION ENUMERATES
 * THE MANIFEST: `offeredTools` is a snapshot taken at assembly, and
 * `resolveOfferedTool` will not hand back a tool object for a name absent from
 * it, whatever the live `READ_TOOLS` / `PROPOSE_TOOLS` arrays now hold.
 *
 * That is what makes it testable at all, and testable is the point: the
 * invocation takes the offered list as data, so this file can express "a tool
 * the registry has and the manifest does not" directly, rather than simulating a
 * deploy. The refusals are driven through the REAL funnels — `runReadTool` and
 * `runProposeTool`, the same two functions `/api/mcp` and the workflow engine
 * call — with a spy on the real tool's `run`, because a status code cannot tell
 * a refusal from a tool that ran and then 403'd.
 *
 * The database is mocked down to the two things this path touches: the
 * `TenantApiKey` liveness read and the daily-budget reservation.
 */

jest.mock('@/lib/prisma', () => {
    const tenantApiKey = { findFirst: jest.fn() };
    // Nothing pinned. The manifest gate runs ahead of the loader and reads this
    // table on every call; an unpinned tool is recorded as a BASELINE and
    // allowed, so these tests exercise the LOADER rather than the pin.
    const mcpToolManifestPin = {
        findUnique: () => Promise.resolve(null),
        findMany: () => Promise.resolve([]),
        upsert: () => Promise.resolve(null),
        create: () => Promise.resolve(null),
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

// The propose funnel's terminal write. Stubbed so a propose call that gets past
// the loader SUCCEEDS — which is what makes "the tool was never entered" an
// assertion about the loader rather than about a throw further down.
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    createAgentProposal: jest.fn().mockResolvedValue({ id: 'proposal-1' }),
}));

import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { createAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { reserveDailyAction } from '@/lib/agentic/policy-card-store';
import type { AgentPolicyCardValue } from '@/lib/agentic/policy-card';
import type { PolicyCardInForce } from '@/lib/agentic/policy-card-evaluation';
import { MCP_PROPOSE_TOOL_NAMES, MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import type { McpInvocation } from '@/lib/mcp/authorize';
import {
    listReadToolDescriptors,
    runReadTool,
    McpToolNotFoundError,
} from '@/lib/mcp/tools/registry';
import { listProposeToolDescriptors, runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { getFrameworkStatusTool } from '@/lib/mcp/tools/framework-tools';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const findFirst = (prisma as any).tenantApiKey.findFirst as jest.Mock;
const auditRows = appendAuditEntry as unknown as jest.Mock;
const reserve = reserveDailyAction as unknown as jest.Mock;
const proposals = createAgentProposal as unknown as jest.Mock;

const TENANT = 'tenant-1';
const API_KEY_ID = 'key-1';
const T0 = new Date('2026-09-05T12:00:00.000Z');

/** The whole catalogue this build offers — what `buildMcpInvocation` snapshots. */
const CATALOGUE: readonly string[] = MCP_TOOL_NAMES;

/**
 * A card that is wide open on every dimension EXCEPT its tool list, so a refusal
 * below is the rule the test names and never a neighbouring one that fired
 * first.
 */
function cardPermitting(permittedTools: readonly string[], version = 4): PolicyCardInForce {
    const value: AgentPolicyCardValue = {
        permittedTools: [...permittedTools],
        maxDataScope: 'EXTERNAL_EGRESS',
        maxAutonomyLevel: 6,
        maxActionsPerRun: 1000,
        maxActionsPerDay: 1000,
        escalationTriggers: [],
        approvalRung: 'SINGLE_APPROVER',
    };
    return { cardId: 'card-1', version, value };
}

interface InvocationShape {
    /** `null` = no agent, so no grant term. */
    granted?: readonly string[] | null;
    /** `null` = no card, so no card term. */
    permitted?: readonly string[] | null;
    /** The catalogue snapshot. Defaults to the whole of it. */
    offered?: readonly string[];
}

function invocationFor(shape: InvocationShape = {}): McpInvocation {
    const granted = shape.granted === undefined ? [...CATALOGUE] : shape.granted;
    const ctx = makeRequestContext('OWNER', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: API_KEY_ID,
        // Wide enough that the SCOPE, CAPABILITY and PERMISSION steps never
        // refuse — every assertion here is about the registry.
        apiKeyScopes: ['*', 'mcp:read', 'mcp:propose'],
    });
    return {
        ctx,
        principal: {
            userId: 'user-1',
            role: 'OWNER',
            appPermissions: getPermissionsForRole('OWNER'),
            permissions: ctx.permissions,
        },
        agentId: granted === null ? null : 'agent-1',
        grantedTools: granted === null ? null : new Set(granted),
        offeredTools: shape.offered === undefined ? [...CATALOGUE] : [...shape.offered],
        audience: null,
        autonomyCeiling: 6,
        riskTier: 'LOW',
        policyCard:
            shape.permitted === undefined || shape.permitted === null
                ? null
                : { inForce: cardPermitting(shape.permitted), actionsThisRun: 0 },
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

const denials = (): any[] =>
    auditRows.mock.calls.map((c) => c[0]).filter((r) => r.action === 'AUTHZ_DENIED');

const invocations = (): any[] =>
    auditRows.mock.calls.map((c) => c[0]).filter((r) => r.action === 'MCP_TOOL_INVOKED');

const names = (descriptors: { name: string }[]): string[] => descriptors.map((d) => d.name).sort();

let risksRun: jest.SpyInstance;
let frameworkRun: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
    reserve.mockResolvedValue(1);
    proposals.mockResolvedValue({ id: 'proposal-1' });
    // THE SPIES. Both tools are stubbed to a trivial SUCCESS, so a call that
    // reaches the usecase layer would come back 200 — which is what makes
    // "never invoked" a real assertion rather than a side effect of a throw.
    risksRun = jest.spyOn(listRisksTool, 'run').mockResolvedValue({ risks: [] });
    frameworkRun = jest
        .spyOn(getFrameworkStatusTool, 'run')
        .mockResolvedValue({ frameworks: [] });
});

afterEach(() => {
    risksRun.mockRestore();
    frameworkRun.mockRestore();
});

describe('the catalogue offers only what the policy card permits', () => {
    it('a GRANTED read tool the card omits is not advertised', () => {
        const inv = invocationFor({
            granted: ['list_risks', 'get_framework_status'],
            permitted: ['list_risks'],
        });

        // Exact equality, not `not.toContain`: a survivor cannot hide behind a
        // list that merely lacks the one name the assertion happens to check.
        expect(names(listReadToolDescriptors(inv))).toEqual(['list_risks']);
    });

    it('and the SAME tool is advertised once the card permits it', () => {
        // The positive companion. Without it, a filter that returned nothing at
        // all would satisfy the assertion above.
        const inv = invocationFor({
            granted: ['list_risks', 'get_framework_status'],
            permitted: ['list_risks', 'get_framework_status'],
        });

        expect(names(listReadToolDescriptors(inv))).toEqual([
            'get_framework_status',
            'list_risks',
        ]);
    });

    it('a GRANTED propose tool the card omits is not advertised either', () => {
        const inv = invocationFor({
            granted: ['propose_risks', 'propose_finding'],
            permitted: ['propose_risks'],
        });

        expect(names(listProposeToolDescriptors(inv))).toEqual(['propose_risks']);
    });

    it('an agent with NO card is narrowed by its grants alone', () => {
        // An absent card contributes no term. Reading it as "may do nothing"
        // would make writing the register's own governance artefact the outage.
        const inv = invocationFor({ granted: ['list_risks', 'get_framework_status'] });

        expect(names(listReadToolDescriptors(inv))).toEqual([
            'get_framework_status',
            'list_risks',
        ]);
    });

    it('an agent granted NOTHING is advertised nothing, card or no card', () => {
        expect(listReadToolDescriptors(invocationFor({ granted: [] }))).toEqual([]);
        expect(listProposeToolDescriptors(invocationFor({ granted: [] }))).toEqual([]);
    });

    it('a caller bound to no agent keeps the whole catalogue', () => {
        // `grantedTools: null` is a human, an ordinary integration key, or a
        // tenant with the register switched off — no list to consult, so no
        // term. See `agent-tool-exposure.ts` for why that is not a bypass.
        const inv = invocationFor({ granted: null });
        const advertised = [
            ...names(listReadToolDescriptors(inv)),
            ...names(listProposeToolDescriptors(inv)),
        ].sort();

        expect(advertised).toEqual([...CATALOGUE].sort());
    });
});

describe('a tool that appears after the session began is not callable', () => {
    /** The catalogue minus one name — the tool this build has and this session did not. */
    const WITHOUT_FRAMEWORK = CATALOGUE.filter((n) => n !== 'get_framework_status');

    it('the loader REFUSES it, and the tool function is never entered', async () => {
        const inv = invocationFor({ offered: WITHOUT_FRAMEWORK });

        const message = await refusalOf(() => runReadTool(inv, 'get_framework_status', {}));

        expect(message).toMatch(/was not offered when this session began/);
        // The assertion a status code cannot make. `get_framework_status` is in
        // the live `READ_TOOLS` array, is granted, and is permitted by nothing
        // narrower — the ONLY thing refusing it is the manifest, and it refused
        // before the usecase behind it ran.
        expect(frameworkRun).not.toHaveBeenCalled();
    });

    it('and it is refused for a fresh invocation too — the grant list is not the thing missing', async () => {
        // Same call, same session shape, but the tool explicitly granted AND
        // explicitly permitted by the card. Still refused, because neither list
        // is what the loader consults.
        const inv = invocationFor({
            offered: WITHOUT_FRAMEWORK,
            granted: [...CATALOGUE],
            permitted: [...CATALOGUE],
        });

        expect(await refusalOf(() => runReadTool(inv, 'get_framework_status', {}))).toMatch(
            /was not offered when this session began/,
        );
        expect(frameworkRun).not.toHaveBeenCalled();
    });

    it('the SAME call succeeds when the tool was offered at assembly', async () => {
        // The positive companion, and the one that proves the refusal above is
        // the manifest rather than a neighbouring gate that would have refused
        // either way.
        const inv = invocationFor({ offered: CATALOGUE });

        await expect(runReadTool(inv, 'get_framework_status', {})).resolves.toBeDefined();
        expect(frameworkRun).toHaveBeenCalledTimes(1);
        expect(denials()).toEqual([]);
    });

    it('writes exactly ONE hash-chained AUTHZ_DENIED row, naming the loader', async () => {
        const inv = invocationFor({ offered: WITHOUT_FRAMEWORK });

        await refusalOf(() => runReadTool(inv, 'get_framework_status', {}));

        expect(denials()).toHaveLength(1);
        expect(denials()[0].detailsJson).toMatchObject({
            category: 'access',
            event: 'authz_denied',
            gate: 'mcp_tool_invocation',
            // Its OWN reason. Folding it into `tool_not_granted` would send an
            // operator to the register to grant a tool that is already granted.
            reason: 'tool_not_offered',
            tool: 'get_framework_status',
        });
    });

    it('the propose funnel loads through the same door', async () => {
        const inv = invocationFor({
            offered: CATALOGUE.filter((n) => n !== 'propose_finding'),
        });

        const message = await refusalOf(() =>
            runProposeTool(inv, 'propose_finding', {
                items: [{ severity: 'LOW', type: 'OTHER', title: 'x' }],
            }),
        );

        expect(message).toMatch(/was not offered when this session began/);
        expect(proposals).not.toHaveBeenCalled();
        expect(denials()).toHaveLength(1);
        expect(denials()[0].detailsJson.reason).toBe('tool_not_offered');
    });

    it('every propose tool is reachable through that door when it WAS offered', async () => {
        // Guards the generic loader against being wired to the read registry
        // only — `resolveOfferedTool` is generic, and a mis-parameterised call
        // would make every propose name unresolvable rather than refused.
        const inv = invocationFor({ offered: CATALOGUE });

        expect(names(listProposeToolDescriptors(inv))).toEqual([...MCP_PROPOSE_TOOL_NAMES].sort());
    });

    it('an UNKNOWN name is a protocol error, not an audited denial', async () => {
        // A name this build never had is a typo, not a denied access attempt.
        // Auditing it would let any caller fill the rogue-agent trail with junk.
        const inv = invocationFor();

        await expect(runReadTool(inv, 'no_such_tool', {})).rejects.toBeInstanceOf(
            McpToolNotFoundError,
        );
        expect(denials()).toEqual([]);
    });
});

describe('the audit trail fingerprints the loadable set', () => {
    it('the refusal carries a DIGEST and a COUNT, never the list itself', async () => {
        const inv = invocationFor({
            offered: CATALOGUE.filter((n) => n !== 'get_framework_status'),
        });

        await refusalOf(() => runReadTool(inv, 'get_framework_status', {}));

        const extra = denials()[0].detailsJson;
        expect(typeof extra.loadableToolsDigest).toBe('string');
        // A number, not an array: an audit row answers "same or different", it
        // is not a place to accumulate payload.
        expect(typeof extra.offeredAtAssembly).toBe('number');
    });

    it('a successful call records the digest, and it MOVES when the loadable set moves', async () => {
        // A constant would satisfy "records a digest". Two invocations whose
        // loadable sets differ by one tool must not report the same fingerprint,
        // or the field cannot answer the question it exists for: did the set of
        // tools this agent could load change underneath it mid-run?
        await runReadTool(invocationFor({ granted: ['list_risks', 'get_framework_status'] }), 'list_risks', {});
        await runReadTool(invocationFor({ granted: ['list_risks'] }), 'list_risks', {});

        const [wide, narrow] = invocations().map((r) => r.detailsJson.toolManifestDigest);
        expect(typeof wide).toBe('string');
        expect(narrow).not.toBe(wide);
    });
});
