/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that mirror
 * a Prisma transaction client; the file-level disable is this repo's standard
 * for the shape. */
/**
 * Agent ownership transfer — the ORDER the usecase owns (#3698).
 *
 * What the rows do is `tests/integration/agent-ownership-transfer.test.ts`. This
 * file pins what a real database cannot show by its end state:
 *
 *   1. the two-person rule is asked FIRST at step two — an initiator calling on
 *      a cancelled or expired transfer is told the rule, and nothing is written;
 *   2. an expired completion STAMPS the row inside the transaction and refuses
 *      AFTER it commits (a throw inside would roll the stamp back);
 *   3. the owner move precedes the completion claim — the agent row's lock
 *      before the transfer row's, the order retirement takes them in — and a
 *      lost claim throws inside the transaction, so the move rolls back with it;
 *   4. step one locks the agent row (`FOR SHARE`) BEFORE it stamps a lapsed
 *      transfer — agent row first, the order every other path takes — stamps
 *      before looking for an open one, and maps the partial-unique race and the
 *      retired-agent trigger to a conflict;
 *   5. a recipient's BUILT-IN membership role is asked as well as the key: the
 *      edge refuses a READER, EDITOR or AUDITOR role before the route runs, and
 *      admits an AI_ADMIN (#3699), which holds the key by default;
 *   6. a lapsed cancel is stamped and committed before it is refused;
 *   7. every verb asserts `admin.agent_ownership` (#3699) before touching the
 *      database.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    cancelAgentOwnershipTransfer,
    completeAgentOwnershipTransfer,
    getAgentOwnershipTransfers,
    proposeAgentOwnershipTransfer,
} from '@/app-layer/usecases/agent-ownership-transfer';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { ConflictError, ForbiddenError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;

const DAY = 24 * 60 * 60 * 1000;
const ctxFor = (userId: string, role: 'OWNER' | 'ADMIN' = 'OWNER') =>
    makeRequestContext(role, { tenantId: 'tenant-1', userId });

interface Fixture {
    transfer?: Record<string, unknown> | null;
    agent?: Record<string, unknown> | null;
    moved?: number;
    claimed?: number;
    createError?: unknown;
    membership?: Record<string, unknown> | null;
}

function transferRow(over: Record<string, unknown> = {}) {
    return {
        id: 'transfer-1',
        agentId: 'agent-1',
        fromOwnerUserId: 'owner-a',
        toOwnerUserId: 'owner-b',
        initiatedByUserId: 'owner-a',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + DAY),
        completedAt: null,
        completedByUserId: null,
        cancelledAt: null,
        cancelledByUserId: null,
        createdAt: new Date(),
        ...over,
    };
}

/** Records whether the transaction body RESOLVED (committed) or THREW (rolled back). */
const txOutcomes: Array<'committed' | 'rolled back'> = [];

const AGENT_ROW = { id: 'agent-1', status: 'ACTIVE', name: 'n', ownerUserId: 'owner-a', aiSystemId: 'sys-1' };

function useDb(f: Fixture = {}) {
    const db: any = {
        // `lockLifecycleStateForShare` — the locking read of the same row.
        $queryRaw: jest.fn(async () => {
            const agent = f.agent === undefined ? AGENT_ROW : f.agent;
            return agent ? [agent] : [];
        }),
        agentOwnershipTransfer: {
            findFirst: jest.fn(async () => (f.transfer === undefined ? transferRow() : f.transfer)),
            findMany: jest.fn(async () => []),
            updateMany: jest.fn(async ({ data }: any) => ({
                count: data.status === 'COMPLETED' ? (f.claimed ?? 1) : 1,
            })),
            create: jest.fn(async ({ data }: any) => {
                if (f.createError) throw f.createError;
                return transferRow({ ...data, id: 'transfer-new' });
            }),
        },
        registeredAgent: {
            findFirst: jest.fn(async () => (f.agent === undefined ? AGENT_ROW : f.agent)),
            updateMany: jest.fn(async () => ({ count: f.moved ?? 1 })),
        },
        tenantMembership: {
            findFirst: jest.fn(async () =>
                f.membership === undefined ? { role: 'OWNER', customRole: null } : f.membership,
            ),
        },
        aiSystem: { findFirst: jest.fn(async () => ({ ownerUserId: 'owner-a' })) },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (d: unknown) => Promise<unknown>) => {
        try {
            const out = await fn(db);
            txOutcomes.push('committed');
            return out;
        } catch (err) {
            txOutcomes.push('rolled back');
            throw err;
        }
    });
    return db;
}

const order = (fn: jest.Mock, nth = 0) => fn.mock.invocationCallOrder[nth];

beforeEach(() => {
    jest.clearAllMocks();
    txOutcomes.length = 0;
});

describe('step two asks the two-person rule before anything else', () => {
    it.each([
        ['PENDING and expired', { expiresAt: new Date(Date.now() - DAY) }],
        ['CANCELLED', { status: 'CANCELLED' }],
        ['COMPLETED', { status: 'COMPLETED' }],
    ])('an initiator calling on a %s transfer is forbidden, and nothing is written', async (_l, over) => {
        const db = useDb({ transfer: transferRow(over) });
        const err = await completeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', {
            transferId: 'transfer-1',
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenError);
        // The refusal NAMES the rule: it is about who started it, not about
        // the row's state and not merely "you are not the recipient".
        expect((err as Error).message).toContain('You started this transfer');
        expect(db.agentOwnershipTransfer.updateMany).not.toHaveBeenCalled();
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('somebody who is neither party is forbidden before the expiry is stamped', async () => {
        const db = useDb({ transfer: transferRow({ expiresAt: new Date(Date.now() - DAY) }) });
        await expect(
            completeAgentOwnershipTransfer(ctxFor('owner-c'), 'agent-1', { transferId: 'transfer-1' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(db.agentOwnershipTransfer.updateMany).not.toHaveBeenCalled();
    });
});

describe('an expired completion is stamped, committed, and only then refused', () => {
    it('stamps EXPIRED inside the transaction and throws after it commits', async () => {
        const db = useDb({ transfer: transferRow({ expiresAt: new Date(Date.now() - DAY) }) });
        await expect(
            completeAgentOwnershipTransfer(ctxFor('owner-b'), 'agent-1', { transferId: 'transfer-1' }),
        ).rejects.toThrow(/expired/);
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'EXPIRED' } }),
        );
        // A throw INSIDE would roll the stamp back; the body must have resolved.
        expect(txOutcomes).toEqual(['committed']);
        expect(db.registeredAgent.updateMany).not.toHaveBeenCalled();
    });
});

describe('the owner move precedes the completion claim', () => {
    it('moves the owner (agent row) before claiming the transfer (transfer row)', async () => {
        const db = useDb();
        await completeAgentOwnershipTransfer(ctxFor('owner-b'), 'agent-1', { transferId: 'transfer-1' });
        expect(db.registeredAgent.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'agent-1',
                tenantId: 'tenant-1',
                deletedAt: null,
                status: { not: 'RETIRED' },
                ownerUserId: 'owner-a',
            },
            data: { ownerUserId: 'owner-b' },
        });
        const claim = db.agentOwnershipTransfer.updateMany;
        expect(claim).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: 'PENDING', toOwnerUserId: 'owner-b' }),
            }),
        );
        expect(order(db.registeredAgent.updateMany)).toBeLessThan(order(claim));
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        expect(order(mockLogEvent as unknown as jest.Mock)).toBeGreaterThan(order(claim));
    });

    it('a lost claim throws INSIDE the transaction, so the owner move rolls back with it', async () => {
        const db = useDb({ claimed: 0 });
        await expect(
            completeAgentOwnershipTransfer(ctxFor('owner-b'), 'agent-1', { transferId: 'transfer-1' }),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(db.registeredAgent.updateMany).toHaveBeenCalledTimes(1);
        expect(txOutcomes).toEqual(['rolled back']);
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('an owner move that matches nothing (retired or re-owned meanwhile) claims nothing', async () => {
        const db = useDb({ moved: 0 });
        await expect(
            completeAgentOwnershipTransfer(ctxFor('owner-b'), 'agent-1', { transferId: 'transfer-1' }),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(db.agentOwnershipTransfer.updateMany).not.toHaveBeenCalled();
    });
});

describe('step one', () => {
    it('locks the agent row FOR SHARE before it touches any transfer row', async () => {
        // The other order — stamp the lapsed row, THEN wait on the agent row in
        // the insert trigger — deadlocked with a retirement holding the agent
        // row and reaching for that same transfer row.
        const db = useDb({ transfer: null });
        await proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' });
        expect(db.$queryRaw).toHaveBeenCalledTimes(1);
        const sql = (db.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
        expect(sql).toContain('FROM "RegisteredAgent"');
        expect(sql.trimEnd().endsWith('FOR SHARE')).toBe(true);
        // Nothing else read the agent plainly instead.
        expect(db.registeredAgent.findFirst).not.toHaveBeenCalled();
        const firstTransferWrite = order(db.agentOwnershipTransfer.updateMany);
        expect(order(db.$queryRaw)).toBeLessThan(firstTransferWrite);
        expect(order(db.$queryRaw)).toBeLessThan(order(db.agentOwnershipTransfer.create));
    });

    it.each([
        ['a READER', { role: 'READER', customRole: { baseRole: 'READER', permissionsJson: { admin: { agent_ownership: true } } } }],
        ['an EDITOR', { role: 'EDITOR', customRole: { baseRole: 'EDITOR', permissionsJson: { admin: { agent_ownership: true } } } }],
        ['an AUDITOR', { role: 'AUDITOR', customRole: { baseRole: 'AUDITOR', permissionsJson: { admin: { agent_ownership: true } } } }],
    ])('refuses %s membership even when its custom role carries the key', async (_l, membership) => {
        const db = useDb({ transfer: null, membership });
        await expect(
            proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' }),
        ).rejects.toThrow(/an OWNER, an AI admin, or an ADMIN whose custom role carries/);
        expect(db.agentOwnershipTransfer.create).not.toHaveBeenCalled();
    });

    it('accepts an ADMIN membership whose custom role carries the key', async () => {
        const db = useDb({
            transfer: null,
            membership: {
                role: 'ADMIN',
                customRole: { baseRole: 'READER', permissionsJson: { admin: { agent_ownership: true } } },
            },
        });
        await proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' });
        expect(db.agentOwnershipTransfer.create).toHaveBeenCalledTimes(1);
    });

    it('accepts an AI_ADMIN membership with no custom role — it holds the key by default (#3699)', async () => {
        const db = useDb({ transfer: null, membership: { role: 'AI_ADMIN', customRole: null } });
        await proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' });
        expect(db.agentOwnershipTransfer.create).toHaveBeenCalledTimes(1);
    });

    it('refuses an AI_ADMIN membership whose custom role withdraws the key', async () => {
        const db = useDb({
            transfer: null,
            membership: {
                role: 'AI_ADMIN',
                customRole: { baseRole: 'READER', permissionsJson: { admin: { agent_ownership: false } } },
            },
        });
        await expect(
            proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' }),
        ).rejects.toThrow(/agent ownership permission/);
        expect(db.agentOwnershipTransfer.create).not.toHaveBeenCalled();
    });

    it('refuses a plain ADMIN membership — the register key is not the ownership key', async () => {
        const db = useDb({ transfer: null, membership: { role: 'ADMIN', customRole: null } });
        await expect(
            proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' }),
        ).rejects.toThrow(/agent ownership permission/);
        expect(db.agentOwnershipTransfer.create).not.toHaveBeenCalled();
    });

    it('stamps a lapsed transfer BEFORE looking for an open one', async () => {
        const db = useDb({ transfer: null });
        await proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' });
        const expire = db.agentOwnershipTransfer.updateMany;
        expect(expire).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                agentId: 'agent-1',
                status: 'PENDING',
                expiresAt: { lte: expect.any(Date) },
            },
            data: { status: 'EXPIRED' },
        });
        expect(order(expire)).toBeLessThan(order(db.agentOwnershipTransfer.findFirst));
        expect(db.agentOwnershipTransfer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    fromOwnerUserId: 'owner-a',
                    toOwnerUserId: 'owner-b',
                    initiatedByUserId: 'owner-a',
                    status: 'PENDING',
                }),
            }),
        );
    });

    it.each([
        ['the partial-unique race (P2002)', Object.assign(new Error('unique'), { code: 'P2002' })],
        ['the retired-agent insert trigger', new Error('AGENT_RETIRED: a retired agent’s ownership cannot be transferred.')],
    ])('maps %s to a conflict', async (_l, createError) => {
        useDb({ transfer: null, createError });
        await expect(
            proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' }),
        ).rejects.toBeInstanceOf(ConflictError);
    });

    it('any other database error is rethrown untouched — a broken database is not the control working', async () => {
        useDb({ transfer: null, createError: new Error('connection reset') });
        await expect(
            proposeAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { toOwnerUserId: 'owner-b' }),
        ).rejects.toThrow('connection reset');
    });
});

describe('a lapsed cancel is stamped, committed, and only then refused', () => {
    it('stamps EXPIRED inside the transaction, writes no cancellation, and throws after it commits', async () => {
        const db = useDb({ transfer: transferRow({ expiresAt: new Date(Date.now() - DAY) }) });
        await expect(
            cancelAgentOwnershipTransfer(ctxFor('owner-a'), 'agent-1', { transferId: 'transfer-1' }),
        ).rejects.toThrow(/already expired/);
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledTimes(1);
        expect(db.agentOwnershipTransfer.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'EXPIRED' } }),
        );
        expect(txOutcomes).toEqual(['committed']);
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});

describe('every verb takes admin.agent_ownership before touching the database', () => {
    it.each([
        ['read', () => getAgentOwnershipTransfers(ctxFor('admin-1', 'ADMIN'), 'agent-1')],
        ['propose', () => proposeAgentOwnershipTransfer(ctxFor('admin-1', 'ADMIN'), 'agent-1', { toOwnerUserId: 'owner-b' })],
        ['complete', () => completeAgentOwnershipTransfer(ctxFor('admin-1', 'ADMIN'), 'agent-1', { transferId: 'transfer-1' })],
        ['cancel', () => cancelAgentOwnershipTransfer(ctxFor('admin-1', 'ADMIN'), 'agent-1', { transferId: 'transfer-1' })],
    ])('%s refuses an ADMIN (who holds the register key)', async (_l, call) => {
        useDb();
        await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('a context holding tenant lifecycle but NOT agent ownership is refused — the key moved (#3699)', async () => {
        useDb();
        const base = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });
        const lifecycleOnly = {
            ...base,
            appPermissions: {
                ...base.appPermissions,
                admin: { ...base.appPermissions.admin, tenant_lifecycle: true, agent_ownership: false },
            },
        };
        await expect(getAgentOwnershipTransfers(lifecycleOnly, 'agent-1')).rejects.toBeInstanceOf(
            ForbiddenError,
        );
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('an AI_ADMIN context passes the gate (the read reaches the database)', async () => {
        useDb({ transfer: null });
        const ai = makeRequestContext('AI_ADMIN', { tenantId: 'tenant-1', userId: 'ai-1' });
        expect(ai.permissions.canWrite).toBe(false);
        await getAgentOwnershipTransfers(ai, 'agent-1').catch(() => undefined);
        expect(mockRunInTx).toHaveBeenCalled();
    });
});
