/**
 * Which agent answers on Ask can now be chosen (#4629).
 *
 * `TenantSecuritySettings.interactiveAgentId` was read on every question and
 * written by nothing, so every question was refused `NO_AGENT_DESIGNATED`. The
 * usecase that writes it takes the register floor, refuses an agent the
 * workspace does not hold and a retired one, audits each change, and clears
 * only while the agent it names is still the designation.
 */
type Agent = { id: string; name: string; status: string } | null;
let agent: Agent = { id: 'agent-1', name: 'Helper', status: 'ACTIVE' };
let settings: { interactiveAgentId: string | null } | null = null;

const findFirst = jest.fn(async (_args: unknown): Promise<unknown> => agent);
const findUnique = jest.fn(async (_args: unknown): Promise<unknown> => settings);
const upsert = jest.fn(async (_args: unknown): Promise<unknown> => ({}));
const updateMany = jest.fn(async (_args: unknown): Promise<{ count: number }> => ({ count: 1 }));
const mockDb = {
    registeredAgent: { findFirst },
    tenantSecuritySettings: { findUnique, upsert, updateMany },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const logEvent = jest.fn(async () => undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));

import {
    clearInteractiveAgent,
    designateInteractiveAgent,
    getInteractiveAgentDesignation,
} from '@/app-layer/usecases/interactive-agent-designation';
import { makeRequestContext } from '../helpers/make-context';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors/types';

const admin = () => makeRequestContext('ADMIN', { tenantId: 't-1', userId: 'u-1' });
const aiAdmin = () => makeRequestContext('AI_ADMIN', { tenantId: 't-1', userId: 'u-2' });
const editor = () => makeRequestContext('EDITOR', { tenantId: 't-1', userId: 'u-3' });

beforeEach(() => {
    jest.clearAllMocks();
    agent = { id: 'agent-1', name: 'Helper', status: 'ACTIVE' };
    settings = null;
    updateMany.mockResolvedValue({ count: 1 });
});

describe('designateInteractiveAgent', () => {
    it('writes the designation for a tenant with no settings row yet, and audits it', async () => {
        await expect(designateInteractiveAgent(admin(), 'agent-1')).resolves.toEqual({
            interactiveAgentId: 'agent-1',
            previous: null,
        });
        expect(findFirst.mock.calls[0][0]).toEqual({
            where: { id: 'agent-1', tenantId: 't-1', deletedAt: null },
            select: { id: true, name: true, status: true },
        });
        expect(upsert.mock.calls[0][0]).toEqual({
            where: { tenantId: 't-1' },
            create: { tenantId: 't-1', interactiveAgentId: 'agent-1' },
            update: { interactiveAgentId: 'agent-1' },
        });
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect(logEvent.mock.calls[0]).toEqual([
            mockDb,
            expect.anything(),
            expect.objectContaining({
                action: 'INTERACTIVE_AGENT_DESIGNATED',
                entityId: 'agent-1',
                detailsJson: expect.objectContaining({ category: 'access', previousAgentId: null }),
            }),
        ]);
    });

    it('records the agent it replaced', async () => {
        settings = { interactiveAgentId: 'agent-0' };
        await expect(designateInteractiveAgent(admin(), 'agent-1')).resolves.toEqual({
            interactiveAgentId: 'agent-1',
            previous: 'agent-0',
        });
        expect(logEvent.mock.calls[0]).toEqual([
            mockDb, expect.anything(), expect.objectContaining({ detailsJson: expect.objectContaining({ previousAgentId: 'agent-0' }) }),
        ]);
    });

    it('writes nothing when the agent is already the designation', async () => {
        settings = { interactiveAgentId: 'agent-1' };
        await designateInteractiveAgent(admin(), 'agent-1');
        expect(upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('lets an AI admin designate, as it can register', async () => {
        await expect(designateInteractiveAgent(aiAdmin(), 'agent-1')).resolves.toMatchObject({ interactiveAgentId: 'agent-1' });
    });

    it('refuses an agent the workspace does not hold', async () => {
        agent = null;
        await expect(designateInteractiveAgent(admin(), 'elsewhere')).rejects.toBeInstanceOf(NotFoundError);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('refuses a retired agent, which can never answer', async () => {
        agent = { id: 'agent-1', name: 'Helper', status: 'RETIRED' };
        await expect(designateInteractiveAgent(admin(), 'agent-1')).rejects.toBeInstanceOf(ConflictError);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('refuses a caller below the register floor before reading anything', async () => {
        // The floor is the register's own: the coarse write tier OR the
        // register key. The ROUTE's literal `admin.agent_registry` is what
        // keeps an Editor out; a Reader fails both.
        const reader = makeRequestContext('READER', { tenantId: 't-1', userId: 'u-4' });
        await expect(designateInteractiveAgent(reader, 'agent-1')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(clearInteractiveAgent(reader, 'agent-1')).rejects.toBeInstanceOf(ForbiddenError);
        expect(findFirst).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });
});

describe('clearInteractiveAgent', () => {
    it('clears only while the named agent is still the designation', async () => {
        await expect(clearInteractiveAgent(admin(), 'agent-1')).resolves.toEqual({ cleared: true });
        expect(updateMany.mock.calls[0][0]).toEqual({
            where: { tenantId: 't-1', interactiveAgentId: 'agent-1' },
            data: { interactiveAgentId: null },
        });
        expect(logEvent.mock.calls[0]).toEqual([mockDb, expect.anything(), expect.objectContaining({ action: 'INTERACTIVE_AGENT_CLEARED' })]);
    });

    it('is a no-op, and audits nothing, when another agent has been designated since', async () => {
        updateMany.mockResolvedValue({ count: 0 });
        await expect(clearInteractiveAgent(admin(), 'agent-1')).resolves.toEqual({ cleared: false });
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('getInteractiveAgentDesignation', () => {
    it('reads the designation, null when none', async () => {
        await expect(getInteractiveAgentDesignation(editor())).resolves.toBeNull();
        settings = { interactiveAgentId: 'agent-1' };
        await expect(getInteractiveAgentDesignation(editor())).resolves.toBe('agent-1');
    });
});
