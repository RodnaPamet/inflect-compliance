/**
 * The automation bus is ONE bus per process, however many module instances of
 * its file a bundler makes.
 *
 * Next.js loads `instrumentation.ts` (which installs the BullMQ dispatcher) and
 * the route handlers (which emit) as separate module instances. While the bus
 * was a module-level `let`, the route handler's instance kept the no-op default
 * dispatcher, so no event emitted from a web request was ever enqueued and no
 * automation rule fired from one (Inspect run 43429583015: a TASK_CREATED rule
 * that never wrote an execution). `jest.isolateModules` gives each block its
 * own module registry, which is the same split.
 */

const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => enqueue(...args),
}));

import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

type BusModule = typeof import('@/app-layer/automation/automation-bus');
type BootstrapModule = typeof import('@/app-layer/automation/bus-bootstrap');

function ctx(): RequestContext {
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'OWNER',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('OWNER'),
    };
}

describe('automation bus across module instances', () => {
    afterEach(() => {
        enqueue.mockClear();
        delete (globalThis as { __inflectAutomationBus?: unknown }).__inflectAutomationBus;
    });

    it('an event emitted through one instance reaches the dispatcher installed through another', async () => {
        let startup!: BootstrapModule;
        let route!: BusModule;
        jest.isolateModules(() => {
            startup = jest.requireActual('@/app-layer/automation/bus-bootstrap');
        });
        jest.isolateModules(() => {
            route = jest.requireActual('@/app-layer/automation/automation-bus');
        });

        startup.installAutomationBusDispatcher();
        await route.emitAutomationEvent(ctx(), {
            event: 'TASK_CREATED',
            entityType: 'Task',
            entityId: 'task-1',
            actorUserId: 'user-1',
            stableKey: 'task-1',
            data: {
                key: 'TSK-1',
                title: 'A task',
                type: 'TASK',
                severity: 'MEDIUM',
                priority: 'P2',
                assigneeUserId: null,
                controlId: null,
            },
        });

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0][0]).toBe('automation-event-dispatch');
        expect(enqueue.mock.calls[0][1]).toMatchObject({ tenantId: 'tenant-A', event: { event: 'TASK_CREATED', entityId: 'task-1' } });
    });

    it('both instances hand back the same bus', () => {
        let a!: BusModule;
        let b!: BusModule;
        jest.isolateModules(() => {
            a = jest.requireActual('@/app-layer/automation/automation-bus');
        });
        jest.isolateModules(() => {
            b = jest.requireActual('@/app-layer/automation/automation-bus');
        });
        expect(a).not.toBe(b);
        expect(a.getAutomationBus()).toBe(b.getAutomationBus());
    });
});
