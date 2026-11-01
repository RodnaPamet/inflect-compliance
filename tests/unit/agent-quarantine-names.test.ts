/**
 * The names a quarantine row points at (#4898): the registered agent, the API
 * key it came through, and the person who composed a request in the app. One
 * read per kind of name however many rows, each scoped to the tenant, and
 * nothing read when no row names one.
 */
import { strictMock } from '../helpers/strict-mock';

const db = {
    registeredAgent: { findMany: jest.fn(async () => [{ id: 'agt_1', name: 'Reconciler' }]) },
    tenantApiKey: { findMany: jest.fn(async () => [{ id: 'key_1', name: 'Partner MCP key' }]) },
    tenantMembership: {
        findMany: jest.fn(async () => [
            { userId: 'u_1', user: { name: 'Ada Lovelace', email: 'ada@example.test' } },
            { userId: 'u_2', user: { name: null, email: 'bo@example.test' } },
        ]),
    },
};
jest.mock('@/lib/db/rls-middleware', () => ({
    withRlsTripwireExtension: <T,>(client: T): T => client,
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/usecases/risk', () => ({ createRisk: jest.fn(), updateRisk: jest.fn() }));
jest.mock('@/app-layer/usecases/control/mutations', () => ({ createControl: jest.fn(), updateControl: jest.fn() }));
jest.mock('@/app-layer/usecases/policy', () => ({ createPolicy: jest.fn() }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: jest.fn(), updateFinding: jest.fn() }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn(async () => undefined),
        appendAuditEntryOrQueue: jest.fn(async () => undefined),
    }),
);
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(async () => 'decision-1'),
    recordDecisionOutcomeForDigest: jest.fn(async () => undefined),
}));

import { readQuarantineNames } from '@/app-layer/usecases/agent-proposals';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-A' });

beforeEach(() => {
    db.registeredAgent.findMany.mockClear();
    db.tenantApiKey.findMany.mockClear();
    db.tenantMembership.findMany.mockClear();
});

it('reads each kind of name once, in this tenant, for the ids the rows name', async () => {
    const names = await readQuarantineNames(ctx, [
        { agentId: 'agt_1', proposedViaKeyId: 'key_1', composedByUserId: null },
        { agentId: 'agt_1', proposedViaKeyId: 'key_1', composedByUserId: null },
        { agentId: null, proposedViaKeyId: null, composedByUserId: 'u_1' },
        { agentId: null, proposedViaKeyId: null, composedByUserId: 'u_2' },
    ]);
    expect(names).toEqual({
        agents: { agt_1: 'Reconciler' },
        keys: { key_1: 'Partner MCP key' },
        people: { u_1: 'Ada Lovelace', u_2: 'bo@example.test' },
    });
    expect(db.registeredAgent.findMany).toHaveBeenCalledTimes(1);
    expect(db.registeredAgent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-A', id: { in: ['agt_1'] } } }),
    );
    expect(db.tenantMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-A', userId: { in: ['u_1', 'u_2'] } } }),
    );
});

it('reads nothing when no row names an agent, a key or a person', async () => {
    const names = await readQuarantineNames(ctx, [{ agentId: null, proposedViaKeyId: null, composedByUserId: null }]);
    expect(names).toEqual({ agents: {}, keys: {}, people: {} });
    expect(db.registeredAgent.findMany).not.toHaveBeenCalled();
    expect(db.tenantApiKey.findMany).not.toHaveBeenCalled();
    expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
});
