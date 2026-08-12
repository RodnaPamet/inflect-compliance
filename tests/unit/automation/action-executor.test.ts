/**
 * Coverage wave E batch 3 — `src/app-layer/automation/action-executor.ts`.
 *
 * This is where a matched rule becomes a real side effect, so the security
 * boundaries get the most attention:
 *
 *   • UPDATE_STATUS runs against an ALLOWLIST — without it a rule config
 *     could write any column to any string. Every rejection rung is pinned
 *     (unknown entity, non-canonical field, illegal value), plus the explicit
 *     per-model dispatch that keeps the model name out of attacker reach.
 *   • NOTIFY_USER filters recipients to real members of the FIRING tenant, so
 *     a stale or foreign user id can neither be notified nor dangle an FK.
 *   • WEBHOOK goes through the SSRF-guarded `safeFetch`, and a block must
 *     surface as a clean failure rather than an exception.
 *   • `executeAction` must NEVER throw — the dispatcher relies on a returned
 *     `{ ok: false }` to settle the execution row FAILED.
 */
const isNotificationsEnabled = jest.fn();
jest.mock('@/app-layer/notifications/settings', () => ({
    isNotificationsEnabled: (...a: unknown[]) => isNotificationsEnabled(...a),
}));

const safeFetch = jest.fn();
class SsrfBlockedError extends Error {}
// Must mirror EVERY export the executor references. Omitting one turns
// `err instanceof <undefined>` into a TypeError that masquerades as the
// error under test — which is exactly how the missing
// `RedirectNotAllowedError` first surfaced here.
class RedirectNotAllowedError extends Error {}
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    safeFetch: (...a: unknown[]) => safeFetch(...a),
    SsrfBlockedError,
    RedirectNotAllowedError,
}));

const enqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...a: unknown[]) => enqueue(...a),
}));

const createTaskUsecase = jest.fn();
const setTaskStatusUsecase = jest.fn();
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: (...a: unknown[]) => createTaskUsecase(...a),
    setTaskStatus: (...a: unknown[]) => setTaskStatusUsecase(...a),
}));

// UPDATE_STATUS routes each target through the usecase that owns its gates
// (B2-1b), so those usecases are the seam this suite asserts against. The
// gates themselves are proven end-to-end, against a real DB, in
// tests/integration/automation-update-status-gates.test.ts — a mock cannot
// prove a reviewer gate refused anything.
const setControlStatusUsecase = jest.fn();
jest.mock('@/app-layer/usecases/control/mutations', () => ({
    setControlStatus: (...a: unknown[]) => setControlStatusUsecase(...a),
}));
const bulkSetRiskStatusUsecase = jest.fn();
jest.mock('@/app-layer/usecases/risk', () => ({
    bulkSetRiskStatus: (...a: unknown[]) => bulkSetRiskStatusUsecase(...a),
}));

import { executeAction } from '@/app-layer/automation/action-executor';

const db = {
    tenantMembership: { findMany: jest.fn(), findUnique: jest.fn() },
    notification: { createMany: jest.fn() },
    task: { findFirst: jest.fn(), updateMany: jest.fn() },
    risk: { updateMany: jest.fn() },
    control: { updateMany: jest.fn() },
};

const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r-1',
    name: 'My rule',
    actionType: 'NOTIFY_USER',
    actionConfigJson: {},
    createdByUserId: 'author-1',
    ...over,
});

const event = (over: Record<string, unknown> = {}) => ({
    tenantId: 't-1',
    event: 'risk.created',
    entityType: 'Risk',
    entityId: 'e-1',
    data: {},
    ...over,
});

const run = (r: Record<string, unknown>, e: Record<string, unknown> = {}) =>
    executeAction(db as never, rule(r) as never, event(e) as never);

beforeEach(() => {
    jest.clearAllMocks();
    isNotificationsEnabled.mockResolvedValue(true);
    db.tenantMembership.findMany.mockResolvedValue([]);
    // Default principal: an ACTIVE ADMIN member. Every CREATE_TASK case that
    // cares about authority overrides this.
    db.tenantMembership.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        customRole: null,
        tenant: { slug: 'acme' },
    });
    db.notification.createMany.mockResolvedValue({ count: 0 });
    db.task.findFirst.mockResolvedValue(null);
    db.task.updateMany.mockResolvedValue({ count: 1 });
    db.risk.updateMany.mockResolvedValue({ count: 1 });
    db.control.updateMany.mockResolvedValue({ count: 1 });
    setTaskStatusUsecase.mockResolvedValue({ id: 'e-1' });
    setControlStatusUsecase.mockResolvedValue({ id: 'e-1' });
    bulkSetRiskStatusUsecase.mockResolvedValue({ updated: 1 });
});

describe('executeAction — dispatch', () => {
    it('rejects an unknown action type without throwing', async () => {
        const res = await run({ actionType: 'MIND_CONTROL' });
        expect(res).toEqual({ ok: false, summary: 'Unknown action type: MIND_CONTROL' });
    });

    it('converts a thrown handler error into a clean failure', async () => {
        db.tenantMembership.findMany.mockRejectedValue(new Error('db exploded'));
        const res = await run({
            actionType: 'NOTIFY_USER',
            actionConfigJson: { userIds: ['u-1'] },
        });
        expect(res.ok).toBe(false);
        expect(res.summary).toBe('Action NOTIFY_USER failed: db exploded');
    });
});

describe('NOTIFY_USER', () => {
    const notify = (cfg: Record<string, unknown>, e: Record<string, unknown> = {}) =>
        run({ actionType: 'NOTIFY_USER', actionConfigJson: cfg }, e);

    it('no-ops when no recipients are configured', async () => {
        expect(await notify({})).toEqual({
            ok: true,
            summary: 'No recipients configured',
            detail: { notified: 0 },
        });
        expect(await notify({ userIds: [] })).toMatchObject({ ok: true });
        expect(await notify({ userIds: 'not-an-array' })).toMatchObject({
            summary: 'No recipients configured',
        });
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });

    it('drops falsy ids before counting recipients', async () => {
        expect(await notify({ userIds: ['', null, undefined] })).toMatchObject({
            summary: 'No recipients configured',
        });
    });

    it('respects the tenant notification kill-switch', async () => {
        isNotificationsEnabled.mockResolvedValue(false);
        expect(await notify({ userIds: ['u-1'] })).toEqual({
            ok: true,
            summary: 'Notifications disabled for tenant',
            detail: { notified: 0 },
        });
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });

    it('filters recipients to members of the firing tenant', async () => {
        db.tenantMembership.findMany.mockResolvedValue([{ userId: 'u-1' }]);

        const res = await notify({ userIds: ['u-1', 'foreign-1'] });

        expect(db.tenantMembership.findMany).toHaveBeenCalledWith({
            where: { tenantId: 't-1', userId: { in: ['u-1', 'foreign-1'] } },
            select: { userId: true },
        });
        // Only the real member is written — a foreign id can neither be
        // notified nor dangle a foreign key.
        const rows = db.notification.createMany.mock.calls[0][0].data;
        expect(rows).toHaveLength(1);
        expect(rows[0].userId).toBe('u-1');
        expect(res).toEqual({
            ok: true,
            summary: 'Notified 1 user(s)',
            detail: { notified: 1 },
        });
    });

    it('no-ops when none of the requested ids are members', async () => {
        db.tenantMembership.findMany.mockResolvedValue([]);
    // Default principal: an ACTIVE ADMIN member. Every CREATE_TASK case that
    // cares about authority overrides this.
    db.tenantMembership.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        customRole: null,
        tenant: { slug: 'acme' },
    });
        expect(await notify({ userIds: ['ghost'] })).toEqual({
            ok: true,
            summary: 'No valid recipients',
            detail: { notified: 0 },
        });
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });

    it('uses the configured message and link, defaulting the message to the rule name', async () => {
        db.tenantMembership.findMany.mockResolvedValue([{ userId: 'u-1' }]);

        await notify({ userIds: ['u-1'], message: 'Hi', linkUrl: '/risks/1' });
        let row = db.notification.createMany.mock.calls[0][0].data[0];
        expect(row).toMatchObject({
            tenantId: 't-1',
            type: 'GENERAL',
            title: 'My rule',
            message: 'Hi',
            linkUrl: '/risks/1',
        });

        jest.clearAllMocks();
        isNotificationsEnabled.mockResolvedValue(true);
        db.tenantMembership.findMany.mockResolvedValue([{ userId: 'u-1' }]);
        await notify({ userIds: ['u-1'] });
        row = db.notification.createMany.mock.calls[0][0].data[0];
        expect(row.message).toBe('My rule');
        expect(row.linkUrl).toBeNull();
    });

    it('skips duplicates on the bulk insert', async () => {
        db.tenantMembership.findMany.mockResolvedValue([{ userId: 'u-1' }]);
        await notify({ userIds: ['u-1'] });
        expect(db.notification.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    });
});

describe('CREATE_TASK', () => {
    const create = (cfg: Record<string, unknown>, e: Record<string, unknown> = {}) =>
        run({ actionType: 'CREATE_TASK', actionConfigJson: cfg }, e);

    beforeEach(() => {
        createTaskUsecase.mockResolvedValue({ id: 'task-1', key: 'TSK-7' });
    });

    it('fails when there is no actor to own the task', async () => {
        const res = await run(
            {
                actionType: 'CREATE_TASK',
                actionConfigJson: {},
                createdByUserId: null,
            },
            { actorUserId: undefined },
        );
        expect(res).toEqual({ ok: false, summary: 'No actor to own the created task' });
    });

    it('runs as the rule AUTHOR, not the member who fired the trigger', async () => {
        // Authoring a rule requires canAdmin; the firing member may be a
        // READER. Borrowing the firing identity is the escalation this
        // ordering exists to prevent.
        await create({}, { actorUserId: 'actor-1' });
        expect(createTaskUsecase.mock.calls[0][0].userId).toBe('author-1');
        expect(db.tenantMembership.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId_userId: { tenantId: 't-1', userId: 'author-1' } },
            }),
        );
    });

    it('falls back to the firing actor only for an author-less rule', async () => {
        await run(
            { actionType: 'CREATE_TASK', actionConfigJson: {}, createdByUserId: null },
            { actorUserId: 'actor-1' },
        );
        expect(createTaskUsecase.mock.calls[0][0].userId).toBe('actor-1');
    });

    it('dedupes against an existing open automation task', async () => {
        db.task.findFirst.mockResolvedValue({ id: 'existing-1' });

        const res = await create({});

        expect(res).toEqual({
            ok: true,
            summary: 'Task already open (existing-1)',
            detail: { taskId: 'existing-1', deduped: true },
        });
        expect(createTaskUsecase).not.toHaveBeenCalled();
    });

    it('scopes the dedupe lookup to open, non-deleted tasks with the rule+entity key', async () => {
        await create({});
        const where = db.task.findFirst.mock.calls[0][0].where;
        expect(where.tenantId).toBe('t-1');
        expect(where.deletedAt).toBeNull();
        expect(where.status.notIn.length).toBeGreaterThan(0);
        expect(where.metadataJson).toEqual({
            path: ['automationDedupeKey'],
            equals: 'auto:r-1:e-1',
        });
    });

    it('uses a stable dedupe key when the event carries no entity', async () => {
        await create({}, { entityId: null });
        expect(db.task.findFirst.mock.calls[0][0].where.metadataJson.equals).toBe(
            'auto:r-1:noentity',
        );
    });

    it('routes through the canonical usecase with defaults', async () => {
        const res = await create({});

        const [, input] = createTaskUsecase.mock.calls[0];
        expect(input).toMatchObject({
            type: 'TASK',
            title: 'My rule',
            severity: 'MEDIUM',
            priority: 'P2',
            source: 'INTEGRATION',
            assigneeUserId: null,
            controlId: null,
            metadataJson: { automationDedupeKey: 'auto:r-1:e-1', ruleId: 'r-1' },
        });
        expect(res).toEqual({
            ok: true,
            summary: 'Created task TSK-7',
            detail: { taskId: 'task-1', key: 'TSK-7' },
        });
    });

    it('honours the configured task fields', async () => {
        await create({
            title: 'Custom',
            severity: 'HIGH',
            priority: 'P1',
            assigneeUserId: 'u-9',
        });
        expect(createTaskUsecase.mock.calls[0][1]).toMatchObject({
            title: 'Custom',
            severity: 'HIGH',
            priority: 'P1',
            assigneeUserId: 'u-9',
        });
    });

    it('resolves a linked control from the event payload', async () => {
        await create(
            { linkEntityType: 'Control', linkEntityIdField: 'controlId' },
            { data: { controlId: 'c-42' } },
        );
        expect(createTaskUsecase.mock.calls[0][1].controlId).toBe('c-42');
    });

    it('leaves the control null when the link is not configured for a Control', async () => {
        await create(
            { linkEntityType: 'Risk', linkEntityIdField: 'riskId' },
            { data: { riskId: 'r-9' } },
        );
        expect(createTaskUsecase.mock.calls[0][1].controlId).toBeNull();
    });

    it('leaves the control null when the payload lacks the field', async () => {
        await create(
            { linkEntityType: 'Control', linkEntityIdField: 'controlId' },
            { data: {} },
        );
        expect(createTaskUsecase.mock.calls[0][1].controlId).toBeNull();
    });

    it('executes under the principal\'s REAL role, never a fabricated ADMIN', async () => {
        db.tenantMembership.findUnique.mockResolvedValue({
            role: 'EDITOR',
            status: 'ACTIVE',
            customRole: null,
            tenant: { slug: 'acme' },
        });
        await create({});
        const ctx = createTaskUsecase.mock.calls[0][0];
        expect(ctx.tenantId).toBe('t-1');
        expect(ctx.tenantSlug).toBe('acme');
        expect(ctx.role).toBe('EDITOR');
        // EDITOR is below the canAdmin threshold — the old fabricated context
        // asserted true here.
        expect(ctx.permissions.canAdmin).toBe(false);
        expect(ctx.permissions.canWrite).toBe(true);
        expect(ctx.appPermissions.tasks.create).toBe(true);
    });

    it('refuses when the principal\'s role cannot create tasks', async () => {
        db.tenantMembership.findUnique.mockResolvedValue({
            role: 'READER',
            status: 'ACTIVE',
            customRole: null,
            tenant: { slug: 'acme' },
        });
        const res = await create({});
        expect(res.ok).toBe(false);
        expect(res.summary).toContain('lacks permission to create tasks');
        expect(res.summary).toContain('READER');
        expect(createTaskUsecase).not.toHaveBeenCalled();
        // Refused BEFORE any task read/write — no trace beyond the failure.
        expect(db.task.findFirst).not.toHaveBeenCalled();
    });

    it('refuses when a custom role withholds the granular tasks.create flag', async () => {
        db.tenantMembership.findUnique.mockResolvedValue({
            role: 'ADMIN',
            status: 'ACTIVE',
            customRole: {
                baseRole: 'ADMIN',
                permissionsJson: { tasks: { view: true, create: false, edit: true, assign: true } },
            },
            tenant: { slug: 'acme' },
        });
        const res = await create({});
        expect(res.ok).toBe(false);
        expect(res.summary).toContain('lacks permission to create tasks');
        expect(createTaskUsecase).not.toHaveBeenCalled();
    });

    it('refuses when the principal has been removed from the tenant', async () => {
        db.tenantMembership.findUnique.mockResolvedValue(null);
        const res = await create({});
        expect(res.ok).toBe(false);
        expect(res.summary).toContain('not a member of this tenant');
        expect(createTaskUsecase).not.toHaveBeenCalled();
    });

    it('refuses a non-ACTIVE membership', async () => {
        db.tenantMembership.findUnique.mockResolvedValue({
            role: 'ADMIN',
            status: 'DEACTIVATED',
            customRole: null,
            tenant: { slug: 'acme' },
        });
        const res = await create({});
        expect(res.ok).toBe(false);
        expect(res.summary).toContain('DEACTIVATED');
        expect(createTaskUsecase).not.toHaveBeenCalled();
    });
});

describe('UPDATE_STATUS — allowlist enforcement', () => {
    const update = (cfg: Record<string, unknown>, e: Record<string, unknown> = {}) =>
        run({ actionType: 'UPDATE_STATUS', actionConfigJson: cfg }, e);

    it('fails when the event carries no entity to update', async () => {
        expect(await update({ entityType: 'Risk' }, { entityId: null })).toEqual({
            ok: false,
            summary: 'Event carries no entityId to update',
        });
    });

    it('rejects an unknown entity type', async () => {
        expect(await update({ entityType: 'Employee' })).toEqual({
            ok: false,
            summary: 'Unsupported entityType: Employee',
        });
        expect(await update({})).toEqual({
            ok: false,
            summary: 'Unsupported entityType: undefined',
        });
    });

    it('rejects any field other than the canonical one', async () => {
        const res = await update({
            entityType: 'Risk',
            field: 'ownerUserId',
            toStatus: 'OPEN',
        });
        expect(res).toEqual({
            ok: false,
            summary: 'Field ownerUserId is not writable by automation',
        });
        expect(db.risk.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a value outside the allowlist', async () => {
        const res = await update({
            entityType: 'Risk',
            field: 'status',
            toStatus: 'DROP TABLE risks',
        });
        expect(res.ok).toBe(false);
        expect(res.summary).toContain('Illegal Risk status');
        expect(db.risk.updateMany).not.toHaveBeenCalled();
    });
});

describe('UPDATE_STATUS — per-usecase dispatch', () => {
    const update = (cfg: Record<string, unknown>, e: Record<string, unknown> = {}) =>
        run({ actionType: 'UPDATE_STATUS', actionConfigJson: cfg }, e);

    /** Discover a legal status for an entity so the test tracks the allowlist. */
    const legalFor = async (entityType: 'Risk' | 'Task' | 'Control') => {
        const { UPDATE_STATUS_TARGETS } = await import(
            '@/lib/automation/status-allowlist'
        );
        const spec = UPDATE_STATUS_TARGETS[entityType];
        return { field: spec.field, value: [...spec.values][0] };
    };

    /**
     * The raw-table write is the bug this handler had, not an implementation
     * detail: `db.task.updateMany({ status })` skipped the transition gate,
     * the four-eyes reviewer gate, the audit row and the source reconciler.
     * Asserting the tables stay untouched is what keeps a future "simplify"
     * from quietly restoring it.
     */
    const expectNoRawTableWrite = () => {
        expect(db.risk.updateMany).not.toHaveBeenCalled();
        expect(db.task.updateMany).not.toHaveBeenCalled();
        expect(db.control.updateMany).not.toHaveBeenCalled();
    };

    it('routes a Task through setTaskStatus, never a raw updateMany', async () => {
        const res = await update({ entityType: 'Task', field: 'status', toStatus: 'IN_PROGRESS' });

        expect(res.ok).toBe(true);
        const [ctx, taskId, status, resolution] = setTaskStatusUsecase.mock.calls[0];
        expect(ctx).toMatchObject({ tenantId: 't-1', userId: 'author-1', role: 'ADMIN' });
        expect(taskId).toBe('e-1');
        expect(status).toBe('IN_PROGRESS');
        // Non-terminal: no synthesised resolution, so a mid-flight move does
        // not stamp a "why" onto a task that has not finished.
        expect(resolution).toBeNull();
        expectNoRawTableWrite();
    });

    it('synthesises a resolution naming the rule on a terminal Task close', async () => {
        const res = await update({ entityType: 'Task', field: 'status', toStatus: 'CLOSED' });

        expect(res.ok).toBe(true);
        const resolution = setTaskStatusUsecase.mock.calls[0][3];
        // `setTaskStatus` refuses a terminal move with an empty resolution and
        // UpdateStatusActionConfig has no field for one, so the rule names
        // itself rather than the executor inventing a blank.
        expect(resolution).toContain('My rule');
        expect(resolution).toContain('r-1');
        expect(resolution).toContain('CLOSED');
    });

    it('routes a Control through setControlStatus', async () => {
        const { field, value } = await legalFor('Control');
        const res = await update({ entityType: 'Control', field, toStatus: value });

        expect(res.ok).toBe(true);
        expect(setControlStatusUsecase).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 't-1', userId: 'author-1' }),
            'e-1',
            value,
        );
        expectNoRawTableWrite();
    });

    it('routes a Risk through bulkSetRiskStatus', async () => {
        const { field, value } = await legalFor('Risk');
        const res = await update({ entityType: 'Risk', field, toStatus: value });

        expect(res.ok).toBe(true);
        expect(bulkSetRiskStatusUsecase).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 't-1', userId: 'author-1' }),
            ['e-1'],
            value,
        );
        expectNoRawTableWrite();
    });

    it('reports a miss when nothing matched, without claiming success', async () => {
        const { field, value } = await legalFor('Risk');
        bulkSetRiskStatusUsecase.mockResolvedValue({ updated: 0 });

        const res = await update({ entityType: 'Risk', field, toStatus: value });

        expect(res.ok).toBe(false);
        expect(res.summary).toBe('No Risk matched e-1');
    });

    it('settles FAILED with the gate\'s own reason when a usecase refuses', async () => {
        const { ForbiddenError } = await import('@/lib/errors/types');
        setTaskStatusUsecase.mockRejectedValue(
            new ForbiddenError('Only the assigned reviewer can sign off and complete this task.'),
        );

        const res = await update({ entityType: 'Task', field: 'status', toStatus: 'CLOSED' });

        expect(res.ok).toBe(false);
        // The operator reading errorMessage must learn WHICH gate refused.
        expect(res.summary).toContain('Only the assigned reviewer can sign off');
        expect(res.summary).toContain('author-1');
        expect(res.summary).toContain('ADMIN');
        expectNoRawTableWrite();
    });

    it('refuses an actor whose membership is not ACTIVE, before any write', async () => {
        db.tenantMembership.findUnique.mockResolvedValue({
            role: 'ADMIN',
            status: 'REMOVED',
            customRole: null,
            tenant: { slug: 'acme' },
        });

        const res = await update({ entityType: 'Task', field: 'status', toStatus: 'CLOSED' });

        expect(res.ok).toBe(false);
        expect(res.summary).toContain('REMOVED');
        expect(setTaskStatusUsecase).not.toHaveBeenCalled();
        expectNoRawTableWrite();
    });

    it.each([
        ['Task', 'TASK_STATUS_CHANGED'],
        ['Risk', 'RISK_STATUS_CHANGED'],
        ['Control', 'CONTROL_STATUS_CHANGED'],
    ] as const)(
        'refuses a %s UPDATE_STATUS driven by %s — the rule would re-trigger itself',
        async (entityType, triggerEvent) => {
            const { field, value } = await legalFor(entityType);

            const res = await update(
                { entityType, field, toStatus: value },
                { event: triggerEvent },
            );

            expect(res.ok).toBe(false);
            expect(res.summary).toContain('re-trigger itself');
            // Refused BEFORE the actor lookup, so nothing at all was touched.
            expect(db.tenantMembership.findUnique).not.toHaveBeenCalled();
            expect(setTaskStatusUsecase).not.toHaveBeenCalled();
            expect(setControlStatusUsecase).not.toHaveBeenCalled();
            expect(bulkSetRiskStatusUsecase).not.toHaveBeenCalled();
            expectNoRawTableWrite();
        },
    );
});

describe('WEBHOOK', () => {
    const fire = (cfg: Record<string, unknown>) =>
        run({ actionType: 'WEBHOOK', actionConfigJson: cfg }, {});

    beforeEach(() => {
        safeFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    // P1.9 — caller headers used to be spread AFTER the defaults, so a rule
    // could override the platform's own headers. The sharp case is
    // X-Inflect-Signature: a rule author is not necessarily the person who owns
    // the destination, so forging the authenticity header let one rule make its
    // payload look signed by the platform.
    // The WEBHOOK HMAC key moved out of plaintext actionConfigJson.secretRef
    // into the encrypted AutomationRule.webhookSecretEncrypted column. The
    // legacy field is read only as a fallback until the backfill sweep runs.
    it('prefers the encrypted column over the legacy plaintext secretRef', async () => {
        await run(
            {
                actionType: 'WEBHOOK',
                actionConfigJson: { url: 'https://hooks.example.com/x', secretRef: 'legacy-plaintext' },
                webhookSecretEncrypted: 'from-encrypted-column',
            },
            {},
        );
        const init = safeFetch.mock.calls[0][1];
        const sig = init.headers['X-Inflect-Signature'];
        expect(sig).toMatch(/^sha256=/);
        // Signed with the column value, not the legacy one — recompute both and
        // assert which matched, rather than trusting the presence of a header.
        const { createHmac } = await import('node:crypto');
        const body = init.body as string;
        const withColumn = `sha256=${createHmac('sha256', 'from-encrypted-column').update(body).digest('hex')}`;
        const withLegacy = `sha256=${createHmac('sha256', 'legacy-plaintext').update(body).digest('hex')}`;
        expect(sig).toBe(withColumn);
        expect(sig).not.toBe(withLegacy);
    });

    it('falls back to the legacy secretRef while the backfill has not run', async () => {
        await run(
            {
                actionType: 'WEBHOOK',
                actionConfigJson: { url: 'https://hooks.example.com/x', secretRef: 'legacy-plaintext' },
            },
            {},
        );
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers['X-Inflect-Signature']).toMatch(/^sha256=/);
    });

    it('sends no signature when neither is configured', async () => {
        await fire({ url: 'https://hooks.example.com/x' });
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers['X-Inflect-Signature']).toBeUndefined();
    });

    it('does not let rule config override Content-Type or User-Agent', async () => {
        await fire({
            url: 'https://hooks.example.com/x',
            headers: { 'Content-Type': 'text/plain', 'User-Agent': 'evil/1' },
        });
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.headers['User-Agent']).toBe('Inflect-Automation/1');
    });

    it('strips an injected X-Inflect-Signature when no secretRef is configured', async () => {
        await fire({
            url: 'https://hooks.example.com/x',
            headers: { 'X-Inflect-Signature': 'sha256=forged' },
        });
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers['X-Inflect-Signature']).toBeUndefined();
    });

    it('strips an injected Authorization header', async () => {
        await fire({
            url: 'https://hooks.example.com/x',
            headers: { Authorization: 'Bearer stolen' },
        });
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers.Authorization).toBeUndefined();
    });

    it('still forwards a non-reserved custom header', async () => {
        // The fix must not turn into "no custom headers at all" — that would be
        // a functional regression for legitimate integrations.
        await fire({
            url: 'https://hooks.example.com/x',
            headers: { 'X-Custom-Route': 'team-a' },
        });
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers['X-Custom-Route']).toBe('team-a');
    });

    it('case-insensitively rejects a reserved header', async () => {
        await fire({
            url: 'https://hooks.example.com/x',
            headers: { 'x-inflect-signature': 'sha256=forged', 'content-type': 'text/plain' },
        });
        const init = safeFetch.mock.calls[0][1];
        expect(init.headers['x-inflect-signature']).toBeUndefined();
        expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('fails when no URL is configured', async () => {
        expect(await fire({})).toEqual({
            ok: false,
            summary: 'No webhook URL configured',
        });
        expect(safeFetch).not.toHaveBeenCalled();
    });

    it('POSTs the rule + event envelope through the SSRF-guarded fetch', async () => {
        const res = await fire({ url: 'https://hooks.example.com/x' });

        const [url, init] = safeFetch.mock.calls[0];
        expect(url).toBe('https://hooks.example.com/x');
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.headers['User-Agent']).toBe('Inflect-Automation/1');
        expect(init.signal).toBeDefined();
        const body = JSON.parse(init.body);
        expect(body.rule).toEqual({ id: 'r-1', name: 'My rule' });
        expect(body.event).toEqual({
            name: 'risk.created',
            entityType: 'Risk',
            entityId: 'e-1',
        });
        expect(res).toEqual({
            ok: true,
            summary: 'Webhook https://hooks.example.com/x → 200',
            detail: { status: 200 },
        });
    });

    it('honours a method override and merges custom headers', async () => {
        await fire({
            url: 'https://hooks.example.com/x',
            method: 'PUT',
            headers: { 'X-Custom': 'v' },
        });
        const init = safeFetch.mock.calls[0][1];
        expect(init.method).toBe('PUT');
        expect(init.headers['X-Custom']).toBe('v');
        expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('signs the body with HMAC-SHA256 when a secret is configured', async () => {
        const { createHmac } = await import('node:crypto');
        await fire({ url: 'https://hooks.example.com/x', secretRef: 'shh' });

        const init = safeFetch.mock.calls[0][1];
        const expected = createHmac('sha256', 'shh').update(init.body).digest('hex');
        expect(init.headers['X-Inflect-Signature']).toBe(`sha256=${expected}`);
    });

    it('omits the signature header when no secret is configured', async () => {
        await fire({ url: 'https://hooks.example.com/x' });
        expect(
            safeFetch.mock.calls[0][1].headers['X-Inflect-Signature'],
        ).toBeUndefined();
    });

    it('reports a non-2xx response as a failure carrying the status', async () => {
        safeFetch.mockResolvedValue({ ok: false, status: 500 });
        const res = await fire({ url: 'https://hooks.example.com/x' });
        expect(res.ok).toBe(false);
        expect(res.detail).toEqual({ status: 500 });
    });

    it('turns an SSRF block into a clean failure, not an exception', async () => {
        safeFetch.mockRejectedValue(new SsrfBlockedError('private address'));
        const res = await fire({ url: 'http://169.254.169.254/latest/meta-data' });
        expect(res).toEqual({
            ok: false,
            summary: 'Webhook blocked: private address',
        });
    });

    it('turns a refused redirect into a clean failure, not an exception', async () => {
        // safeFetch now refuses 3xx rather than following it. That must settle
        // the execution row as a normal FAILED outcome — if it escaped as an
        // unhandled throw, one misconfigured endpoint would break the
        // dispatcher rather than just its own rule.
        safeFetch.mockRejectedValue(
            new RedirectNotAllowedError('Refusing to follow a 302 redirect to http://169.254.169.254/'),
        );
        const res = await fire({ url: 'https://hooks.example.com/x' });
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/redirect refused/i);
    });

    it('lets a non-SSRF error bubble to the executeAction catch', async () => {
        safeFetch.mockRejectedValue(new Error('socket hang up'));
        const res = await fire({ url: 'https://hooks.example.com/x' });
        // Rethrown by fireWebhook, caught by executeAction → clean failure.
        expect(res.ok).toBe(false);
        expect(res.summary).toBe('Action WEBHOOK failed: socket hang up');
    });
});

describe('INVOKE_SUBFLOW', () => {
    const invoke = (cfg: Record<string, unknown>, e: Record<string, unknown> = {}) =>
        run({ actionType: 'INVOKE_SUBFLOW', actionConfigJson: cfg }, e);

    // The recursion cap in subflow-dispatcher is only meaningful if the depth
    // actually advances per hop — a cap the caller never increments is
    // decorative. `__subflowDepth` rides event.data, stamped by the dispatcher.
    it('carries depth forward so the recursion cap can bite', async () => {
        await invoke(
            { targetGroupId: 'g-1' },
            { data: { __parentExecutionId: 'exec-9', __subflowDepth: 4 } },
        );
        expect(enqueue).toHaveBeenCalledWith(
            'subflow-dispatch',
            expect.objectContaining({ depth: 5 }),
        );
    });

    it('treats a non-numeric depth marker as the first hop', async () => {
        await invoke(
            { targetGroupId: 'g-1' },
            { data: { __subflowDepth: 'not-a-number' } },
        );
        expect(enqueue).toHaveBeenCalledWith(
            'subflow-dispatch',
            expect.objectContaining({ depth: 1 }),
        );
    });

    it('fails when no target is configured', async () => {
        expect(await invoke({})).toEqual({
            ok: false,
            summary: 'No sub-flow target configured',
        });
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('enqueues the sub-flow dispatch with the trigger context', async () => {
        const res = await invoke(
            { targetGroupId: 'g-1' },
            { data: { __parentExecutionId: 'exec-9', foo: 'bar' } },
        );

        expect(enqueue).toHaveBeenCalledWith('subflow-dispatch', {
            tenantId: 't-1',
            targetGroupId: 'g-1',
            parentExecutionId: 'exec-9',
            triggerEvent: 'risk.created',
            data: { __parentExecutionId: 'exec-9', foo: 'bar' },
            // First hop — no `__subflowDepth` on the event, so depth starts at 1.
            depth: 1,
        });
        expect(res).toEqual({ ok: true, summary: 'Enqueued sub-flow g-1' });
    });

    it('defaults the parent execution id when the event carries none', async () => {
        await invoke({ targetGroupId: 'g-1' }, { data: {} });
        expect(enqueue.mock.calls[0][1].parentExecutionId).toBe('');
    });
});
