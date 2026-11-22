/**
 * `buildMcpInvocation`'s `externalCatalogues: 'NOT_READ'` — the invocation a
 * page builds to DESCRIBE a run, never to make one.
 *
 * Reading the external catalogues is not a read of our own tables: for each
 * granted connection it decrypts a secret, mints a credential (an Entra
 * exchange can rotate the refresh token and write it back to the connection
 * row) and sends a live `tools/list` to a third party. The agent canvas must do
 * none of that on a page view. These tests hold the two halves of the option:
 *
 *   · `'NOT_READ'` reaches no external resolver at all, and so no credential
 *     and no socket;
 *   · it only NARROWS — the grant list is the same, and nothing external is
 *     offered — while the default still resolves, so the first half is not
 *     satisfied by a build that never resolves external tools at all.
 */
jest.mock('@/lib/prisma', () => {
    const client = {};
    return { __esModule: true, default: client, prisma: client };
});
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

const EXTERNAL = 'mcp__cmconnaaa__list_alerts';
jest.mock('@/lib/agentic/agent-tool-exposure', () => ({
    listGrantedToolNames: jest.fn(async () => new Set(['list_risks', 'mcp__cmconnaaa__list_alerts'])),
}));
jest.mock('@/lib/agentic/policy-card-store', () => ({
    loadPolicyCardInForce: jest.fn(async () => null),
    reserveDailyAction: jest.fn(),
    utcDay: (d: Date) => d.toISOString().slice(0, 10),
}));
const mockResolveExternal = jest.fn();
jest.mock('@/lib/mcp/tools/external-tools', () => ({
    ...jest.requireActual('@/lib/mcp/tools/external-tools'),
    resolveExternalReadTools: (...a: unknown[]) => mockResolveExternal(...a),
}));

import type { AgentGateVerdict } from '@/lib/agentic/agent-registration-gate';
import { buildMcpInvocation } from '@/lib/mcp/auth';
import { makeRequestContext } from '../helpers/make-context';

const AGENT = 'agent-1';
const SURFACE = { method: 'GET', path: '/t/acme/processes/agents/agent-1' } as const;

const VOUCHED: AgentGateVerdict = {
    enforcing: true,
    agentId: AGENT,
    subjectAgentId: AGENT,
    standing: 'vouched',
    autonomyLevel: 3,
    riskTier: 'LOW',
} as AgentGateVerdict;

beforeEach(() => {
    mockResolveExternal.mockReset();
    mockResolveExternal.mockResolvedValue([{ name: EXTERNAL }]);
});

describe('an invocation built without the external catalogues', () => {
    it('reaches no external resolver: no credential is minted and no server is called', async () => {
        const inv = await buildMcpInvocation(makeRequestContext('ADMIN'), VOUCHED, SURFACE, {
            externalCatalogues: 'NOT_READ',
        });
        expect(mockResolveExternal).not.toHaveBeenCalled();
        expect(inv.externalTools).toEqual([]);
        expect(inv.offeredTools).not.toContain(EXTERNAL);
    });

    it('only narrows: the grant list is the one a run reads', async () => {
        const inv = await buildMcpInvocation(makeRequestContext('ADMIN'), VOUCHED, SURFACE, {
            externalCatalogues: 'NOT_READ',
        });
        expect(inv.grantedTools).toEqual(new Set(['list_risks', EXTERNAL]));
    });

    it('a run (the default) still resolves them, so the first case is not vacuous', async () => {
        const inv = await buildMcpInvocation(makeRequestContext('ADMIN'), VOUCHED, SURFACE);
        expect(mockResolveExternal).toHaveBeenCalledTimes(1);
        expect(inv.offeredTools).toContain(EXTERNAL);
    });
});
