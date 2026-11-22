/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for `src/app-layer/usecases/automation-rules.ts`
 * (Workflow Automation Epic 1).
 *
 * Covers the RBAC gate (read vs manage), tenant-context delegation to the
 * repository, free-text sanitisation, audit emission on mutation, and the
 * notFound paths.
 */

const mockDb = { __db: true } as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/automation', () => ({
    AutomationRuleRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        archive: jest.fn(),
        toggle: jest.fn(),
    },
    assertCanReadAutomation: (ctx: any) => {
        if (!ctx.permissions.canRead) throw new Error('forbidden:read');
    },
    assertCanManageAutomation: (ctx: any) => {
        if (!ctx.permissions.canAdmin) throw new Error('forbidden:manage');
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import {
    listAutomationRules,
    getAutomationRule,
    createAutomationRule,
    updateAutomationRule,
    archiveAutomationRule,
    toggleAutomationRule,
} from '@/app-layer/usecases/automation-rules';
import { AutomationRuleRepository } from '@/app-layer/automation';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';

const repo = AutomationRuleRepository as jest.Mocked<typeof AutomationRuleRepository>;

beforeEach(() => jest.clearAllMocks());

/** A rule that has everything it needs to be enabled. */
const COMPLETE = {
    triggerEvent: 'RISK_CREATED',
    actionType: 'NOTIFY_USER',
    actionConfigJson: { userIds: ['u1'], message: 'hi' },
};

const baseInput = {
    name: 'My rule',
    triggerEvent: 'RISK_CREATED',
    actionType: 'NOTIFY_USER' as const,
    actionConfig: { userIds: ['u1'], message: 'hi' },
};

describe('automation-rules usecase — RBAC', () => {
    it('listAutomationRules rejects a caller without read', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: { canRead: false } as any,
        });
        await expect(listAutomationRules(ctx)).rejects.toThrow('forbidden:read');
        expect(repo.list).not.toHaveBeenCalled();
    });

    it('createAutomationRule rejects a non-admin (EDITOR)', async () => {
        const ctx = makeRequestContext('EDITOR');
        await expect(createAutomationRule(ctx, baseInput as any)).rejects.toThrow(
            'forbidden:manage',
        );
        expect(repo.create).not.toHaveBeenCalled();
    });
});

describe('automation-rules usecase — delegation + audit', () => {
    it('listAutomationRules delegates to the repo with filters', async () => {
        repo.list.mockResolvedValue([{ id: 'r1' }] as any);
        const ctx = makeRequestContext('ADMIN');
        const out = await listAutomationRules(ctx, { status: 'ENABLED' } as any);
        expect(repo.list).toHaveBeenCalledWith(mockDb, ctx, { status: 'ENABLED' });
        // Every rule leaves through `toPublicRule`, which says whether a
        // signing key is stored without carrying it.
        // …and what it still lacks before it can run (`rule-readiness.ts`).
        expect(out).toEqual([
            { id: 'r1', webhookSecretSet: false, readiness: ['TRIGGER_NOT_SET', 'ACTION_INCOMPLETE'] },
        ]);
    });

    it('createAutomationRule sanitises name + description and audits', async () => {
        repo.create.mockResolvedValue({
            id: 'r2',
            name: 'SAN::My rule',
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            status: 'DRAFT',
        } as any);
        const ctx = makeRequestContext('ADMIN');
        await createAutomationRule(ctx, { ...baseInput, description: 'desc' } as any);
        // name + description routed through the sanitiser
        expect(repo.create).toHaveBeenCalledWith(
            mockDb,
            ctx,
            expect.objectContaining({ name: 'SAN::My rule', description: 'SAN::desc' }),
        );
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            ctx,
            expect.objectContaining({
                action: 'AUTOMATION_RULE_CREATED',
                entityType: 'AutomationRule',
                entityId: 'r2',
            }),
        );
    });

    it('updateAutomationRule rejects a chain that loops back (cycle guard)', async () => {
        repo.getById.mockImplementation((_db: any, _ctx: any, id: string) =>
            Promise.resolve(id === 'r2' ? ({ id: 'r2', nextRuleId: 'r1' } as any) : null),
        );
        const ctx = makeRequestContext('ADMIN');
        await expect(
            updateAutomationRule(ctx, 'r1', { nextRuleId: 'r2' }),
        ).rejects.toThrow(/cycle/i);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('updateAutomationRule throws notFound when the rule is missing', async () => {
        repo.update.mockResolvedValue(null as any);
        const ctx = makeRequestContext('ADMIN');
        await expect(
            updateAutomationRule(ctx, 'missing', { priority: 5 }),
        ).rejects.toThrow(/not found/i);
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('getAutomationRule throws notFound when absent', async () => {
        repo.getById.mockResolvedValue(null as any);
        const ctx = makeRequestContext('ADMIN');
        await expect(getAutomationRule(ctx, 'nope')).rejects.toThrow(/not found/i);
    });

    it('toggleAutomationRule enables a rule and audits ENABLED', async () => {
        repo.toggle.mockResolvedValue({ ...COMPLETE, id: 'r4', name: 'Tog', status: 'ENABLED' } as any);
        const ctx = makeRequestContext('ADMIN');
        await toggleAutomationRule(ctx, 'r4', 'ENABLED');
        expect(repo.toggle).toHaveBeenCalledWith(mockDb, ctx, 'r4', 'ENABLED');
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            ctx,
            expect.objectContaining({ action: 'AUTOMATION_RULE_ENABLED', entityId: 'r4' }),
        );
    });

    it('toggleAutomationRule throws notFound when the rule is archived/missing', async () => {
        repo.toggle.mockResolvedValue(null as any);
        const ctx = makeRequestContext('ADMIN');
        await expect(toggleAutomationRule(ctx, 'gone', 'DISABLED')).rejects.toThrow(
            /not found|archived/i,
        );
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('toggleAutomationRule rejects a non-admin', async () => {
        const ctx = makeRequestContext('EDITOR');
        await expect(toggleAutomationRule(ctx, 'r4', 'ENABLED')).rejects.toThrow(
            'forbidden:manage',
        );
        expect(repo.toggle).not.toHaveBeenCalled();
    });

    it('archiveAutomationRule audits and returns the archived rule', async () => {
        repo.getById.mockResolvedValue({ id: 'r3', name: 'Old' } as any);
        repo.archive.mockResolvedValue({ id: 'r3', deletedAt: new Date() } as any);
        const ctx = makeRequestContext('ADMIN');
        await archiveAutomationRule(ctx, 'r3');
        expect(repo.archive).toHaveBeenCalledWith(mockDb, ctx, 'r3');
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            ctx,
            expect.objectContaining({ action: 'AUTOMATION_RULE_ARCHIVED', entityId: 'r3' }),
        );
    });
});

describe('every audit row this usecase writes is one logEvent accepts', () => {
    // `logEvent` validates `detailsJson` against `AuditDetailsJsonSchema`,
    // which REQUIRES `category`. None of these four sent one, so each threw
    // "Invalid detailsJson structure" against a real database, and every rule
    // create, edit, toggle and archive failed with a 400. This file mocks
    // `logEvent`, which is how it went unseen: so validate what it was handed.
    it('create, update, toggle and archive all pass the real schema', async () => {
        const { validateAuditDetailsJson } = jest.requireActual(
            '@/app-layer/schemas/json-columns.schemas',
        ) as typeof import('@/app-layer/schemas/json-columns.schemas');
        const ctx = makeRequestContext('ADMIN');
        const row = { ...COMPLETE, id: 'r9', name: 'R', status: 'DRAFT' };
        repo.create.mockResolvedValue(row as any);
        repo.getById.mockResolvedValue(row as any);
        repo.update.mockResolvedValue(row as any);
        repo.toggle.mockResolvedValue({ ...row, status: 'ENABLED' } as any);
        repo.archive.mockResolvedValue(row as any);

        await createAutomationRule(ctx, baseInput as any);
        await updateAutomationRule(ctx, 'r9', { priority: 5 } as any);
        await toggleAutomationRule(ctx, 'r9', 'ENABLED');
        await archiveAutomationRule(ctx, 'r9');

        const payloads = (logEvent as jest.Mock).mock.calls.map((c) => c[2].detailsJson);
        expect(payloads).toHaveLength(4);
        for (const details of payloads) {
            expect(() => validateAuditDetailsJson(details)).not.toThrow();
        }
    });
});

describe('a rule is enabled only when it is complete', () => {
    // A canvas step's rule starts as a stub with no trigger and an empty
    // action. Enabling it like that used to succeed.
    it('enabling a rule with no trigger and an empty action is refused, saying what is missing', async () => {
        const ctx = makeRequestContext('ADMIN');
        repo.toggle.mockResolvedValue({
            id: 'stub', name: 'Notify', status: 'ENABLED',
            triggerEvent: 'UNSET', actionType: 'NOTIFY_USER', actionConfigJson: { userIds: [], message: '' },
        } as any);
        await expect(toggleAutomationRule(ctx, 'stub', 'ENABLED')).rejects.toThrow(
            /choose the event that triggers it, and complete its action settings/,
        );
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('disabling an incomplete rule is never refused', async () => {
        const ctx = makeRequestContext('ADMIN');
        repo.toggle.mockResolvedValue({
            id: 'stub', name: 'Notify', status: 'DISABLED',
            triggerEvent: 'UNSET', actionType: 'NOTIFY_USER', actionConfigJson: {},
        } as any);
        await expect(toggleAutomationRule(ctx, 'stub', 'DISABLED')).resolves.toMatchObject({
            readiness: ['TRIGGER_NOT_SET', 'ACTION_INCOMPLETE'],
        });
    });

    it('an edit that leaves an enabled rule complete goes through', async () => {
        const ctx = makeRequestContext('ADMIN');
        repo.getById.mockResolvedValue({ ...COMPLETE, id: 'r', status: 'ENABLED' } as any);
        repo.update.mockResolvedValue({ ...COMPLETE, id: 'r', name: 'R', status: 'ENABLED', triggerEvent: 'TASK_CREATED' } as any);
        await expect(updateAutomationRule(ctx, 'r', { triggerEvent: 'TASK_CREATED' } as any)).resolves.toMatchObject({
            readiness: [],
        });
    });
});

describe('an archived rule stays archived through the edit route (#5284)', () => {
    it('refuses a PUT that would enable an archived rule, writing nothing', async () => {
        const ctx = makeRequestContext('ADMIN');
        repo.getById.mockResolvedValue({ ...COMPLETE, id: 'r', status: 'ARCHIVED' } as any);
        await expect(updateAutomationRule(ctx, 'r', { status: 'ENABLED' } as any)).rejects.toThrow(/archived/);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('a PUT that edits only the name of an archived rule is not refused', async () => {
        const ctx = makeRequestContext('ADMIN');
        repo.getById.mockResolvedValue({ ...COMPLETE, id: 'r', status: 'ARCHIVED' } as any);
        repo.update.mockResolvedValue({ ...COMPLETE, id: 'r', name: 'Renamed', status: 'ARCHIVED' } as any);
        await expect(updateAutomationRule(ctx, 'r', { name: 'Renamed' } as any)).resolves.toBeDefined();
    });
});
