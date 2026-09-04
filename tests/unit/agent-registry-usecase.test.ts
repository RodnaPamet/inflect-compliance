/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks that mirror
 * a Prisma transaction client. Per-line typing has poor cost/benefit in test
 * doubles; the file-level disable is this repo's standard for the shape. */
/**
 * Agent register — the three refusals the USECASE owns.
 *
 * The schema layer's refusals are proved separately in
 * `agent-registry-input-rules.test.ts`, and the DDL's in
 * `agent-registry-isolation.test.ts`. This file is about what neither can see:
 *
 *   1. `ownerUserId` must be an ACTIVE member of THIS tenant. `User` is a
 *      global table, so the FK accepts any user id in the system — including
 *      another tenant's. The resulting row looks perfectly legitimate: an agent
 *      owned by somebody who is not a member, cannot see it, and will never act
 *      on it, while the register reports it as owned. That column is what the
 *      downstream two-person rule compares against, so a wrong value there is
 *      not cosmetic.
 *
 *   2. `autonomyLevel` is a bounded integer ladder. Out of range is refused,
 *      and so is a boolean — `z.number()` already rejects `true`, and the
 *      assertion is here anyway because "the library happens to" is not the
 *      same claim as "this rejects it", and only one of those survives a
 *      schema rewrite.
 *
 *   3. Retiring an agent with proposals still awaiting a human is REFUSED, not
 *      cascaded. See `retireRegisteredAgent` for the reasoning; what is
 *      asserted here is that the refusal happens BEFORE any status write, and
 *      that suspension — the emergency stop the refusal points at — carries no
 *      such precondition.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createRegisteredAgent,
    registerAgent,
    retireRegisteredAgent,
    suspendRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'user-1' });

/** A member row, or null when the id is not an ACTIVE member of tenant-1. */
const ACTIVE_MEMBERS = new Set(['user-1', 'owner-1']);

interface DbOverrides {
    pendingProposals?: number;
    vendors?: readonly string[];
}

/**
 * A transaction double shaped like the real client, recording what the usecase
 * wrote. `create`/`updateMany` throw nothing — the point of each test is which
 * of them was REACHED.
 */
function makeDb(overrides: DbOverrides = {}) {
    const calls = {
        agentCreates: [] as any[],
        aiSystemCreates: [] as any[],
        statusUpdates: [] as any[],
    };
    const db: any = {
        tenantMembership: {
            findFirst: jest.fn(async ({ where }: any) =>
                where.tenantId === 'tenant-1' &&
                where.status === 'ACTIVE' &&
                ACTIVE_MEMBERS.has(where.userId)
                    ? { id: 'm-1', userId: where.userId }
                    : null,
            ),
        },
        vendor: {
            findFirst: jest.fn(async ({ where }: any) =>
                (overrides.vendors ?? []).includes(where.id) && where.tenantId === 'tenant-1'
                    ? { id: where.id }
                    : null,
            ),
        },
        agentProposal: {
            count: jest.fn(async () => overrides.pendingProposals ?? 0),
        },
        registeredAgent: {
            create: jest.fn(async (args: any) => {
                calls.agentCreates.push(args);
                return { id: 'agent-1', status: 'DRAFT', riskTier: null };
            }),
            updateMany: jest.fn(async (args: any) => {
                calls.statusUpdates.push(args);
                return { count: 1 };
            }),
        },
        aiSystem: {
            create: jest.fn(async (args: any) => {
                calls.aiSystemCreates.push(args);
                return { id: 'aisys-1', riskTier: 'MINIMAL', classificationClauseId: 'Art.95' };
            }),
        },
        aiSystemRequirementLink: {
            findMany: jest.fn(async () => []),
            createMany: jest.fn(async () => ({ count: 0 })),
        },
        framework: { findMany: jest.fn(async () => []) },
        frameworkRequirement: { findMany: jest.fn(async () => []) },
    };
    return { db, calls };
}

function useDb(overrides: DbOverrides = {}) {
    const { db, calls } = makeDb(overrides);
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    );
    return { db, calls };
}

const REGISTRATION = {
    name: 'Control reconciler',
    autonomyLevel: 3,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'COMPENSABLE',
    provenance: 'FIRST_PARTY',
    ownerUserId: 'owner-1',
} as const;

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── 1. The accountable owner ───────────────────────────────────────

describe('the accountable owner must be an active member of this tenant', () => {
    it('registers when the owner is an ACTIVE member', async () => {
        const { calls } = useDb();
        const result = await registerAgent(ctx, REGISTRATION);
        expect(result.id).toBe('agent-1');
        // Paired positive: without it, a refusal test passes just as well
        // against a usecase that refuses everything.
        expect(calls.agentCreates).toHaveLength(1);
        expect(calls.agentCreates[0].data.ownerUserId).toBe('owner-1');
    });

    it('refuses a foreign userId — the FK would have accepted it', async () => {
        const { calls } = useDb();
        await expect(
            registerAgent(ctx, { ...REGISTRATION, ownerUserId: 'user-from-tenant-2' }),
        ).rejects.toThrow(/active member/i);
        // The refusal must land BEFORE the write, or the register carries a row
        // with a stranger's name on it until somebody notices.
        expect(calls.agentCreates).toHaveLength(0);
        expect(calls.aiSystemCreates).toHaveLength(0);
    });

    it('refuses on the pre-classified create seam too', async () => {
        const { calls } = useDb();
        await expect(
            createRegisteredAgent(ctx, {
                ...REGISTRATION,
                aiSystemId: 'aisys-1',
                ownerUserId: 'user-from-tenant-2',
            }),
        ).rejects.toThrow(/active member/i);
        expect(calls.agentCreates).toHaveLength(0);
    });

    it('refuses reassigning ownership to a non-member on UPDATE', async () => {
        // The same hole arrived at later. An update-only check that was never
        // written is the usual way this class of bug survives its own fix.
        useDb();
        await expect(
            updateRegisteredAgent(ctx, 'agent-1', { ownerUserId: 'user-from-tenant-2' }),
        ).rejects.toThrow(/active member/i);
    });

    it('refuses a vendor from another tenant', async () => {
        // `vendorId` is a PLAIN FK to Vendor.id, and Postgres runs FK checks as
        // the table owner — so RLS does not stop a cross-tenant supplier being
        // named as accountable for an agent.
        const { calls } = useDb({ vendors: ['vendor-mine'] });
        await expect(
            registerAgent(ctx, {
                ...REGISTRATION,
                provenance: 'THIRD_PARTY',
                vendorId: 'vendor-theirs',
            }),
        ).rejects.toThrow(/vendor/i);
        expect(calls.agentCreates).toHaveLength(0);
    });

    it('accepts a vendor that is this tenant’s', async () => {
        const { calls } = useDb({ vendors: ['vendor-mine'] });
        await registerAgent(ctx, {
            ...REGISTRATION,
            provenance: 'THIRD_PARTY',
            vendorId: 'vendor-mine',
        });
        expect(calls.agentCreates[0].data.vendorId).toBe('vendor-mine');
    });
});

// ─── 2. The autonomy ladder ─────────────────────────────────────────

describe('autonomy is a bounded integer ladder', () => {
    it.each([-1, 7, 2.5])('refuses %s and writes nothing', async (level) => {
        const { calls } = useDb();
        await expect(
            registerAgent(ctx, { ...REGISTRATION, autonomyLevel: level }),
        ).rejects.toThrow();
        expect(calls.agentCreates).toHaveLength(0);
    });

    it('refuses a boolean standing in for a level', async () => {
        // `true` is not rung 1. A caller sending it has answered a different
        // question from the one the register asks.
        const { calls } = useDb();
        await expect(
            registerAgent(ctx, { ...REGISTRATION, autonomyLevel: true as unknown as number }),
        ).rejects.toThrow();
        expect(calls.agentCreates).toHaveLength(0);
    });

    it.each([0, 6])('accepts the boundary rung %i', async (level) => {
        const { calls } = useDb();
        await registerAgent(ctx, { ...REGISTRATION, autonomyLevel: level });
        expect(calls.agentCreates[0].data.autonomyLevel).toBe(level);
    });
});

// ─── 3. Retirement vs the pending review queue ──────────────────────

describe('retirement is refused while proposals await a human', () => {
    it('refuses, names the count, and points at suspension', async () => {
        const { calls } = useDb({ pendingProposals: 3 });
        await expect(retireRegisteredAgent(ctx, 'agent-1')).rejects.toThrow(/3 proposal/);
        await expect(retireRegisteredAgent(ctx, 'agent-1')).rejects.toThrow(/suspend/i);
        // Nothing was written. A refusal that had already flipped the status
        // would leave the agent RETIRED with a live queue — the exact state the
        // check exists to prevent.
        expect(calls.statusUpdates).toHaveLength(0);
    });

    it('retires once the queue is empty', async () => {
        const { calls } = useDb({ pendingProposals: 0 });
        await expect(retireRegisteredAgent(ctx, 'agent-1')).resolves.toEqual({
            id: 'agent-1',
            status: 'RETIRED',
        });
        expect(calls.statusUpdates).toHaveLength(1);
        expect(calls.statusUpdates[0].data.status).toBe('RETIRED');
    });

    it('counts only PENDING — a decided proposal is history, not a blocker', async () => {
        const { db } = useDb({ pendingProposals: 0 });
        await retireRegisteredAgent(ctx, 'agent-1');
        expect(db.agentProposal.count).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', agentId: 'agent-1', status: 'PENDING' },
        });
    });

    it('SUSPEND has no such precondition — the emergency stop cannot be blocked', async () => {
        // This is what makes refusing retirement tolerable. An operator who
        // needs the agent stopped NOW is one route away from the control that
        // stops it, and that control asks nothing about the review queue.
        const { calls, db } = useDb({ pendingProposals: 42 });
        await expect(suspendRegisteredAgent(ctx, 'agent-1')).resolves.toEqual({
            id: 'agent-1',
            status: 'SUSPENDED',
        });
        expect(calls.statusUpdates[0].data.status).toBe('SUSPENDED');
        expect(db.agentProposal.count).not.toHaveBeenCalled();
    });
});

// ─── The register entry is authored, not fabricated ─────────────────

describe('registration authors the EU AI Act entry rather than taking one', () => {
    it('creates the AI-system row in the SAME transaction as the agent', async () => {
        const { calls } = useDb();
        await registerAgent(ctx, REGISTRATION);
        // One `runInTenantContext` call means one transaction. Two would make
        // "AI-system row with no agent" a reachable state.
        expect(mockRunInTx).toHaveBeenCalledTimes(1);
        expect(calls.aiSystemCreates).toHaveLength(1);
        expect(calls.agentCreates).toHaveLength(1);
        expect(calls.agentCreates[0].data.aiSystemId).toBe('aisys-1');
    });

    it('runs the classifier — an Annex III answer produces HIGH and cites the clause', async () => {
        const { calls } = useDb();
        const result = await registerAgent(ctx, {
            ...REGISTRATION,
            classification: { annexIIIArea: 'employment' },
        });
        expect(result.aiActRiskTier).toBe('HIGH');
        expect(result.aiActClauseId).toBe('Annex III(4)');
        // And the tier reached the stored row, not just the response.
        expect(calls.aiSystemCreates[0].data.riskTier).toBe('HIGH');
    });

    it('ignores a client-supplied tier — there is no field for it', async () => {
        const { calls } = useDb();
        await registerAgent(ctx, {
            ...REGISTRATION,
            riskTier: 'CRITICAL',
            aiActRiskTier: 'PROHIBITED',
        } as unknown as Record<string, unknown>);
        // The agent lands UNSCORED and the Act entry lands where the classifier
        // put it, whatever the caller claimed.
        expect(calls.agentCreates[0].data).not.toHaveProperty('riskTier');
        expect(calls.aiSystemCreates[0].data.riskTier).toBe('MINIMAL');
    });

    it('the agent arrives DRAFT and unscored — never plausibly low', async () => {
        useDb();
        const result = await registerAgent(ctx, REGISTRATION);
        expect(result.status).toBe('DRAFT');
        expect(result.riskTier).toBeNull();
    });
});
