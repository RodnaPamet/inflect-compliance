/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that mirror
 * a Prisma transaction client; per-line typing has poor cost/benefit here. */
/**
 * A RETIRED agent's policy card is FROZEN (#3698) — the two layers the
 * database cannot tell apart.
 *
 * The freeze is held twice: `assertCardNotFrozen` on the card's two write paths,
 * and the trigger `agent_policy_card_version_agent_not_retired` underneath. The
 * integration suite (`agent-retirement-cascade.test.ts`) proves the outcome on
 * real rows — but with both layers present a missing one is invisible there,
 * because each produces the same 409. So each layer is pinned here on its own:
 *
 *   • the usecase refuses BEFORE any write, so a retired agent's edit never
 *     reaches the card head (whose row lock an in-flight retirement would then
 *     have to wait behind);
 *   • the trigger's refusal, for the agent retired between the read and the
 *     write, comes back as that same typed 409 rather than a raw database error,
 *     and anything else the database throws comes back untouched.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import { createAgentPolicyCard, updateAgentPolicyCard } from '@/app-layer/usecases/agent-policy-card';
import { runInTenantContext } from '@/lib/db-context';
import { seedPolicyCardValue } from '@/lib/agentic/policy-card-evaluation';
import { ConflictError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'user-1' });

/** A valid card for a LOW agent, as both the version in force and the edit body. */
const CARD = seedPolicyCardValue({
    riskTier: 'LOW',
    dataAccessScope: 'READ_TENANT_DATA',
    grantedTools: [],
}).value;

interface Overrides {
    status: 'ACTIVE' | 'RETIRED';
    hasCard: boolean;
    /** What the version INSERT does — the seam the trigger lives behind. */
    versionInsert?: () => Promise<unknown>;
    /** What the card CREATE (with its nested version 1) does. */
    cardCreate?: () => Promise<unknown>;
}

function useDb(o: Overrides) {
    const db: any = {
        registeredAgent: {
            findFirst: jest.fn(async () => ({
                id: 'agent-1',
                status: o.status,
                riskTier: 'LOW',
                dataAccessScope: 'READ_TENANT_DATA',
            })),
        },
        agentPolicyCard: {
            findUnique: jest.fn(async () =>
                o.hasCard ? { id: 'card-1', agentId: 'agent-1', currentVersion: 1 } : null,
            ),
            updateMany: jest.fn(async () => ({ count: 1 })),
            create: jest.fn(o.cardCreate ?? (async () => ({ id: 'card-1', currentVersion: 1 }))),
        },
        agentPolicyCardVersion: {
            findUnique: jest.fn(async () => ({ id: 'v-1', version: 1, ...CARD })),
            create: jest.fn(o.versionInsert ?? (async () => ({ id: 'v-2' }))),
        },
        registeredAgentTool: { findMany: jest.fn(async () => []) },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db));
    return db;
}

const EDIT = { expectedVersion: 1, card: { ...CARD, permittedTools: [] } };
const TRIGGER_REFUSAL = () =>
    Promise.reject(
        new Error(
            "AGENT_RETIRED: a retired agent's policy card is frozen; no further version can be written.",
        ),
    );

beforeEach(() => jest.clearAllMocks());

describe('the usecase refuses a retired agent before any write', () => {
    it('an EDIT is a 409 that never touches the card head', async () => {
        const db = useDb({ status: 'RETIRED', hasCard: true });
        const err = await updateAgentPolicyCard(ctx, 'agent-1', EDIT).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as Error).message).toContain('policy card is frozen');
        expect(db.agentPolicyCard.updateMany).not.toHaveBeenCalled();
        expect(db.agentPolicyCardVersion.create).not.toHaveBeenCalled();
    });

    it('a CREATE is a 409 that writes no card', async () => {
        const db = useDb({ status: 'RETIRED', hasCard: false });
        await expect(createAgentPolicyCard(ctx, 'agent-1')).rejects.toBeInstanceOf(ConflictError);
        expect(db.agentPolicyCard.create).not.toHaveBeenCalled();
    });

    it('the paired positive — a live agent with the same card is edited', async () => {
        // Without it, the refusals above pass against a usecase that refuses everything.
        const db = useDb({ status: 'ACTIVE', hasCard: true });
        await expect(updateAgentPolicyCard(ctx, 'agent-1', EDIT)).resolves.toMatchObject({ version: 2 });
        expect(db.agentPolicyCardVersion.create).toHaveBeenCalledTimes(1);
    });
});

describe("the trigger's refusal comes back as the same 409, and nothing else does", () => {
    it('an edit raced by a retirement: the version insert is refused, and reported as frozen', async () => {
        useDb({ status: 'ACTIVE', hasCard: true, versionInsert: TRIGGER_REFUSAL });
        const err = await updateAgentPolicyCard(ctx, 'agent-1', EDIT).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect((err as Error).message).toContain('policy card is frozen');
    });

    it('a create raced by a retirement is reported the same way', async () => {
        useDb({ status: 'ACTIVE', hasCard: false, cardCreate: TRIGGER_REFUSAL });
        await expect(createAgentPolicyCard(ctx, 'agent-1')).rejects.toBeInstanceOf(ConflictError);
    });

    it('any other database failure is rethrown untouched — a broken database is not the control working', async () => {
        const failure = new Error('connection reset by peer');
        useDb({ status: 'ACTIVE', hasCard: true, versionInsert: () => Promise.reject(failure) });
        await expect(updateAgentPolicyCard(ctx, 'agent-1', EDIT)).rejects.toBe(failure);
    });
});
