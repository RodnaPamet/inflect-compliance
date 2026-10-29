/**
 * The REST gate for an agent-bound key (#4481), at the edges a database cannot
 * easily produce: a kill state that cannot be read, an audit store that is
 * down, and a key bound to no agent. The real-database cells are in
 * `tests/integration/agent-key-rest-gate.test.ts`.
 */
import { strictMock } from '../../helpers/strict-mock';

const mockFindAgent = jest.fn();
const mockResolveKill = jest.fn();
const mockAppendAudit = jest.fn();

jest.mock('@/lib/prisma', () => ({
    prisma: { registeredAgent: { findFirst: (...args: unknown[]) => mockFindAgent(...args) } },
    default: { registeredAgent: { findFirst: (...args: unknown[]) => mockFindAgent(...args) } },
}));
jest.mock('@/lib/agentic/kill-switch', () => ({
    ...jest.requireActual('@/lib/agentic/kill-switch'),
    resolveKillState: (...args: unknown[]) => mockResolveKill(...args),
}));
// Strict, so an audit export the gate reaches that this fixture forgot fails
// loudly rather than resolving to undefined.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...args: unknown[]) => mockAppendAudit(...args),
    }),
);

import { assertAgentKeyMayActAtRest } from '@/lib/agentic/agent-key-rest-gate';
import { makeRequestContext } from '../../helpers/make-context';

const SURFACE = { method: 'GET', path: '/api/t/acme/risks' };
const boundCtx = () => ({ ...makeRequestContext('ADMIN', { tenantId: 'tenant-1' }), agentId: 'agent-1', apiKeyId: 'key-1' });

beforeEach(() => {
    mockFindAgent.mockReset().mockResolvedValue({ status: 'ACTIVE' });
    mockResolveKill.mockReset().mockResolvedValue(null);
    mockAppendAudit.mockReset().mockResolvedValue(undefined);
});

describe('the REST gate for an agent-bound key', () => {
    it('reads nothing for a key bound to no agent', async () => {
        await expect(assertAgentKeyMayActAtRest(makeRequestContext('ADMIN'), SURFACE)).resolves.toBeUndefined();
        expect(mockFindAgent).not.toHaveBeenCalled();
        expect(mockResolveKill).not.toHaveBeenCalled();
    });

    it('admits an ACTIVE agent with no kill in force, reading the agent in its own tenant', async () => {
        await expect(assertAgentKeyMayActAtRest(boundCtx(), SURFACE)).resolves.toBeUndefined();
        expect(mockFindAgent).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'agent-1', tenantId: 'tenant-1', deletedAt: null } }),
        );
        expect(mockResolveKill).toHaveBeenCalledWith('tenant-1', 'agent-1');
        expect(mockAppendAudit).not.toHaveBeenCalled();
    });

    it.each(['DRAFT', 'SUSPENDED', 'RETIRED', 'A_STATUS_ADDED_LATER'])('refuses an agent whose status is %s', async (status) => {
        mockFindAgent.mockResolvedValue({ status });
        await expect(assertAgentKeyMayActAtRest(boundCtx(), SURFACE)).rejects.toMatchObject({ status: 403 });
        expect(mockAppendAudit.mock.calls[0][0].detailsJson).toMatchObject({ reason: 'agent_not_active', agentStatus: status });
    });

    it('refuses a key whose agent the register no longer holds', async () => {
        mockFindAgent.mockResolvedValue(null);
        await expect(assertAgentKeyMayActAtRest(boundCtx(), SURFACE)).rejects.toMatchObject({ status: 403 });
        expect(mockAppendAudit.mock.calls[0][0].detailsJson).toMatchObject({ reason: 'agent_not_active', agentStatus: null });
    });

    it('a kill wins over the status, and its scope is named', async () => {
        mockFindAgent.mockResolvedValue({ status: 'SUSPENDED' });
        mockResolveKill.mockResolvedValue({ scope: 'PLATFORM', switchId: 'sw-9', engagedAt: new Date() });
        await expect(assertAgentKeyMayActAtRest(boundCtx(), SURFACE)).rejects.toMatchObject({ status: 403 });
        expect(mockAppendAudit.mock.calls[0][0].detailsJson).toMatchObject({
            gate: 'agent_key_rest',
            reason: 'agent_killed',
            killScope: 'PLATFORM',
            killSwitchId: 'sw-9',
        });
    });

    it('fails closed when the kill state cannot be read: the request does not proceed', async () => {
        mockResolveKill.mockRejectedValue(new Error('database unreachable'));
        await expect(assertAgentKeyMayActAtRest(boundCtx(), SURFACE)).rejects.toThrow('database unreachable');
    });

    it('still refuses when the denial row cannot be written', async () => {
        mockFindAgent.mockResolvedValue({ status: 'SUSPENDED' });
        mockAppendAudit.mockRejectedValue(new Error('audit store down'));
        await expect(assertAgentKeyMayActAtRest(boundCtx(), SURFACE)).rejects.toMatchObject({ status: 403 });
    });
});
