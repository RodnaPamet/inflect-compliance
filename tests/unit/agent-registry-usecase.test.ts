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
 *   3. Retiring an agent CASCADES (#3698): its keys are revoked, its grants
 *      dropped, its pending proposals expired and its card frozen, in one
 *      transaction under `admin.agent_registry` alone. What is asserted here is
 *      the ORDER the usecase owns and the database cannot see — status first,
 *      audit rows last, so an effect that throws leaves no audit row describing
 *      a retirement that rolled back — plus the gate, the one-cascade-per-agent
 *      refusal, and that RETIRED is terminal for activate and suspend. What the
 *      cascade does to real rows is `agent-retirement-cascade.test.ts`.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    activateRegisteredAgent,
    createRegisteredAgent,
    registerAgent,
    retireRegisteredAgent,
    suspendRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'user-1' });

/** A member row, or null when the id is not an ACTIVE member of tenant-1. */
const ACTIVE_MEMBERS = new Set(['user-1', 'owner-1']);

interface DbOverrides {
    vendors?: readonly string[];
    /** The agent's status as the lifecycle pre-read sees it; `null` = no such agent here. */
    agentStatus?: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED' | null;
    /** Unrevoked keys bound to the agent, and how many of them are unexpired. */
    unrevokedKeys?: number;
    liveKeys?: number;
    scannerKeys?: number;
    tools?: readonly string[];
    pendingProposals?: number;
    card?: { id: string; currentVersion: number } | null;
    /** Make the grant delete throw — the effect that fails mid-cascade. */
    failToolDelete?: boolean;
    /** The agent's open (PENDING) ownership transfer, if any; lapsed when `expiresAt` has passed. */
    openTransfer?: { id: string; toOwnerUserId: string; expiresAt: Date } | null;
}

const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}` }));

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
            findMany: jest.fn(async () => ids('proposal', overrides.pendingProposals ?? 0)),
            updateMany: jest.fn(async () => ({ count: overrides.pendingProposals ?? 0 })),
        },
        tenantApiKey: {
            findMany: jest.fn(async () => ids('key', overrides.unrevokedKeys ?? 0)),
            count: jest.fn(async () => overrides.liveKeys ?? overrides.unrevokedKeys ?? 0),
            updateMany: jest.fn(async () => ({ count: overrides.unrevokedKeys ?? 0 })),
        },
        agentHarnessScannerKey: {
            findMany: jest.fn(async () => ids('scanner-key', overrides.scannerKeys ?? 0)),
            updateMany: jest.fn(async () => ({ count: overrides.scannerKeys ?? 0 })),
        },
        registeredAgentTool: {
            findMany: jest.fn(async () =>
                (overrides.tools ?? []).map((toolName, i) => ({ id: `grant-${i}`, toolName })),
            ),
            deleteMany: jest.fn(async () => {
                if (overrides.failToolDelete) throw new Error('connection reset mid-cascade');
                return { count: (overrides.tools ?? []).length };
            }),
        },
        agentPolicyCard: {
            findUnique: jest.fn(async () => overrides.card ?? null),
        },
        agentOwnershipTransfer: {
            findFirst: jest.fn(async () => overrides.openTransfer ?? null),
            updateMany: jest.fn(async () => ({ count: overrides.openTransfer ? 1 : 0 })),
        },
        registeredAgent: {
            create: jest.fn(async (args: any) => {
                calls.agentCreates.push(args);
                return { id: 'agent-1', status: 'DRAFT', riskTier: null };
            }),
            // The lifecycle pre-read (and the scoring read, which selects
            // different columns from the same row).
            findFirst: jest.fn(async ({ where }: any) => {
                const status = overrides.agentStatus === undefined ? 'ACTIVE' : overrides.agentStatus;
                if (status === null || where.tenantId !== 'tenant-1') return null;
                return {
                    id: where.id,
                    status,
                    name: 'Ops agent',
                    ownerUserId: 'owner-1',
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                };
            }),
            // Emulates the repository's terminal predicate: a RETIRED row
            // matches nothing, whatever status is asked for.
            updateMany: jest.fn(async (args: any) => {
                calls.statusUpdates.push(args);
                const retired = overrides.agentStatus === 'RETIRED';
                return { count: retired && args.where?.status?.not === 'RETIRED' ? 0 : 1 };
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

    it('refuses ANY owner change on UPDATE — ownership moves only by a two-step transfer', async () => {
        // Until #3698 this asserted that an amend refused a non-member owner,
        // which implied an amend could move the owner to a member. It cannot:
        // the PATCH takes `admin.agent_registry`, which ADMIN holds, and the
        // owner moves only by the transfer under `admin.tenant_lifecycle`.
        // A member and a non-member are refused alike, by name, before
        // anything is read or written.
        const { db } = useDb();
        for (const ownerUserId of ['user-from-tenant-2', 'user-1']) {
            await expect(
                updateRegisteredAgent(ctx, 'agent-1', { ownerUserId }),
            ).rejects.toThrow(/two-step transfer/);
        }
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
        expect(db.tenantMembership.findFirst).not.toHaveBeenCalled();
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

// ─── 3. Retirement is one act, and its order is the usecase's ─────────

/** The `invocationCallOrder` of a mock's first call — the global sequence number. */
const firstCall = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
const lastCall = (fn: jest.Mock) => fn.mock.invocationCallOrder[fn.mock.invocationCallOrder.length - 1];

const FULL_AGENT: DbOverrides = {
    unrevokedKeys: 3,
    liveKeys: 2,
    scannerKeys: 1,
    tools: ['list_risks', 'propose_risks'],
    pendingProposals: 4,
    card: { id: 'card-1', currentVersion: 3 },
    openTransfer: { id: 'transfer-1', toOwnerUserId: 'owner-2', expiresAt: new Date(Date.now() + 86_400_000) },
};

describe('retirement cascades, status first and audit last', () => {
    it('writes the status BEFORE any effect, and every effect before the first audit row', async () => {
        // Status first is what serialises against an agent still in flight: the
        // UPDATE holds the agent row's lock, which the proposal and card-version
        // triggers wait on. Audit last because `logEvent` appends on its own
        // connection — a row written before an effect would survive a rollback.
        const { db } = useDb(FULL_AGENT);
        await retireRegisteredAgent(ctx, 'agent-1');

        const statusAt = firstCall(db.registeredAgent.updateMany);
        const effectWrites = [
            db.tenantApiKey.updateMany,
            db.agentHarnessScannerKey.updateMany,
            db.registeredAgentTool.deleteMany,
            db.agentProposal.updateMany,
            db.agentOwnershipTransfer.updateMany,
        ];
        for (const write of effectWrites) {
            expect(write).toHaveBeenCalledTimes(1);
            expect(firstCall(write)).toBeGreaterThan(statusAt);
        }
        const lastEffect = Math.max(...effectWrites.map(lastCall), lastCall(db.agentPolicyCard.findUnique));
        expect(mockLogEvent).toHaveBeenCalled();
        expect(firstCall(mockLogEvent as unknown as jest.Mock)).toBeGreaterThan(lastEffect);
    });

    it('an effect that throws leaves NO audit row — the rollback is not narrated', async () => {
        const { db } = useDb({ ...FULL_AGENT, failToolDelete: true });
        await expect(retireRegisteredAgent(ctx, 'agent-1')).rejects.toThrow(/connection reset/);
        // The status write and the key revocation did run (inside the
        // transaction the failure rolls back); what must not exist is a
        // hash-chained row, written outside it, saying they happened.
        expect(db.registeredAgent.updateMany).toHaveBeenCalledTimes(1);
        expect(db.tenantApiKey.updateMany).toHaveBeenCalledTimes(1);
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('records the summary with every count, then one row per effect that changed something', async () => {
        useDb(FULL_AGENT);
        const result = await retireRegisteredAgent(ctx, 'agent-1');

        const actions = mockLogEvent.mock.calls.map(([, , payload]) => payload.action);
        expect(actions).toEqual([
            'AGENT_RETIRED',
            'AGENT_RETIREMENT_KEYS_REVOKED',
            'AGENT_RETIREMENT_SCANNER_KEYS_REVOKED',
            'AGENT_RETIREMENT_TOOLS_DROPPED',
            'AGENT_RETIREMENT_PROPOSALS_EXPIRED',
            'AGENT_RETIREMENT_POLICY_CARD_FROZEN',
            'AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED',
        ]);
        const summary = mockLogEvent.mock.calls[0][2].detailsJson as Record<string, any>;
        expect(summary.fromStatus).toBe('ACTIVE');
        expect(summary.toStatus).toBe('RETIRED');
        expect(summary.cascade).toEqual({
            apiKeysRevoked: 3,
            liveApiKeysRevoked: 2,
            scannerKeysRevoked: 1,
            toolGrantsDropped: 2,
            proposalsExpired: 4,
            policyCardFrozenAtVersion: 3,
            ownershipTransferCancelled: 'transfer-1',
            evidenceArtefactsWithdrawn: 0,
            evidenceBasis: 'POPULATION_LEVEL_ONLY',
        });
        // The response carries the same summary the row does.
        expect(result).toEqual({ id: 'agent-1', status: 'RETIRED', cascade: summary.cascade });

        const tools = mockLogEvent.mock.calls[3][2].detailsJson as Record<string, any>;
        expect(tools.before).toEqual({ toolNames: ['list_risks', 'propose_risks'] });
        const proposals = mockLogEvent.mock.calls[4][2].detailsJson as Record<string, any>;
        expect(proposals.proposalIds).toEqual(['proposal-1', 'proposal-2', 'proposal-3', 'proposal-4']);
        expect(proposals.idsTruncated).toBe(false);
        const transfer = mockLogEvent.mock.calls[6][2].detailsJson as Record<string, any>;
        expect(transfer.transferId).toBe('transfer-1');
        expect(transfer.targetUserId).toBe('owner-2');
    });

    it('cancels a LIVE open transfer, attributed to the retiring actor', async () => {
        const { db } = useDb(FULL_AGENT);
        await retireRegisteredAgent(ctx, 'agent-1');
        const [{ where, data }] = db.agentOwnershipTransfer.updateMany.mock.calls[0];
        expect(where).toEqual({
            id: 'transfer-1',
            tenantId: 'tenant-1',
            agentId: 'agent-1',
            status: 'PENDING',
        });
        expect(data).toEqual(
            expect.objectContaining({ status: 'CANCELLED', cancelledByUserId: 'user-1' }),
        );
    });

    it('stamps a LAPSED open transfer EXPIRED — no actor, no cancellation row', async () => {
        // It ended on its own; recording a cancellation would attribute an act
        // to the retiring actor that they did not perform.
        const { db } = useDb({
            ...FULL_AGENT,
            openTransfer: { id: 'transfer-1', toOwnerUserId: 'owner-2', expiresAt: new Date(Date.now() - 1000) },
        });
        const result = await retireRegisteredAgent(ctx, 'agent-1');
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledTimes(1);
        expect(db.agentOwnershipTransfer.updateMany.mock.calls[0][0]).toEqual({
            where: { id: 'transfer-1', tenantId: 'tenant-1', agentId: 'agent-1', status: 'PENDING' },
            data: { status: 'EXPIRED' },
        });
        expect(result.cascade.ownershipTransferCancelled).toBeNull();
        expect(mockLogEvent.mock.calls.map(([, , p]) => p.action)).not.toContain(
            'AGENT_RETIREMENT_OWNERSHIP_TRANSFER_CANCELLED',
        );
    });

    it('an agent with nothing to take away gets the summary row alone', async () => {
        // No row asserting an act that did not happen. The zeroes are on the
        // summary, once.
        useDb({ agentStatus: 'DRAFT' });
        await retireRegisteredAgent(ctx, 'agent-1');
        expect(mockLogEvent.mock.calls.map(([, , p]) => p.action)).toEqual(['AGENT_RETIRED']);
        const summary = mockLogEvent.mock.calls[0][2].detailsJson as Record<string, any>;
        expect(summary.cascade.apiKeysRevoked).toBe(0);
        expect(summary.cascade.policyCardFrozenAtVersion).toBeNull();
    });

    it('expires PENDING proposals only — the predicate names the agent, the tenant and PENDING', async () => {
        const { db } = useDb(FULL_AGENT);
        await retireRegisteredAgent(ctx, 'agent-1');
        expect(db.agentProposal.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', agentId: 'agent-1', status: 'PENDING' },
            data: { status: 'EXPIRED' },
        });
        expect(db.registeredAgentTool.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', agentId: 'agent-1' },
        });
    });

    it('takes admin.agent_registry, and a writer without it is refused before anything is written', async () => {
        const { db } = useDb(FULL_AGENT);
        const editor = makeRequestContext('EDITOR', { tenantId: 'tenant-1', userId: 'user-1' });
        const noRegistry = {
            ...editor,
            appPermissions: {
                ...editor.appPermissions,
                admin: { ...editor.appPermissions.admin, agent_registry: false },
            },
        };
        await expect(retireRegisteredAgent(noRegistry, 'agent-1')).rejects.toThrow(/agent register/i);
        expect(db.registeredAgent.findFirst).not.toHaveBeenCalled();
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('and needs no narrower key — admin.agent_registry alone runs the whole cascade', async () => {
        // 0e: every effect takes authority away, so retirement does not also ask
        // for the keys that gate each effect on its own.
        useDb(FULL_AGENT);
        const registryOnly = {
            ...ctx,
            appPermissions: {
                ...ctx.appPermissions,
                admin: {
                    ...ctx.appPermissions.admin,
                    manage: false,
                    agent_tool_exposure: false,
                    agent_policy_card: false,
                },
            },
        };
        const result = await retireRegisteredAgent(registryOnly, 'agent-1');
        expect(result.cascade.apiKeysRevoked).toBe(3);
        expect(result.cascade.toolGrantsDropped).toBe(2);
    });

    it('an agent already RETIRED is a conflict and gets no second cascade', async () => {
        const { db } = useDb({ ...FULL_AGENT, agentStatus: 'RETIRED' });
        await expect(retireRegisteredAgent(ctx, 'agent-1')).rejects.toThrow(/already retired/i);
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
        expect(db.tenantApiKey.updateMany).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it("another tenant's agent is not found, and nothing is written", async () => {
        const { db } = useDb({ ...FULL_AGENT, agentStatus: null });
        await expect(retireRegisteredAgent(ctx, 'agent-1')).rejects.toThrow(/not found/i);
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
    });
});

describe('RETIRED is terminal; SUSPEND stays the reversible stop', () => {
    it('SUSPEND still has no precondition on a live agent — pending proposals included', async () => {
        const { calls, db } = useDb({ pendingProposals: 42 });
        await expect(suspendRegisteredAgent(ctx, 'agent-1')).resolves.toEqual({
            id: 'agent-1',
            status: 'SUSPENDED',
        });
        expect(calls.statusUpdates[0].data.status).toBe('SUSPENDED');
        expect(db.agentProposal.updateMany).not.toHaveBeenCalled();
    });

    it.each([
        ['suspend', suspendRegisteredAgent, /nothing to suspend/i],
        ['activate', activateRegisteredAgent, /cannot be put back into service/i],
    ] as const)('%s refuses a RETIRED agent and writes nothing', async (_name, move, message) => {
        const { db } = useDb({ agentStatus: 'RETIRED' });
        await expect(move(ctx, 'agent-1')).rejects.toThrow(message);
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('the status write itself carries the terminal predicate', async () => {
        // The backstop for a retirement that lands between the pre-read and the
        // write: the WHERE excludes RETIRED, so the race matches zero rows.
        const { db } = useDb();
        await suspendRegisteredAgent(ctx, 'agent-1');
        expect(db.registeredAgent.updateMany.mock.calls[0][0].where).toMatchObject({
            id: 'agent-1',
            tenantId: 'tenant-1',
            status: { not: 'RETIRED' },
        });
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
