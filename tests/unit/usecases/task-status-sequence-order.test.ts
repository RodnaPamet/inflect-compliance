/**
 * The task status-change sequence has an ORDER, and the order is the
 * whole reason `applyTaskStatusPostWrite` / `afterTaskStatusCommit`
 * exist. The integration suite proves the four effects HAPPEN; nothing
 * proved they happen in the documented sequence, or on the documented
 * side of the commit. Reordering them left every suite green.
 *
 * This test records the real runtime sequence of the observable effects
 * — the audit write, the source reconciliation, the automation event
 * (captured off the REAL in-process bus, not a mock), the cache bump and
 * the watcher bell fan-out — interleaved with a `commit` marker emitted
 * by the tenant-transaction wrapper when the transaction callback
 * returns. Asserting on that trace fails on any reorder AND on moving a
 * post-commit step into the transaction (it would land before `commit`).
 *
 * No source text is read: every marker is pushed by code that actually
 * ran.
 */

const trace: string[] = [];

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => {
        trace.push('audit');
    }),
}));

jest.mock('@/app-layer/usecases/task-source-reconcile', () => ({
    reconcileTaskSource: jest.fn(async () => {
        trace.push('reconcile');
    }),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (_ctx: unknown, _k: unknown, read: () => unknown) => read()),
    bumpEntityCacheVersion: jest.fn(async () => {
        trace.push('cache-bump');
    }),
}));

jest.mock('@/app-layer/notifications/watcher', () => ({
    createWatcherNotifications: jest.fn(async () => {
        trace.push('watchers');
    }),
}));

/** Rows the fake `db` returns — mutable so a test can widen the batch. */
const mockDbRows: {
    tasks: Array<Record<string, unknown>>;
    watchers: Array<{ taskId: string; userId: string }>;
} = {
    tasks: [
        { id: 'task-1', tenantId: 'tenant-A', title: 'T', key: 'TSK-1', type: 'TASK', controlId: null },
    ],
    watchers: [{ taskId: 'task-1', userId: 'watcher-1' }],
};

// The transaction wrapper: mark the boundary the moment the callback
// resolves, i.e. the point the real wrapper commits.
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    const fakeDb = {
        task: {
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn(async () => mockDbRows.tasks),
        },
        taskWatcher: {
            findMany: jest.fn(async () => mockDbRows.watchers),
        },
        tenantMembership: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
        },
    };
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: unknown, callback: (db: unknown) => Promise<unknown>) => {
            const out = await callback(fakeDb);
            trace.push('commit');
            return out;
        }),
    };
});

jest.mock('@/app-layer/repositories/TaskRepository', () => ({
    TaskRepository: {
        getById: jest.fn(),
        setStatus: jest.fn(),
        listByIds: jest.fn(),
        bulkSetStatus: jest.fn(),
    },
    TaskLinkRepository: {
        listByTask: jest.fn().mockResolvedValue([]),
        listByTaskIds: jest.fn().mockResolvedValue([]),
    },
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

import { setTaskStatus, bulkSetTaskStatus } from '@/app-layer/usecases/task';
import { TaskRepository, TaskLinkRepository } from '@/app-layer/repositories/TaskRepository';
import { getAutomationBus, resetAutomationBus } from '@/app-layer/automation';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('OWNER', {
    tenantId: 'tenant-A',
    tenantSlug: 'tenant-A',
    userId: 'actor-1',
});

/** The trace, keeping only the FIRST commit marker — the status
 *  transaction's. The watcher fan-out opens its own short transaction
 *  (deliberately: a bell failure must never roll a committed status
 *  change back), so its boundary is not the one under test. */
function statusTrace(): string[] {
    const statusCommit = trace.indexOf('commit');
    return trace.filter((m, i) => m !== 'commit' || i === statusCommit);
}

beforeEach(() => {
    trace.length = 0;
    mockDbRows.tasks = [
        { id: 'task-1', tenantId: 'tenant-A', title: 'T', key: 'TSK-1', type: 'TASK', controlId: null },
    ];
    mockDbRows.watchers = [{ taskId: 'task-1', userId: 'watcher-1' }];
    jest.clearAllMocks();
    resetAutomationBus();
    getAutomationBus().subscribe('TASK_STATUS_CHANGED', () => {
        trace.push('automation');
    });
    (TaskRepository.getById as jest.Mock).mockResolvedValue({
        id: 'task-1',
        status: 'RESOLVED',
        type: 'TASK',
        controlId: null,
        reviewerUserId: null,
    });
    (TaskRepository.setStatus as jest.Mock).mockResolvedValue({ id: 'task-1', status: 'CLOSED' });
    (TaskRepository.listByIds as jest.Mock).mockResolvedValue([
        { id: 'task-1', status: 'RESOLVED', type: 'TASK', controlId: null, reviewerUserId: null },
    ]);
    (TaskRepository.bulkSetStatus as jest.Mock).mockResolvedValue({ count: 1 });
});

afterEach(() => {
    resetAutomationBus();
});

describe('task status change — the sequence, not just the effects', () => {
    it('setTaskStatus runs audit → reconcile → COMMIT → automation → cache bump → watchers', async () => {
        await setTaskStatus(ctx, 'task-1', 'CLOSED', 'fixed');

        expect(statusTrace()).toEqual([
            'audit',
            'reconcile',
            'commit',
            'automation',
            'cache-bump',
            'watchers',
        ]);
    });

    it('bulkSetTaskStatus runs the same sequence (parity)', async () => {
        await bulkSetTaskStatus(ctx, ['task-1'], 'CLOSED', 'fixed');

        expect(statusTrace()).toEqual([
            'audit',
            'reconcile',
            'commit',
            'automation',
            'cache-bump',
            'watchers',
        ]);
    });

    it('the audit row precedes the reconciler, and both precede the commit', async () => {
        await setTaskStatus(ctx, 'task-1', 'CLOSED', 'fixed');

        const commit = trace.indexOf('commit');
        expect(trace.indexOf('audit')).toBeLessThan(trace.indexOf('reconcile'));
        expect(trace.indexOf('reconcile')).toBeLessThan(commit);
    });

    it('the batch relevance gate reads TaskLink ONCE, not once per task', async () => {
        // Three link-qualified rows (AUDIT_FINDING, no controlId) — the
        // shape that used to cost one sequential TaskLink read each.
        const ids = ['task-1', 'task-2', 'task-3'];
        mockDbRows.tasks = ids.map((id) => ({
            id,
            tenantId: 'tenant-A',
            title: id,
            key: id,
            type: 'AUDIT_FINDING',
            controlId: null,
        }));
        mockDbRows.watchers = [];
        (TaskRepository.listByIds as jest.Mock).mockResolvedValue(
            ids.map((id) => ({ id, status: 'RESOLVED', type: 'AUDIT_FINDING', controlId: null, reviewerUserId: null })),
        );
        (TaskLinkRepository.listByTaskIds as jest.Mock).mockResolvedValue(
            ids.map((id) => ({ taskId: id, entityType: 'CONTROL' })),
        );

        await bulkSetTaskStatus(ctx, ids, 'CLOSED', 'fixed');

        expect(TaskLinkRepository.listByTaskIds).toHaveBeenCalledTimes(1);
        expect(TaskLinkRepository.listByTaskIds).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            ids,
        );
        expect(TaskLinkRepository.listByTask).not.toHaveBeenCalled();
    });

    it('a task whose batch-resolved links do not qualify is still refused, with the single path\'s message', async () => {
        mockDbRows.tasks = [
            { id: 'task-9', tenantId: 'tenant-A', title: 't', key: 'k', type: 'AUDIT_FINDING', controlId: null },
        ];
        (TaskRepository.listByIds as jest.Mock).mockResolvedValue([
            { id: 'task-9', status: 'RESOLVED', type: 'AUDIT_FINDING', controlId: null, reviewerUserId: null },
        ]);
        (TaskLinkRepository.listByTaskIds as jest.Mock).mockResolvedValue([
            { taskId: 'task-9', entityType: 'POLICY' },
        ]);

        await expect(bulkSetTaskStatus(ctx, ['task-9'], 'CLOSED', 'fixed')).rejects.toThrow(
            /Cannot bulk-transition task task-9: AUDIT_FINDING tasks must have a controlId or a link to CONTROL or FRAMEWORK_REQUIREMENT\./,
        );
        // Refused before any write, so nothing ran and nothing committed.
        expect(trace).toEqual([]);
    });

    it('no automation event and no bell exist before the transaction commits', async () => {
        await setTaskStatus(ctx, 'task-1', 'CLOSED', 'fixed');

        // The emission is not part of the transaction (the bus takes no
        // `db`), so it must not be dispatched while a later failure
        // could still roll the change back.
        const commit = trace.indexOf('commit');
        expect(trace.slice(0, commit)).not.toContain('automation');
        expect(trace.slice(0, commit)).not.toContain('watchers');
        expect(trace.slice(0, commit)).not.toContain('cache-bump');
    });
});
