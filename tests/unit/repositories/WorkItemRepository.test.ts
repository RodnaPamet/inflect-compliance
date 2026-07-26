/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-B coverage — WorkItemRepository (Task / TaskLink / TaskComment /
 * TaskWatcher repos), previously ~41% branches.
 *
 * Every method takes a `db: PrismaTx` directly (no runInTenantContext, no
 * audit emitter), so the test mocks a fake `db` with jest.fn() model
 * methods and asserts on the `where` / `orderBy` / `take` shape passed
 * to Prisma. The bulk of the uncovered branches live in `_buildWhere`
 * (each optional filter is its own branch) and in the terminal-status /
 * not-found guards on update / setStatus / assign / unlink / remove.
 */

import { WorkItemRepository, TaskLinkRepository, TaskCommentRepository, TaskWatcherRepository, normalizeWorkItemSource } from '@/app-layer/repositories/WorkItemRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

describe('normalizeWorkItemSource — source validation at the write boundary', () => {
    it('defaults a missing/empty source to MANUAL', () => {
        expect(normalizeWorkItemSource(undefined)).toBe('MANUAL');
        expect(normalizeWorkItemSource(null)).toBe('MANUAL');
        expect(normalizeWorkItemSource('')).toBe('MANUAL');
    });

    it('passes valid enum members through', () => {
        for (const s of ['MANUAL', 'INTEGRATION', 'POLICY_REVIEW', 'EVIDENCE_EXPIRY', 'AUDIT', 'RISK_MONITOR']) {
            expect(normalizeWorkItemSource(s)).toBe(s);
        }
    });

    it('throws LOUDLY on an invalid source (never a silent blind cast)', () => {
        // The exact bugs this guards: KRI-breach + risk-appetite passed
        // these free strings, which are not enum members.
        expect(() => normalizeWorkItemSource('kri_breach')).toThrow(/Invalid task source/);
        expect(() => normalizeWorkItemSource('risk_appetite_breach')).toThrow(/Invalid task source/);
        expect(() => normalizeWorkItemSource('bogus')).toThrow(/Invalid task source/);
    });
});

// A fresh fake `db` per test — every model method is a jest.fn() so we
// can inspect call args and stub resolved values per branch.
function freshDb() {
    return {
        task: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue({ id: 't1' }),
            update: jest.fn().mockResolvedValue({ id: 't1' }),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        taskKeySequence: {
            upsert: jest.fn().mockResolvedValue({ lastValue: 7 }),
        },
        taskLink: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'l1' }),
            delete: jest.fn().mockResolvedValue({}),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        taskComment: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 'c1' }),
        },
        taskWatcher: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'w1' }),
            delete: jest.fn().mockResolvedValue({}),
        },
        control: {
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

let db: ReturnType<typeof freshDb>;

beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
});

describe('WorkItemRepository.list + _buildWhere filter branches', () => {
    it('no filters: base where is tenant-only, no AND, no take', async () => {
        await WorkItemRepository.list(db as any, ctx);
        const arg = db.task.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ tenantId: ctx.tenantId });
        expect(arg.where.AND).toBeUndefined();
        expect(arg.orderBy).toEqual([{ priority: 'asc' }, { createdAt: 'desc' }]);
        expect('take' in arg).toBe(false);
    });

    it('options.take is forwarded when provided', async () => {
        await WorkItemRepository.list(db as any, ctx, {}, { take: 25 });
        expect(db.task.findMany.mock.calls[0][0].take).toBe(25);
    });

    it('scalar filters (status/type/severity/priority/assignee/control) each map onto where', async () => {
        await WorkItemRepository.list(db as any, ctx, {
            status: 'OPEN',
            type: 'TASK',
            severity: 'HIGH',
            priority: 'P1',
            assigneeUserId: 'u9',
            controlId: 'ctrl9',
        });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.status).toBe('OPEN');
        expect(where.type).toBe('TASK');
        expect(where.severity).toBe('HIGH');
        expect(where.priority).toBe('P1');
        expect(where.assigneeUserId).toBe('u9');
        expect(where.controlId).toBe('ctrl9');
    });

    it('comma-joined multi-select facets become { in: [...] }', async () => {
        // The UI declares status/type/severity/source/assignee as
        // `multiple: true`, and the shared filter helper comma-joins them.
        // Previously the raw string was cast onto a Prisma enum scalar, so
        // two selected values matched nothing.
        await WorkItemRepository.list(db as any, ctx, {
            status: 'OPEN,BLOCKED',
            type: 'TASK,INCIDENT',
            severity: 'HIGH,CRITICAL',
            source: 'MANUAL,AUDIT',
            assigneeUserId: 'u1,u2',
        });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.status).toEqual({ in: ['OPEN', 'BLOCKED'] });
        expect(where.type).toEqual({ in: ['TASK', 'INCIDENT'] });
        expect(where.severity).toEqual({ in: ['HIGH', 'CRITICAL'] });
        expect(where.source).toEqual({ in: ['MANUAL', 'AUDIT'] });
        expect(where.assigneeUserId).toEqual({ in: ['u1', 'u2'] });
    });

    it('a single value still maps to a bare equality, not { in: [one] }', async () => {
        await WorkItemRepository.list(db as any, ctx, { status: 'OPEN' });
        expect(db.task.findMany.mock.calls[0][0].where.status).toBe('OPEN');
    });

    it('tolerates whitespace, blanks and duplicates in the joined value', async () => {
        await WorkItemRepository.list(db as any, ctx, { status: ' OPEN , ,BLOCKED, OPEN ' });
        expect(db.task.findMany.mock.calls[0][0].where.status).toEqual({
            in: ['OPEN', 'BLOCKED'],
        });
    });

    it('rejects an invalid enum member loudly rather than matching zero rows', async () => {
        await expect(
            WorkItemRepository.list(db as any, ctx, { status: 'OPEN,NOT_A_STATUS' }),
        ).rejects.toThrow(/Invalid status/i);
    });

    it('due=overdue without status: sets dueAt lt + status notIn terminal', async () => {
        await WorkItemRepository.list(db as any, ctx, { due: 'overdue' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.dueAt.lt).toBeInstanceOf(Date);
        expect(where.status).toEqual({ notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] });
    });

    it('due=overdue WITH explicit status: keeps the explicit status (no notIn override)', async () => {
        await WorkItemRepository.list(db as any, ctx, { due: 'overdue', status: 'OPEN' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.status).toBe('OPEN');
        expect(where.dueAt.lt).toBeInstanceOf(Date);
    });

    it('due=next7d without status: gte/lte window + status notIn terminal', async () => {
        await WorkItemRepository.list(db as any, ctx, { due: 'next7d' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.dueAt.gte).toBeInstanceOf(Date);
        expect(where.dueAt.lte).toBeInstanceOf(Date);
        expect(where.status).toEqual({ notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] });
    });

    it('due=next7d WITH explicit status: keeps explicit status', async () => {
        await WorkItemRepository.list(db as any, ctx, { due: 'next7d', status: 'IN_PROGRESS' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.status).toBe('IN_PROGRESS');
        expect(where.dueAt.gte).toBeInstanceOf(Date);
    });

    it('q filter pushes a title/key OR into AND', async () => {
        await WorkItemRepository.list(db as any, ctx, { q: 'foo' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND).toHaveLength(1);
        expect(where.AND[0].OR).toEqual([
            { title: { contains: 'foo', mode: 'insensitive' } },
            { key: { contains: 'foo', mode: 'insensitive' } },
        ]);
    });

    it('linkedEntity (non-CONTROL) pushes a single viaLink some clause', async () => {
        await WorkItemRepository.list(db as any, ctx, { linkedEntityType: 'ASSET', linkedEntityId: 'a1' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND).toHaveLength(1);
        expect(where.AND[0].links.some).toEqual({ entityType: 'ASSET', entityId: 'a1' });
        expect(where.AND[0].OR).toBeUndefined();
    });

    it('linkedEntity CONTROL pushes an OR of viaLink + direct controlId FK', async () => {
        await WorkItemRepository.list(db as any, ctx, { linkedEntityType: 'CONTROL', linkedEntityId: 'c1' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND[0].OR).toHaveLength(2);
        expect(where.AND[0].OR[1]).toEqual({ controlId: 'c1' });
    });

    it('linkedEntityType WITHOUT linkedEntityId does not add the link clause', async () => {
        await WorkItemRepository.list(db as any, ctx, { linkedEntityType: 'ASSET' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND).toBeUndefined();
    });

    it('combined q + linkedEntity yields a two-element AND', async () => {
        await WorkItemRepository.list(db as any, ctx, { q: 'x', linkedEntityType: 'RISK', linkedEntityId: 'r1' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND).toHaveLength(2);
    });
});

describe('WorkItemRepository.countLinkedToControl', () => {
    it('issues two counts (total + done) and returns the pair', async () => {
        db.task.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
        const r = await WorkItemRepository.countLinkedToControl(db as any, ctx, 'c1');
        expect(r).toEqual({ total: 5, done: 2 });
        // The done count narrows by RESOLVED/CLOSED inside an AND with the base where.
        const doneArg = db.task.count.mock.calls[1][0];
        expect(doneArg.where.AND[1]).toEqual({ status: { in: ['RESOLVED', 'CLOSED'] } });
    });
});

describe('WorkItemRepository.countLinkedToControls', () => {
    it('empty controlIds short-circuits to empty map', async () => {
        const r = await WorkItemRepository.countLinkedToControls(db as any, ctx, []);
        expect(r.size).toBe(0);
        expect(db.task.findMany).not.toHaveBeenCalled();
    });

    it('dedupes a task linked via both FK and TaskLink, counts done by RESOLVED/CLOSED', async () => {
        // Direct FK path: t1 (RESOLVED, counts done), t2 (OPEN), and a row with
        // null controlId that must be skipped.
        db.task.findMany.mockResolvedValueOnce([
            { id: 't1', controlId: 'c1', status: 'RESOLVED' },
            { id: 't2', controlId: 'c1', status: 'OPEN' },
            { id: 't3', controlId: null, status: 'CLOSED' },
        ]);
        // TaskLink path: t1 again (dedup) + t4 (CLOSED, counts done) on c2.
        db.taskLink.findMany.mockResolvedValueOnce([
            { entityId: 'c1', taskId: 't1', task: { status: 'RESOLVED' } },
            { entityId: 'c2', taskId: 't4', task: { status: 'CLOSED' } },
        ]);
        const r = await WorkItemRepository.countLinkedToControls(db as any, ctx, ['c1', 'c2']);
        expect(r.get('c1')).toEqual({ total: 2, done: 1 }); // t1 (done) + t2 (open), t1 deduped
        expect(r.get('c2')).toEqual({ total: 1, done: 1 });
    });
});

describe('WorkItemRepository.countLinkedToEntities', () => {
    it('empty entityIds short-circuits to empty map', async () => {
        const r = await WorkItemRepository.countLinkedToEntities(db as any, ctx, 'ASSET' as any, []);
        expect(r.size).toBe(0);
        expect(db.taskLink.findMany).not.toHaveBeenCalled();
    });

    it('groups links per entity, dedupes by task id, counts done', async () => {
        db.taskLink.findMany.mockResolvedValueOnce([
            { entityId: 'a1', taskId: 't1', task: { status: 'CLOSED' } },
            { entityId: 'a1', taskId: 't1', task: { status: 'CLOSED' } }, // dedup
            { entityId: 'a1', taskId: 't2', task: { status: 'OPEN' } },
            { entityId: 'a2', taskId: 't3', task: { status: 'RESOLVED' } },
        ]);
        const r = await WorkItemRepository.countLinkedToEntities(db as any, ctx, 'ASSET' as any, ['a1', 'a2']);
        expect(r.get('a1')).toEqual({ total: 2, done: 1 });
        expect(r.get('a2')).toEqual({ total: 1, done: 1 });
    });
});

describe('WorkItemRepository.listPaginated', () => {
    it('without cursor: take is limit+1, no AND injected', async () => {
        db.task.findMany.mockResolvedValueOnce([]);
        const res = await WorkItemRepository.listPaginated(db as any, ctx, { limit: 10 });
        const arg = db.task.findMany.mock.calls[0][0];
        expect(arg.take).toBe(11);
        expect(arg.where.AND).toBeUndefined();
        expect(res.pageInfo.hasNextPage).toBe(false);
    });

    it('with cursor + filters (existing AND): pushes cursorWhere into the AND array', async () => {
        // q filter forces a pre-existing where.AND, exercising the push branch.
        const cursor = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: 'z' })).toString('base64url');
        await WorkItemRepository.listPaginated(db as any, ctx, { cursor, filters: { q: 'hi' } });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND.length).toBe(2); // q clause + cursorWhere
    });

    it('with cursor + no filters: creates the AND array from the cursorWhere', async () => {
        const cursor = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: 'z' })).toString('base64url');
        await WorkItemRepository.listPaginated(db as any, ctx, { cursor });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND.length).toBe(1);
    });

    it('invalid cursor: buildCursorWhere returns null, no AND injected', async () => {
        await WorkItemRepository.listPaginated(db as any, ctx, { cursor: 'not-valid-base64-cursor' });
        const where = db.task.findMany.mock.calls[0][0].where;
        expect(where.AND).toBeUndefined();
    });

    it('hasNextPage true when an extra row is returned beyond the limit', async () => {
        const rows = Array.from({ length: 3 }, (_, i) => ({ id: `id${i}`, createdAt: new Date() }));
        db.task.findMany.mockResolvedValueOnce(rows);
        const res = await WorkItemRepository.listPaginated(db as any, ctx, { limit: 2 });
        expect(res.pageInfo.hasNextPage).toBe(true);
        expect(res.items).toHaveLength(2);
        expect(res.pageInfo.nextCursor).toBeTruthy();
    });
});

describe('WorkItemRepository.getById', () => {
    it('queries findFirst scoped to id + tenant', async () => {
        await WorkItemRepository.getById(db as any, ctx, 'task9');
        expect(db.task.findFirst.mock.calls[0][0].where).toEqual({ id: 'task9', tenantId: ctx.tenantId });
    });
});

describe('WorkItemRepository.create', () => {
    it('mints key from sequence and applies all defaults when fields omitted', async () => {
        db.taskKeySequence.upsert.mockResolvedValueOnce({ lastValue: 42 });
        await WorkItemRepository.create(db as any, ctx, { title: 'T' });
        const data = db.task.create.mock.calls[0][0].data;
        expect(data.key).toBe('TSK-42');
        expect(data.description).toBeNull();
        expect(data.type).toBe('TASK');
        expect(data.severity).toBe('MEDIUM');
        expect(data.priority).toBe('P2');
        expect(data.source).toBe('MANUAL');
        expect(data.dueAt).toBeNull();
        expect(data.assigneeUserId).toBeNull();
        expect(data.reviewerUserId).toBeNull();
        expect(data.controlId).toBeNull();
        expect(data.createdByUserId).toBe(ctx.userId);
        // metadataJson omitted → JsonNull sentinel (not undefined)
        expect(data.metadataJson).toBeDefined();
    });

    it('applies provided overrides incl. dueAt parsing and explicit metadataJson', async () => {
        await WorkItemRepository.create(db as any, ctx, {
            title: 'T',
            type: 'BUG',
            description: 'desc',
            severity: 'HIGH',
            priority: 'P0',
            source: 'INTEGRATION',
            dueAt: '2026-01-01T00:00:00.000Z',
            assigneeUserId: 'a1',
            reviewerUserId: 'r1',
            controlId: 'c1',
            metadataJson: { k: 'v' },
        });
        const data = db.task.create.mock.calls[0][0].data;
        expect(data.type).toBe('BUG');
        expect(data.source).toBe('INTEGRATION');
        expect(data.description).toBe('desc');
        expect(data.dueAt).toBeInstanceOf(Date);
        expect(data.assigneeUserId).toBe('a1');
        expect(data.metadataJson).toEqual({ k: 'v' });
    });
});

describe('WorkItemRepository.update', () => {
    it('returns null when the task is not found (tenant guard)', async () => {
        db.task.findFirst.mockResolvedValueOnce(null);
        const r = await WorkItemRepository.update(db as any, ctx, 'x', { title: 'new' });
        expect(r).toBeNull();
        expect(db.task.update).not.toHaveBeenCalled();
    });

    it('builds a sparse update object — only provided fields appear', async () => {
        db.task.findFirst.mockResolvedValueOnce({ id: 'x' });
        await WorkItemRepository.update(db as any, ctx, 'x', { title: 'new', controlId: null });
        const data = db.task.update.mock.calls[0][0].data;
        expect(data.title).toBe('new');
        expect(data.controlId).toBeNull();
        expect('severity' in data).toBe(false);
    });

    it('applies every optional field incl. dueAt parse + metadataJson + null dueAt', async () => {
        db.task.findFirst.mockResolvedValue({ id: 'x' });
        await WorkItemRepository.update(db as any, ctx, 'x', {
            title: 't', description: 'd', type: 'TASK', severity: 'LOW',
            priority: 'P3', dueAt: '2026-02-02T00:00:00.000Z', reviewerUserId: 'r1',
            metadataJson: { a: 1 },
        });
        let data = db.task.update.mock.calls[0][0].data;
        expect(data.dueAt).toBeInstanceOf(Date);
        expect(data.metadataJson).toEqual({ a: 1 });
        expect(data.severity).toBe('LOW');

        // dueAt null branch + metadataJson null branch → JsonNull sentinel.
        await WorkItemRepository.update(db as any, ctx, 'x', { dueAt: null, metadataJson: null });
        data = db.task.update.mock.calls[1][0].data;
        expect(data.dueAt).toBeNull();
        expect(data.metadataJson).toBeDefined();
    });
});

describe('WorkItemRepository.setStatus', () => {
    it('returns null on not-found', async () => {
        db.task.findFirst.mockResolvedValueOnce(null);
        expect(await WorkItemRepository.setStatus(db as any, ctx, 'x', 'OPEN')).toBeNull();
    });

    it('terminal status sets completedAt; resolution applied when provided', async () => {
        db.task.findFirst.mockResolvedValueOnce({ id: 'x' });
        await WorkItemRepository.setStatus(db as any, ctx, 'x', 'RESOLVED', 'fixed');
        const data = db.task.update.mock.calls[0][0].data;
        expect(data.status).toBe('RESOLVED');
        expect(data.completedAt).toBeInstanceOf(Date);
        expect(data.resolution).toBe('fixed');
    });

    it('terminal status WITHOUT resolution leaves resolution unset', async () => {
        db.task.findFirst.mockResolvedValueOnce({ id: 'x' });
        await WorkItemRepository.setStatus(db as any, ctx, 'x', 'CLOSED');
        const data = db.task.update.mock.calls[0][0].data;
        expect(data.completedAt).toBeInstanceOf(Date);
        expect('resolution' in data).toBe(false);
    });

    it('non-terminal status clears completedAt', async () => {
        db.task.findFirst.mockResolvedValueOnce({ id: 'x' });
        await WorkItemRepository.setStatus(db as any, ctx, 'x', 'IN_PROGRESS');
        const data = db.task.update.mock.calls[0][0].data;
        expect(data.completedAt).toBeNull();
    });
});

describe('WorkItemRepository.assign', () => {
    it('returns null on not-found', async () => {
        db.task.findFirst.mockResolvedValueOnce(null);
        expect(await WorkItemRepository.assign(db as any, ctx, 'x', 'u1')).toBeNull();
    });

    it('updates assigneeUserId when present', async () => {
        db.task.findFirst.mockResolvedValueOnce({ id: 'x' });
        await WorkItemRepository.assign(db as any, ctx, 'x', 'u1');
        expect(db.task.update.mock.calls[0][0].data).toEqual({ assigneeUserId: 'u1' });
    });
});

describe('WorkItemRepository.metrics', () => {
    it('aggregates counts with empty groupBy branches', async () => {
        db.task.count.mockResolvedValue(0);
        db.task.groupBy.mockResolvedValue([]);
        const r = await WorkItemRepository.metrics(db as any, ctx);
        expect(r.total).toBe(0);
        expect(r.byStatus).toEqual({});
        // The dead topControls / topLinkedEntities aggregations were trimmed,
        // so no control.findMany / taskLink.groupBy is issued.
        expect(db.control.findMany).not.toHaveBeenCalled();
    });

    it('maps the byStatus groupBy result', async () => {
        db.task.groupBy.mockResolvedValueOnce([{ status: 'OPEN', _count: 3 }]);
        db.task.count.mockResolvedValue(1);

        const r = await WorkItemRepository.metrics(db as any, ctx);
        expect(r.byStatus).toEqual({ OPEN: 3 });
        expect(r.total).toBe(1);
        expect(r.overdue).toBe(1);
        expect(r.dueIn7d).toBe(1);
    });

    it('computes ONLY the fields a surface reads (no dead aggregations)', async () => {
        // PR-BB — bySeverity / byType / dueIn30d / trend were computed on every
        // tasks-list load and read by nothing (the KPI strip renders total /
        // byStatus.OPEN / overdue / dueIn7d; sparklines come from
        // /dashboard/trends). Trimming them removed 2 groupBy + 3 count queries.
        // Lock the shape so a field can't creep back without a consumer.
        db.task.groupBy.mockResolvedValue([]);
        db.task.count.mockResolvedValue(0);

        const r = await WorkItemRepository.metrics(db as any, ctx);
        expect(Object.keys(r).sort()).toEqual(['byStatus', 'dueIn7d', 'overdue', 'total']);
        // One groupBy (status) + three counts (overdue, due7d, total).
        expect(db.task.groupBy).toHaveBeenCalledTimes(1);
        expect(db.task.count).toHaveBeenCalledTimes(3);
    });
});

describe('WorkItemRepository.listByIds', () => {
    it('empty input short-circuits to []', async () => {
        expect(await WorkItemRepository.listByIds(db as any, ctx, [])).toEqual([]);
        expect(db.task.findMany).not.toHaveBeenCalled();
    });

    it('non-empty: queries scoped to ids + tenant + not-deleted', async () => {
        db.task.findMany.mockResolvedValueOnce([{ id: 't1', status: 'OPEN' }]);
        const r = await WorkItemRepository.listByIds(db as any, ctx, ['t1']);
        expect(r).toEqual([{ id: 't1', status: 'OPEN' }]);
        expect(db.task.findMany.mock.calls[0][0].where).toEqual({
            id: { in: ['t1'] }, tenantId: ctx.tenantId, deletedAt: null,
        });
    });
});

describe('WorkItemRepository bulk ops', () => {
    it('bulkAssign issues updateMany with assigneeUserId', async () => {
        await WorkItemRepository.bulkAssign(db as any, ctx, ['t1', 't2'], 'u1');
        expect(db.task.updateMany.mock.calls[0][0].data).toEqual({ assigneeUserId: 'u1' });
    });

    it('bulkSetStatus terminal status sets completedAt + resolution', async () => {
        await WorkItemRepository.bulkSetStatus(db as any, ctx, ['t1'], 'CLOSED', 'done');
        const data = db.task.updateMany.mock.calls[0][0].data;
        expect(data.completedAt).toBeInstanceOf(Date);
        expect(data.resolution).toBe('done');
    });

    it('bulkSetStatus terminal WITHOUT resolution omits resolution', async () => {
        await WorkItemRepository.bulkSetStatus(db as any, ctx, ['t1'], 'RESOLVED');
        const data = db.task.updateMany.mock.calls[0][0].data;
        expect(data.completedAt).toBeInstanceOf(Date);
        expect('resolution' in data).toBe(false);
    });

    it('bulkSetStatus non-terminal omits completedAt', async () => {
        await WorkItemRepository.bulkSetStatus(db as any, ctx, ['t1'], 'OPEN');
        const data = db.task.updateMany.mock.calls[0][0].data;
        expect('completedAt' in data).toBe(false);
    });

    it('bulkSetDueDate with a date parses it; null clears it', async () => {
        await WorkItemRepository.bulkSetDueDate(db as any, ctx, ['t1'], '2026-03-03T00:00:00.000Z');
        expect(db.task.updateMany.mock.calls[0][0].data.dueAt).toBeInstanceOf(Date);

        await WorkItemRepository.bulkSetDueDate(db as any, ctx, ['t1'], null);
        expect(db.task.updateMany.mock.calls[1][0].data.dueAt).toBeNull();
    });
});

describe('TaskLinkRepository', () => {
    it('listByTask queries by task + tenant ordered desc', async () => {
        await TaskLinkRepository.listByTask(db as any, ctx, 'task1');
        const arg = db.taskLink.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ taskId: 'task1', tenantId: ctx.tenantId });
        expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('link with explicit relation uses it', async () => {
        await TaskLinkRepository.link(db as any, ctx, 't1', 'ASSET', 'a1', 'BLOCKS');
        expect(db.taskLink.create.mock.calls[0][0].data.relation).toBe('BLOCKS');
    });

    it('link without relation defaults to RELATES_TO', async () => {
        await TaskLinkRepository.link(db as any, ctx, 't1', 'ASSET', 'a1');
        expect(db.taskLink.create.mock.calls[0][0].data.relation).toBe('RELATES_TO');
    });

    it('unlink returns null when link not found', async () => {
        db.taskLink.findFirst.mockResolvedValueOnce(null);
        expect(await TaskLinkRepository.unlink(db as any, ctx, 't1', 'l1')).toBeNull();
        expect(db.taskLink.delete).not.toHaveBeenCalled();
    });

    it('unlink deletes and returns true when found', async () => {
        db.taskLink.findFirst.mockResolvedValueOnce({ id: 'l1' });
        expect(await TaskLinkRepository.unlink(db as any, ctx, 't1', 'l1')).toBe(true);
        expect(db.taskLink.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
    });
});

describe('TaskCommentRepository', () => {
    it('listByTask queries ordered asc', async () => {
        await TaskCommentRepository.listByTask(db as any, ctx, 't1');
        expect(db.taskComment.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    });

    it('add creates a comment with tenant + author', async () => {
        await TaskCommentRepository.add(db as any, ctx, 't1', 'hello');
        const data = db.taskComment.create.mock.calls[0][0].data;
        expect(data).toMatchObject({ tenantId: ctx.tenantId, taskId: 't1', body: 'hello', createdByUserId: ctx.userId });
    });
});

describe('TaskWatcherRepository', () => {
    it('listByTask queries by task + tenant', async () => {
        await TaskWatcherRepository.listByTask(db as any, ctx, 't1');
        expect(db.taskWatcher.findMany.mock.calls[0][0].where).toEqual({ taskId: 't1', tenantId: ctx.tenantId });
    });

    it('add creates a watcher row', async () => {
        await TaskWatcherRepository.add(db as any, ctx, 't1', 'u1');
        expect(db.taskWatcher.create.mock.calls[0][0].data).toMatchObject({ tenantId: ctx.tenantId, taskId: 't1', userId: 'u1' });
    });

    it('remove returns null when watcher not found', async () => {
        db.taskWatcher.findFirst.mockResolvedValueOnce(null);
        expect(await TaskWatcherRepository.remove(db as any, ctx, 't1', 'u1')).toBeNull();
        expect(db.taskWatcher.delete).not.toHaveBeenCalled();
    });

    it('remove deletes and returns true when found', async () => {
        db.taskWatcher.findFirst.mockResolvedValueOnce({ id: 'w9' });
        expect(await TaskWatcherRepository.remove(db as any, ctx, 't1', 'u1')).toBe(true);
        expect(db.taskWatcher.delete).toHaveBeenCalledWith({ where: { id: 'w9' } });
    });
});
