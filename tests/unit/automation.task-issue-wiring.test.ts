/**
 * Unit Test: the Task usecase publishes automation events.
 *
 * `task.ts` is a high-value automation source (incident detection,
 * SLA escalation, cross-entity auto-close). This test proves the emit
 * sites added alongside its existing audit-log writes fire with the
 * right event + payload, without booting the rest of the app or a
 * real DB.
 *
 * The ISSUE_CREATED / ISSUE_STATUS_CHANGED emitters that used to be
 * asserted here lived in `usecases/issue.ts`, a parallel work-item
 * surface whose `/issues` routes were retired. With no HTTP entry
 * point the emitters were unreachable, so they were deleted along
 * with the rest of that surface; the events remain declared for the
 * rule builder but nothing publishes them today.
 */

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

// Stub the tenant transaction context so the usecase's
// `runInTenantContext` wrapper just passes its callback through
// with a fake db that returns our mocked repo results.
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx, callback) => {
            // Callback gets a `db` arg — repos are fully mocked below, so
            // anything truthy satisfies the signature. reconcileTaskSource
            // (TP-3) probes `db.task.findFirst` on a terminal transition;
            // stub it to null so reconciliation no-ops in this unit test.
            return callback({
                task: { findFirst: jest.fn().mockResolvedValue(null) },
                // Task writes now resolve body-supplied user ids against an
                // ACTIVE membership before persisting; return the caller so
                // the validation passes in this unit context.
                tenantMembership: {
                    // Echo back whatever ids were asked about, so membership
                    // validation passes regardless of the fixture's user ids.
                    findMany: jest.fn().mockImplementation(async (args: never) => {
                        const ids = (args as { where?: { userId?: { in?: string[] } } })
                            ?.where?.userId?.in ?? [];
                        return ids.map((userId: string) => ({ userId }));
                    }),
                    findFirst: jest.fn().mockResolvedValue({ user: { email: 'a@b.com', name: 'A' } }),
                },
            } as unknown);
        }),
    };
});

jest.mock('@/app-layer/repositories/TaskRepository', () => ({
    TaskRepository: {
        create: jest.fn(),
        update: jest.fn(),
        getById: jest.fn(),
        setStatus: jest.fn(),
    },
    TaskLinkRepository: { listByTask: jest.fn().mockResolvedValue([]) },
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));

import { createTask, setTaskStatus } from '@/app-layer/usecases/task';
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import {
    getAutomationBus,
    resetAutomationBus,
    type AutomationDomainEvent,
} from '@/app-layer/automation';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-task',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

describe('Task usecase emission', () => {
    beforeEach(() => {
        resetAutomationBus();
        jest.clearAllMocks();
    });

    test('createTask publishes TASK_CREATED with key + severity + priority', async () => {
        (TaskRepository.create as jest.Mock).mockResolvedValue({
            id: 'task-1',
            key: 'TSK-42',
            title: 'Patch SQLi',
            type: 'INCIDENT',
            severity: 'CRITICAL',
            priority: 'P0',
            status: 'OPEN',
            assigneeUserId: 'user-2',
            controlId: null,
        });

        const captured: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('TASK_CREATED', (e) => {
            captured.push(e);
        });

        await createTask(makeCtx(), {
            title: 'Patch SQLi',
            type: 'INCIDENT',
            severity: 'CRITICAL',
            priority: 'P0',
            assigneeUserId: 'user-2',
        });

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.event).toBe('TASK_CREATED');
        expect(evt.tenantId).toBe('tenant-A');
        expect(evt.entityId).toBe('task-1');
        expect(evt.stableKey).toBe('task-1');
        if (evt.event === 'TASK_CREATED') {
            expect(evt.data).toEqual({
                key: 'TSK-42',
                title: 'Patch SQLi',
                type: 'INCIDENT',
                severity: 'CRITICAL',
                priority: 'P0',
                assigneeUserId: 'user-2',
                controlId: null,
            });
        }
    });

    test('setTaskStatus publishes TASK_STATUS_CHANGED with fromStatus→toStatus', async () => {
        // S8 — IN_PROGRESS → CLOSED is now illegal under the work-
        // item state machine; CLOSED must be reached via RESOLVED.
        (TaskRepository.getById as jest.Mock).mockResolvedValue({
            id: 'task-1',
            status: 'RESOLVED',
            type: 'TASK',
            controlId: null,
        });
        (TaskRepository.setStatus as jest.Mock).mockResolvedValue({
            id: 'task-1',
            status: 'CLOSED',
        });

        const captured: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('TASK_STATUS_CHANGED', (e) => {
            captured.push(e);
        });

        await setTaskStatus(makeCtx(), 'task-1', 'CLOSED', 'fixed in rev 42');

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.stableKey).toBe('task-1:RESOLVED:CLOSED');
        if (evt.event === 'TASK_STATUS_CHANGED') {
            expect(evt.data.fromStatus).toBe('RESOLVED');
            expect(evt.data.toStatus).toBe('CLOSED');
            expect(evt.data.resolution).toBe('fixed in rev 42');
        }
    });
});
