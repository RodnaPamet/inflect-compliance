/**
 * An automation rule with NO AUTHOR, fired by a request made with an API key,
 * runs no wider than that key (#4386).
 *
 * The executor's principal is `rule.createdByUserId ?? event.actorUserId`.
 * For an author-less rule that is the member whose request fired the event,
 * resolved to their whole membership — so a `risks:write` CI key creating a
 * risk fired a CREATE_TASK its key could never perform, as its creator. The
 * bus now stamps the key's id on the event (`actorApiKeyId`), and the executor
 * resolves that key the way a job a key queued does
 * (`resolveKeyInitiatorContext`, #4382): the key ∧ the member, refused by name
 * when the key no longer authorises a request.
 *
 * A rule WITH an author keeps running as its author, and an event with no key
 * id runs as before — both proven here never to read a key.
 */
const prismaMock = {
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findFirst: jest.fn(), findUnique: jest.fn() },
    tenantApiKey: { findUnique: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const createTaskUsecase = jest.fn();
const setTaskStatusUsecase = jest.fn();
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: (...a: unknown[]) => createTaskUsecase(...a),
    setTaskStatus: (...a: unknown[]) => setTaskStatusUsecase(...a),
}));
const setControlStatusUsecase = jest.fn();
jest.mock('@/app-layer/usecases/control/mutations', () => ({
    setControlStatus: (...a: unknown[]) => setControlStatusUsecase(...a),
}));
jest.mock('@/app-layer/usecases/risk', () => ({ bulkSetRiskStatus: jest.fn() }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

import { executeAction } from '@/app-layer/automation/action-executor';
import type { RequestContext } from '@/app-layer/types';

/** The executor's own Prisma surface: the membership `resolveActorCtx` reads. */
const db = {
    tenantMembership: { findUnique: jest.fn() },
    task: { findFirst: jest.fn() },
};

function keyRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'key-1',
        tenantId: 'tenant-A',
        name: 'CI',
        keyPrefix: 'iflk_abcd',
        keyHash: 'h'.repeat(64),
        scopes: ['risks:write'],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdById: 'actor-1',
        agentId: null,
        maxAutonomyLevel: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        tenant: { id: 'tenant-A', slug: 'acme', deletedAt: null },
        ...overrides,
    };
}

const CREATE_TASK_RULE = {
    id: 'rule-1',
    name: 'Triage new risk',
    actionType: 'CREATE_TASK',
    actionConfigJson: { title: 'Triage' },
    createdByUserId: null as string | null,
};
const UPDATE_CONTROL_RULE = {
    id: 'rule-2',
    name: 'Mark implemented',
    actionType: 'UPDATE_STATUS',
    actionConfigJson: { entityType: 'Control', field: 'status', toStatus: 'IMPLEMENTED' },
    createdByUserId: null as string | null,
};

/** A RISK_CREATED event fired by a request made with key-1. */
const KEY_EVENT = {
    tenantId: 'tenant-A',
    event: 'RISK_CREATED',
    entityType: 'Risk',
    entityId: 'risk-1',
    actorUserId: 'actor-1',
    actorApiKeyId: 'key-1',
    data: {},
};
const SESSION_EVENT = { ...KEY_EVENT, actorApiKeyId: undefined };

const firstCtx = (m: jest.Mock): RequestContext => m.mock.calls[0][0] as RequestContext;

beforeEach(() => {
    jest.clearAllMocks();
    // The firing actor is an ADMIN, so every refusal below is the KEY's: the
    // actor alone may create tasks and edit controls.
    db.tenantMembership.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        customRole: null,
        tenant: { slug: 'acme' },
    });
    db.task.findFirst.mockResolvedValue(null);
    prismaMock.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });
    prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow());
    createTaskUsecase.mockResolvedValue({ id: 'task-1', key: 'TSK-1' });
    setControlStatusUsecase.mockResolvedValue(undefined);
});

describe('an author-less rule fired by a key runs no wider than the key', () => {
    it('refuses CREATE_TASK when the key cannot create tasks, whatever its creator may do', async () => {
        const r = await executeAction(db, CREATE_TASK_RULE, KEY_EVENT);

        expect(r.ok).toBe(false);
        expect(r.summary).toMatch(/Rule actor actor-1 \(role EDITOR\) lacks permission to create tasks/);
        expect(createTaskUsecase).not.toHaveBeenCalled();
    });

    it('hands UPDATE_STATUS the key ∧ actor context, which cannot edit controls', async () => {
        await executeAction(db, UPDATE_CONTROL_RULE, KEY_EVENT);

        // The status usecase owns the gate (and refuses there); what it is
        // handed is the narrowed authority, not the ADMIN's.
        const ctx = firstCtx(setControlStatusUsecase);
        expect(ctx.appPermissions.controls.edit).toBe(false);
        expect(ctx.permissions.canAdmin).toBe(false);
        expect(ctx.apiKeyId).toBe('key-1');
    });

    it('creates the task when the key may, as the key and its creator', async () => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(keyRow({ scopes: ['risks:write', 'tasks:write'] }));

        const r = await executeAction(db, CREATE_TASK_RULE, KEY_EVENT);

        expect(r.ok).toBe(true);
        expect(firstCtx(createTaskUsecase)).toMatchObject({
            requestId: 'automation-tenant-A',
            userId: 'actor-1',
            tenantId: 'tenant-A',
            // Kept for the assignee notification, which opens on it.
            tenantSlug: 'acme',
            role: 'EDITOR',
            apiKeyId: 'key-1',
            apiKeyScopes: ['risks:write', 'tasks:write'],
        });
        expect(prismaMock.tenantApiKey.update).not.toHaveBeenCalled();
    });
});

describe('a key that no longer authorises a request refuses the rule by name', () => {
    it.each([
        ['revoked', keyRow({ revokedAt: new Date('2026-10-01') })],
        ['expired', keyRow({ expiresAt: new Date('2020-01-01') })],
        ['not_found', null],
        ['other_tenant', keyRow({ tenantId: 'tenant-B', tenant: { id: 'tenant-B', slug: 'other', deletedAt: null } })],
        ['other_user', keyRow({ createdById: 'someone-else' })],
    ])('%s: before any write', async (reason, row) => {
        prismaMock.tenantApiKey.findUnique.mockResolvedValue(row);

        const create = await executeAction(db, CREATE_TASK_RULE, KEY_EVENT);
        const update = await executeAction(db, UPDATE_CONTROL_RULE, KEY_EVENT);

        for (const r of [create, update]) {
            expect(r).toEqual({
                ok: false,
                summary: `Rule actor actor-1 fired this event with API key key-1, which is refused (${reason}) — execution refused`,
            });
        }
        expect(createTaskUsecase).not.toHaveBeenCalled();
        expect(setControlStatusUsecase).not.toHaveBeenCalled();
        expect(db.task.findFirst).not.toHaveBeenCalled();
    });

    it('the membership refusal still comes first, with its own message', async () => {
        db.tenantMembership.findUnique.mockResolvedValue(null);

        const r = await executeAction(db, CREATE_TASK_RULE, KEY_EVENT);

        expect(r).toEqual({ ok: false, summary: 'Rule actor actor-1 is not a member of this tenant' });
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
    });
});

describe('everything else runs exactly as before', () => {
    it('a rule WITH an author runs as its author; the key that fired the event plays no part', async () => {
        const r = await executeAction(db, { ...CREATE_TASK_RULE, createdByUserId: 'author-1' }, KEY_EVENT);

        expect(r.ok).toBe(true);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(db.tenantMembership.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId_userId: { tenantId: 'tenant-A', userId: 'author-1' } } }),
        );
        const ctx = firstCtx(createTaskUsecase);
        expect(ctx).toMatchObject({ userId: 'author-1', role: 'ADMIN' });
        expect(ctx).not.toHaveProperty('apiKeyId');
    });

    it('an author-less rule fired by a session runs as the firing member, with no key read', async () => {
        const r = await executeAction(db, CREATE_TASK_RULE, SESSION_EVENT);

        expect(r.ok).toBe(true);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        const ctx = firstCtx(createTaskUsecase);
        expect(ctx).toMatchObject({ userId: 'actor-1', role: 'ADMIN', tenantSlug: 'acme' });
        expect(ctx).not.toHaveProperty('apiKeyId');
    });

    it('an event queued before the bus stamped a key id runs as the firing member', async () => {
        // The ActionEvent the dispatcher builds from a pre-#4386 payload: no
        // `actorApiKeyId` member at all.
        const { actorApiKeyId: _dropped, ...queuedBefore } = KEY_EVENT;
        void _dropped;

        const r = await executeAction(db, CREATE_TASK_RULE, queuedBefore);

        expect(r.ok).toBe(true);
        expect(prismaMock.tenantApiKey.findUnique).not.toHaveBeenCalled();
        expect(firstCtx(createTaskUsecase)).toMatchObject({ userId: 'actor-1', role: 'ADMIN' });
    });
});
