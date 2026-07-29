/**
 * Coverage wave E batch 3 — `src/app-layer/automation/AutomationRuleRepository.ts`.
 *
 * A mock-`db` repository test in the Wave D style: assert the QUERY SHAPE
 * rather than round-tripping a database.
 *
 * Two invariants get the most attention:
 *   • every query is tenant-scoped — the RLS policy is belt-and-braces, but a
 *     missing `tenantId` here would make the app-layer filter the only thing
 *     standing between tenants if RLS were ever bypassed.
 *   • `update` is a tri-state patch: an ABSENT key leaves the column alone,
 *     an explicit `null` clears it (as `Prisma.JsonNull` or a relation
 *     `disconnect`), and a value sets it. Collapsing absent and null would
 *     silently wipe columns the caller never mentioned.
 */
import { Prisma } from '@prisma/client';
import { makeRequestContext } from '../../helpers/make-context';
import { AutomationRuleRepository } from '@/app-layer/automation/AutomationRuleRepository';

const ctx = makeRequestContext('ADMIN', { tenantId: 't-1', userId: 'u-1' });

const db = {
    automationRule: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
};

const call = <T>(fn: jest.Mock, n = 0): T => fn.mock.calls[n][0];

beforeEach(() => {
    jest.clearAllMocks();
    db.automationRule.findMany.mockResolvedValue([]);
    db.automationRule.findFirst.mockResolvedValue(null);
    db.automationRule.create.mockResolvedValue({ id: 'r-1' });
    db.automationRule.update.mockResolvedValue({ id: 'r-1' });
    db.automationRule.updateMany.mockResolvedValue({ count: 1 });
});

describe('list', () => {
    it('scopes to the tenant, hides soft-deleted rows, and orders by priority', async () => {
        await AutomationRuleRepository.list(db as never, ctx);

        const arg = call<{ where: Record<string, unknown>; orderBy: unknown }>(
            db.automationRule.findMany,
        );
        expect(arg.where).toEqual({ tenantId: 't-1', deletedAt: null });
        expect(arg.orderBy).toEqual([{ priority: 'desc' }, { createdAt: 'desc' }]);
    });

    it('includes soft-deleted rows on request', async () => {
        await AutomationRuleRepository.list(db as never, ctx, { includeDeleted: true });
        expect(call<{ where: Record<string, unknown> }>(db.automationRule.findMany).where)
            .toEqual({ tenantId: 't-1' });
    });

    it('applies each optional filter', async () => {
        await AutomationRuleRepository.list(db as never, ctx, {
            status: 'ENABLED',
            triggerEvent: 'risk.created',
            actionType: 'WEBHOOK',
        });
        expect(call<{ where: Record<string, unknown> }>(db.automationRule.findMany).where)
            .toEqual({
                tenantId: 't-1',
                deletedAt: null,
                status: 'ENABLED',
                triggerEvent: 'risk.created',
                actionType: 'WEBHOOK',
            });
    });
});

describe('getById / findEnabledForEvent', () => {
    it('reads a single rule scoped to the tenant', async () => {
        await AutomationRuleRepository.getById(db as never, ctx, 'r-9');
        expect(call<{ where: unknown }>(db.automationRule.findFirst).where).toEqual({
            id: 'r-9',
            tenantId: 't-1',
        });
    });

    it('finds only enabled, non-deleted subscribers, highest priority first', async () => {
        await AutomationRuleRepository.findEnabledForEvent(
            db as never,
            ctx,
            'risk.created',
        );

        const arg = call<{ where: unknown; orderBy: unknown }>(db.automationRule.findMany);
        expect(arg.where).toEqual({
            tenantId: 't-1',
            triggerEvent: 'risk.created',
            status: 'ENABLED',
            deletedAt: null,
        });
        // Ties break oldest-first so rule order is stable across dispatches.
        expect(arg.orderBy).toEqual([{ priority: 'desc' }, { createdAt: 'asc' }]);
    });
});

describe('create', () => {
    beforeEach(() => {
        // `create` now verifies nextRuleId/elseRuleId belong to THIS tenant
        // before writing them. They are raw FK scalars and PostgreSQL evaluates
        // FK checks with row security bypassed, so an unvalidated cross-tenant
        // id would satisfy the constraint and persist. Default the lookup to
        // "target exists" so tests about field pass-through keep testing that.
        // Link targets are resolved with ONE findMany (a per-field findFirst
        // would be an N+1). Echo back whatever ids were asked for.
        db.automationRule.findMany.mockImplementation(async (args: any) =>
            (args?.where?.id?.in ?? []).map((id: string) => ({ id })),
        );
    });

    it('REJECTS a nextRuleId that does not resolve in this tenant', async () => {
        // The hole: `create` writes chain links as RAW FK SCALARS, and
        // PostgreSQL evaluates foreign-key checks with row security bypassed —
        // so a cross-tenant id satisfies the constraint and PERSISTS as an
        // existence oracle for another tenant's rule ids. Runtime re-scoping
        // stops it FIRING, but not the disclosure.
        db.automationRule.findMany.mockResolvedValue([]);
        await expect(
            AutomationRuleRepository.create(db as never, ctx as never, {
                name: 'R',
                triggerEvent: 'risk.created',
                actionType: 'WEBHOOK',
                actionConfig: { url: 'https://x.test' },
                nextRuleId: 'rule-in-another-tenant',
            } as never),
        ).rejects.toThrow(/nextRuleId does not reference a rule in this tenant/);
        expect(db.automationRule.create).not.toHaveBeenCalled();
    });

    it('REJECTS an elseRuleId that does not resolve in this tenant', async () => {
        db.automationRule.findMany.mockResolvedValue([]);
        await expect(
            AutomationRuleRepository.create(db as never, ctx as never, {
                name: 'R',
                triggerEvent: 'risk.created',
                actionType: 'WEBHOOK',
                actionConfig: { url: 'https://x.test' },
                elseRuleId: 'rule-in-another-tenant',
            } as never),
        ).rejects.toThrow(/elseRuleId does not reference a rule in this tenant/);
        expect(db.automationRule.create).not.toHaveBeenCalled();
    });

    const minimal = {
        name: 'R',
        triggerEvent: 'risk.created',
        actionType: 'WEBHOOK',
        actionConfig: { url: 'https://x' },
    };

    it('stamps the tenant and both user columns', async () => {
        await AutomationRuleRepository.create(db as never, ctx, minimal as never);
        const { data } = call<{ data: Record<string, unknown> }>(db.automationRule.create);
        expect(data.tenantId).toBe('t-1');
        expect(data.createdByUserId).toBe('u-1');
        expect(data.updatedByUserId).toBe('u-1');
    });

    it('defaults status, priority, and the nullable columns', async () => {
        await AutomationRuleRepository.create(db as never, ctx, minimal as never);
        const { data } = call<{ data: Record<string, unknown> }>(db.automationRule.create);
        expect(data.status).toBe('DRAFT');
        expect(data.priority).toBe(0);
        expect(data.description).toBeNull();
        expect(data.slaWindowMinutes).toBeNull();
        expect(data.slaBreachActionType).toBeNull();
        expect(data.nextRuleId).toBeNull();
        expect(data.nextRuleDelay).toBeNull();
        expect(data.elseRuleId).toBeNull();
    });

    it('uses JsonNull for absent JSON columns rather than SQL NULL', async () => {
        await AutomationRuleRepository.create(db as never, ctx, minimal as never);
        const { data } = call<{ data: Record<string, unknown> }>(db.automationRule.create);
        expect(data.triggerFilterJson).toBe(Prisma.JsonNull);
        expect(data.slaBreachConfigJson).toBe(Prisma.JsonNull);
        expect(data.scheduleConfigJson).toBe(Prisma.JsonNull);
    });

    it('passes every supplied field through', async () => {
        await AutomationRuleRepository.create(db as never, ctx, {
            ...minimal,
            description: 'desc',
            triggerFilter: { all: [] },
            status: 'ENABLED',
            priority: 5,
            slaWindowMinutes: 60,
            slaBreachActionType: 'NOTIFY_USER',
            slaBreachConfig: { userIds: ['u-2'] },
            nextRuleId: 'r-2',
            nextRuleDelay: 30,
            elseRuleId: 'r-3',
            scheduleConfig: { cron: '0 * * * *' },
        } as never);

        const { data } = call<{ data: Record<string, unknown> }>(db.automationRule.create);
        expect(data).toMatchObject({
            description: 'desc',
            triggerFilterJson: { all: [] },
            status: 'ENABLED',
            priority: 5,
            slaWindowMinutes: 60,
            slaBreachActionType: 'NOTIFY_USER',
            slaBreachConfigJson: { userIds: ['u-2'] },
            nextRuleId: 'r-2',
            nextRuleDelay: 30,
            elseRuleId: 'r-3',
            scheduleConfigJson: { cron: '0 * * * *' },
        });
    });
});

describe('update — tri-state patch', () => {
    beforeEach(() => {
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1' });
    });

    const patch = async (input: Record<string, unknown>) => {
        await AutomationRuleRepository.update(db as never, ctx, 'r-1', input as never);
        return call<{ data: Record<string, unknown> }>(db.automationRule.update).data;
    };

    it('returns null for a rule outside the tenant', async () => {
        db.automationRule.findFirst.mockResolvedValue(null);
        expect(
            await AutomationRuleRepository.update(db as never, ctx, 'r-1', {} as never),
        ).toBeNull();
        expect(db.automationRule.update).not.toHaveBeenCalled();
    });

    it('always stamps the updating user', async () => {
        expect(await patch({})).toEqual({ updatedByUserId: 'u-1' });
    });

    it('leaves absent scalar keys untouched', async () => {
        const data = await patch({ name: 'New' });
        expect(data.name).toBe('New');
        expect('description' in data).toBe(false);
        expect('priority' in data).toBe(false);
    });

    it('sets each supplied scalar, including falsy values', async () => {
        const data = await patch({
            name: 'N',
            description: null,
            triggerEvent: 'x.y',
            actionType: 'WEBHOOK',
            status: 'DISABLED',
            priority: 0,
            slaWindowMinutes: null,
            slaBreachActionType: null,
            nextRuleDelay: 0,
        });
        expect(data).toMatchObject({
            name: 'N',
            description: null,
            triggerEvent: 'x.y',
            actionType: 'WEBHOOK',
            status: 'DISABLED',
            priority: 0,
            slaWindowMinutes: null,
            slaBreachActionType: null,
            nextRuleDelay: 0,
        });
    });

    it('clears JSON columns with JsonNull and sets them otherwise', async () => {
        let data = await patch({
            triggerFilter: null,
            slaBreachConfig: null,
            scheduleConfig: null,
        });
        expect(data.triggerFilterJson).toBe(Prisma.JsonNull);
        expect(data.slaBreachConfigJson).toBe(Prisma.JsonNull);
        expect(data.scheduleConfigJson).toBe(Prisma.JsonNull);

        jest.clearAllMocks();
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1' });
        db.automationRule.update.mockResolvedValue({ id: 'r-1' });
        data = await patch({
            triggerFilter: { any: [] },
            actionConfig: { url: 'u' },
            slaBreachConfig: { userIds: [] },
            scheduleConfig: { cron: '*' },
        });
        expect(data.triggerFilterJson).toEqual({ any: [] });
        expect(data.actionConfigJson).toEqual({ url: 'u' });
        expect(data.slaBreachConfigJson).toEqual({ userIds: [] });
        expect(data.scheduleConfigJson).toEqual({ cron: '*' });
    });

    it('translates chain-rule ids into connect / disconnect', async () => {
        let data = await patch({ nextRuleId: 'r-2', elseRuleId: 'r-3' });
        expect(data.nextRule).toEqual({ connect: { id: 'r-2' } });
        expect(data.elseRule).toEqual({ connect: { id: 'r-3' } });

        jest.clearAllMocks();
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1' });
        db.automationRule.update.mockResolvedValue({ id: 'r-1' });
        data = await patch({ nextRuleId: null, elseRuleId: null });
        expect(data.nextRule).toEqual({ disconnect: true });
        expect(data.elseRule).toEqual({ disconnect: true });
    });

    it('targets the row by id once ownership is confirmed', async () => {
        await patch({ name: 'N' });
        expect(
            call<{ where: unknown }>(db.automationRule.update).where,
        ).toEqual({ id: 'r-1' });
    });
});

describe('archive', () => {
    it('returns null when the rule is missing or already archived', async () => {
        db.automationRule.findFirst.mockResolvedValue(null);
        expect(
            await AutomationRuleRepository.archive(db as never, ctx, 'r-1'),
        ).toBeNull();
        expect(db.automationRule.update).not.toHaveBeenCalled();
    });

    it('excludes already-soft-deleted rows from the ownership lookup', async () => {
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1' });
        await AutomationRuleRepository.archive(db as never, ctx, 'r-1');
        expect(call<{ where: unknown }>(db.automationRule.findFirst).where).toEqual({
            id: 'r-1',
            tenantId: 't-1',
            deletedAt: null,
        });
    });

    it('sets the archived status, the delete stamp, and the actor', async () => {
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1' });

        await AutomationRuleRepository.archive(db as never, ctx, 'r-1');

        const { data } = call<{ data: Record<string, unknown> }>(db.automationRule.update);
        expect(data.status).toBe('ARCHIVED');
        expect(data.deletedAt).toBeInstanceOf(Date);
        expect(data.updatedByUserId).toBe('u-1');
    });
});

describe('toggle', () => {
    it('flips a live rule', async () => {
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1', status: 'DISABLED' });

        await AutomationRuleRepository.toggle(db as never, ctx, 'r-1', 'ENABLED');

        expect(call<{ data: unknown }>(db.automationRule.update).data).toEqual({
            status: 'ENABLED',
            updatedByUserId: 'u-1',
        });
    });

    it('refuses to resurrect an archived rule', async () => {
        db.automationRule.findFirst.mockResolvedValue({ id: 'r-1', status: 'ARCHIVED' });
        expect(
            await AutomationRuleRepository.toggle(db as never, ctx, 'r-1', 'ENABLED'),
        ).toBeNull();
        expect(db.automationRule.update).not.toHaveBeenCalled();
    });

    it('refuses a soft-deleted rule even if its status looks live', async () => {
        db.automationRule.findFirst.mockResolvedValue({
            id: 'r-1',
            status: 'DISABLED',
            deletedAt: new Date(),
        });
        expect(
            await AutomationRuleRepository.toggle(db as never, ctx, 'r-1', 'ENABLED'),
        ).toBeNull();
    });

    it('returns null for a rule outside the tenant', async () => {
        db.automationRule.findFirst.mockResolvedValue(null);
        expect(
            await AutomationRuleRepository.toggle(db as never, ctx, 'r-1', 'DISABLED'),
        ).toBeNull();
    });
});

describe('recordFired', () => {
    it('bumps the counter and timestamp through a tenant-scoped updateMany', async () => {
        await AutomationRuleRepository.recordFired(db as never, ctx, 'r-1');

        const arg = call<{ where: unknown; data: Record<string, unknown> }>(
            db.automationRule.updateMany,
        );
        expect(arg.where).toEqual({ id: 'r-1', tenantId: 't-1' });
        expect(arg.data.executionCount).toEqual({ increment: 1 });
        expect(arg.data.lastTriggeredAt).toBeInstanceOf(Date);
        // Deliberately does NOT touch updatedByUserId — this is a dispatcher
        // counter bump, not a user-visible mutation.
        expect('updatedByUserId' in arg.data).toBe(false);
    });
});
