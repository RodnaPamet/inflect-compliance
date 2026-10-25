/**
 * `runReadTool`'s `beforeRun` hook runs after the gate and before the tool
 * (#4205).
 *
 * `/api/mcp` scans a direct caller's read-tool arguments through this hook.
 * The scan used to run ahead of the funnel. A made-up tool name with
 * secret-shaped arguments then wrote a guard row whose source was the caller's
 * own text, and a call the gate would have refused was recorded as a guard
 * verdict, not as `AUTHZ_DENIED`.
 *
 * Driven through the REAL funnel (`runReadTool` → `authorizeToolCall`) with
 * Prisma doubled, the rig `agent-circuit-breaker-gate.test.ts` uses.
 */
jest.mock('@/lib/prisma', () => {
    const client = {
        tenantApiKey: { findFirst: jest.fn() },
        mcpToolManifestPin: {
            findUnique: jest.fn().mockResolvedValue(null),
            createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        agentCircuitBreaker: { findUnique: jest.fn().mockResolvedValue(null) },
        agentBehaviourWindow: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        agentProposal: { count: jest.fn().mockResolvedValue(0) },
        $executeRaw: jest.fn().mockResolvedValue(1),
        // No kill switch in force: step 0 of the boundary reads an empty result
        // as "not killed".
        $queryRaw: jest.fn().mockResolvedValue([]),
    };
    return { __esModule: true, default: client, prisma: client };
});

import { strictMock } from '../helpers/strict-mock';

const mockAppendAuditEntry = jest.fn().mockResolvedValue(undefined);
// `strictMock`: `@/lib/audit` is a guarded barrel, so an export this path
// reaches and the factory omits fails loudly rather than resolving to undefined.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
    }),
);

jest.mock('@/lib/agentic/policy-card-store', () => ({
    loadPolicyCardInForce: jest.fn().mockResolvedValue(null),
    reserveDailyAction: jest.fn().mockResolvedValue(1),
    utcDay: (d: Date) => d.toISOString().slice(0, 10),
}));

import prisma from '@/lib/prisma';
import { type McpInvocation } from '@/lib/mcp/authorize';
import { McpToolNotFoundError, runReadTool } from '@/lib/mcp/tools/registry';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

const findFirst = (prisma as unknown as { tenantApiKey: { findFirst: jest.Mock } }).tenantApiKey.findFirst;
const T0 = new Date('2026-10-25T12:00:00.000Z');

function invocationFor(over: Partial<McpInvocation> = {}): McpInvocation {
    const ctx = makeRequestContext('OWNER', {
        tenantId: 'tenant-1',
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
        agentId: 'agent-1',
        governedAgentId: 'agent-1',
        agentStanding: 'vouched' as const,
        grantedTools: new Set(['list_risks']),
        offeredTools: [...MCP_TOOL_NAMES],
        externalTools: [],
        audience: null,
        autonomyCeiling: 6,
        riskTier: 'LOW',
        policyCard: null,
        credential: { apiKeyId: 'key-1', tokenExpiresAt: null },
        now: () => T0,
        ...over,
    };
}

/** What happened, in order: the hook, the tool, and any refusal row. */
let calls: string[];
let risksRun: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    calls = [];
    findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
    mockAppendAuditEntry.mockImplementation(async (e: { action: string }) => {
        calls.push(`audit:${e.action}`);
    });
    risksRun = jest.spyOn(listRisksTool, 'run').mockImplementation(async () => {
        calls.push('tool');
        return { risks: [] };
    });
});

afterEach(() => {
    risksRun.mockRestore();
});

const beforeRun = jest.fn(async () => {
    calls.push('beforeRun');
});

describe('beforeRun runs after the gate and before the tool', () => {
    it('runs once, before the tool, for a granted tool (the positive control)', async () => {
        await runReadTool(invocationFor(), 'list_risks', {}, { beforeRun });

        expect(calls.filter((c) => c === 'beforeRun' || c === 'tool')).toEqual(['beforeRun', 'tool']);
    });

    it('does not run when the gate refuses, and the refusal is AUTHZ_DENIED', async () => {
        await expect(
            runReadTool(invocationFor({ grantedTools: new Set<string>() }), 'list_risks', {}, { beforeRun }),
        ).rejects.toThrow();

        expect(beforeRun).not.toHaveBeenCalled();
        expect(calls.filter((c) => c === 'audit:AUTHZ_DENIED')).toHaveLength(1);
        expect(risksRun).not.toHaveBeenCalled();
    });

    it('does not run for a tool this build does not know, and nothing is audited', async () => {
        await expect(
            runReadTool(invocationFor(), 'no_such_tool', {}, { beforeRun }),
        ).rejects.toBeInstanceOf(McpToolNotFoundError);

        expect(beforeRun).not.toHaveBeenCalled();
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it('stops the tool when it throws', async () => {
        const refuse = jest.fn(async () => {
            throw new Error('refused by the caller');
        });

        await expect(runReadTool(invocationFor(), 'list_risks', {}, { beforeRun: refuse })).rejects.toThrow(
            'refused by the caller',
        );
        expect(risksRun).not.toHaveBeenCalled();
    });
});
