/**
 * #3671 — which principal belongs to a contained agent: the one read the
 * request path and the target population share.
 *
 * Three properties:
 *
 *   1. "CONTAINED" IS AN OWNER_DEPARTED KILL IN FORCE — the query asks for the
 *      code and `liftedAt: null`, and the result is re-filtered through the
 *      shared predicate, so a kill of any other kind contains nothing.
 *   2. A CAP IS A REFUSAL, NOT A TRUNCATION. Reading one past the limit is how
 *      "N rows" and "the first N of more" are told apart, and reaching it
 *      throws so `resolveTargetPopulation` reports `unresolvable`.
 *   3. AN AGENT WITH TWO PRINCIPALS CONTRIBUTES NEITHER to the population — the
 *      request path refuses it as ambiguous, so the bound must not admit what
 *      the request will never ask for.
 */
const mockTx = {
    agentKillSwitch: { findMany: jest.fn() },
    discoveredAgent: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import {
    admissibleServicePrincipalIds,
    readContainedAgentServicePrincipalLinks,
} from '@/app-layer/usecases/agent-service-principal-links';
import { buildSystemContext } from '@/app-layer/context-system';

const ctx = buildSystemContext({ tenantId: 'tenant-L', job: 'agent-owner-orphan-pass' });
const SP = '9F1C2B7E-4A3D-4C1E-8B2F-6D5E4C3B2A19';

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.agentKillSwitch.findMany.mockResolvedValue([
        { agentId: 'a1', reasonCode: 'OWNER_DEPARTED' },
    ]);
    mockTx.discoveredAgent.findMany.mockResolvedValue([
        { id: 'd1', discoveredId: `entra:sp:${SP}`, registeredAgentId: 'a1' },
    ]);
});

describe('readContainedAgentServicePrincipalLinks', () => {
    it('asks for an OWNER_DEPARTED kill in force, and the agent\'s entra:sp: links', async () => {
        const out = await readContainedAgentServicePrincipalLinks(ctx, { agentIds: ['a1'], limit: 5 });
        expect(mockTx.agentKillSwitch.findMany.mock.calls[0][0]).toMatchObject({
            where: { tenantId: 'tenant-L', reasonCode: 'OWNER_DEPARTED', liftedAt: null, agentId: { in: ['a1'] } },
            take: 6,
        });
        expect(mockTx.discoveredAgent.findMany.mock.calls[0][0]).toMatchObject({
            where: {
                tenantId: 'tenant-L',
                registeredAgentId: { in: ['a1'] },
                discoveredId: { startsWith: 'entra:sp:' },
                registeredAgent: { deletedAt: null },
            },
            take: 6,
        });
        expect([...out.containedAgentIds]).toEqual(['a1']);
        // Lower-cased: one principal, one spelling, everywhere.
        expect(out.links).toEqual([
            {
                agentId: 'a1',
                discoveredAgentId: 'd1',
                discoveredId: `entra:sp:${SP}`,
                servicePrincipalId: SP.toLowerCase(),
            },
        ]);
    });

    it('reads every contained agent when none is named — the population\'s question', async () => {
        await readContainedAgentServicePrincipalLinks(ctx, { limit: 5 });
        expect(mockTx.agentKillSwitch.findMany.mock.calls[0][0].where.agentId).toEqual({ not: null });
    });

    it('contains nothing for a kill whose code is not OWNER_DEPARTED, and reads no links', async () => {
        mockTx.agentKillSwitch.findMany.mockResolvedValue([{ agentId: 'a1', reasonCode: null }]);
        const out = await readContainedAgentServicePrincipalLinks(ctx, { agentIds: ['a1'], limit: 5 });
        expect(out.containedAgentIds.size).toBe(0);
        expect(out.links).toEqual([]);
        expect(mockTx.discoveredAgent.findMany).not.toHaveBeenCalled();
    });

    it('a harness id that is not a GUID is a link with no principal, never a guessed one', async () => {
        mockTx.discoveredAgent.findMany.mockResolvedValue([
            { id: 'd1', discoveredId: 'entra:sp:../users/x', registeredAgentId: 'a1' },
        ]);
        const out = await readContainedAgentServicePrincipalLinks(ctx, { agentIds: ['a1'], limit: 5 });
        expect(out.links[0].servicePrincipalId).toBeNull();
    });

    it.each([
        ['kills', 'agentKillSwitch'],
        ['links', 'discoveredAgent'],
    ] as const)('reaching the cap on %s THROWS rather than truncating', async (_label, table) => {
        const rows = Array.from({ length: 3 }, (_v, i) =>
            table === 'agentKillSwitch'
                ? { agentId: `a${i}`, reasonCode: 'OWNER_DEPARTED' }
                : { id: `d${i}`, discoveredId: `entra:sp:${SP}`, registeredAgentId: 'a1' },
        );
        mockTx[table].findMany.mockResolvedValue(rows);
        await expect(readContainedAgentServicePrincipalLinks(ctx, { limit: 2 })).rejects.toThrow(
            /cannot be read whole/,
        );
    });
});

describe('admissibleServicePrincipalIds', () => {
    it('admits one principal per agent that names exactly one', () => {
        expect(
            admissibleServicePrincipalIds([
                { agentId: 'a1', discoveredAgentId: 'd1', discoveredId: 'entra:sp:1', servicePrincipalId: 'sp-1' },
                { agentId: 'a2', discoveredAgentId: 'd2', discoveredId: 'entra:sp:2', servicePrincipalId: 'sp-2' },
            ]),
        ).toEqual(['sp-1', 'sp-2']);
    });

    it('admits neither principal of an agent that names two', () => {
        expect(
            admissibleServicePrincipalIds([
                { agentId: 'a1', discoveredAgentId: 'd1', discoveredId: 'entra:sp:1', servicePrincipalId: 'sp-1' },
                { agentId: 'a1', discoveredAgentId: 'd2', discoveredId: 'entra:sp:2', servicePrincipalId: 'sp-2' },
                { agentId: 'a3', discoveredAgentId: 'd3', discoveredId: 'entra:sp:3', servicePrincipalId: 'sp-3' },
            ]),
        ).toEqual(['sp-3']);
    });

    it('admits no malformed principal', () => {
        expect(
            admissibleServicePrincipalIds([
                { agentId: 'a1', discoveredAgentId: 'd1', discoveredId: 'entra:sp:x', servicePrincipalId: null },
            ]),
        ).toEqual([]);
    });
});
