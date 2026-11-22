/**
 * The automation bus is ONE bus per process, however many module instances of
 * its file a bundler makes, and the web tier's events reach the queue only
 * while AUTOMATION_WEB_EVENTS_ENABLED is on.
 *
 * Next.js loads `instrumentation.ts` (which installs the dispatcher) and the
 * route handlers (which emit) as separate module instances. While the bus was a
 * module-level `let`, the route handler's instance kept the no-op default
 * dispatcher, so no event emitted from a web request was ever enqueued and no
 * automation rule fired from one (Inspect run 43429583015: a TASK_CREATED rule
 * that never wrote an execution). `jest.isolateModules` gives each block its
 * own module registry, which is the same split.
 *
 * Owner decision 2026-11-13: sharing the bus ships behind the switch, off by
 * default, at the WEB tier's dispatcher. The worker's dispatcher never reads
 * it, so worker-tier events fire as they always have.
 */

const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => enqueue(...args),
}));
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => {
    const actual = jest.requireActual('@/lib/observability/logger');
    return { ...actual, logger: { ...actual.logger, info: (...a: unknown[]) => info(...a) } };
});

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

/** The startup hook and a route handler, as two module instances. */
function split(): { startup: BootstrapModule; route: BusModule } {
    let startup!: BootstrapModule;
    let route!: BusModule;
    jest.isolateModules(() => {
        startup = jest.requireActual('@/app-layer/automation/bus-bootstrap');
    });
    jest.isolateModules(() => {
        route = jest.requireActual('@/app-layer/automation/automation-bus');
    });
    return { startup, route };
}

const emitTaskCreated = (bus: BusModule, id = 'task-1') =>
    bus.emitAutomationEvent(ctx(), {
        event: 'TASK_CREATED',
        entityType: 'Task',
        entityId: id,
        actorUserId: 'user-1',
        stableKey: id,
        data: { key: 'TSK-1', title: 'A task', type: 'TASK', severity: 'MEDIUM', priority: 'P2', assigneeUserId: null, controlId: null },
    });

const heldLines = () => info.mock.calls.filter(([msg]) => msg === 'automation-bus.web_events_held');

describe('automation bus across module instances', () => {
    afterEach(() => {
        enqueue.mockClear();
        info.mockClear();
        delete process.env.AUTOMATION_WEB_EVENTS_ENABLED;
        delete (globalThis as { __inflectAutomationBus?: unknown }).__inflectAutomationBus;
    });

    it('both instances hand back the same bus', () => {
        const { route } = split();
        let other!: BusModule;
        jest.isolateModules(() => {
            other = jest.requireActual('@/app-layer/automation/automation-bus');
        });
        expect(route).not.toBe(other);
        expect(route.getAutomationBus()).toBe(other.getAutomationBus());
    });

    describe('the web tier, behind AUTOMATION_WEB_EVENTS_ENABLED', () => {
        it.each(['1', 'true', 'TRUE'])('switch %p: an event a route emits reaches the dispatcher the startup hook installed', async (value) => {
            process.env.AUTOMATION_WEB_EVENTS_ENABLED = value;
            const { startup, route } = split();
            startup.installAutomationBusDispatcher('web');
            await emitTaskCreated(route);
            expect(enqueue).toHaveBeenCalledTimes(1);
            expect(enqueue.mock.calls[0][0]).toBe('automation-event-dispatch');
            expect(enqueue.mock.calls[0][1]).toMatchObject({ tenantId: 'tenant-A', event: { event: 'TASK_CREATED', entityId: 'task-1' } });
            expect(heldLines()).toHaveLength(0);
        });

        it.each([undefined, '', '0', 'false', 'yes', 'on'])('switch %p: nothing is dispatched, and the hold is logged once per process', async (value) => {
            if (value !== undefined) process.env.AUTOMATION_WEB_EVENTS_ENABLED = value;
            const { startup, route } = split();
            startup.installAutomationBusDispatcher('web');
            await emitTaskCreated(route, 'task-1');
            await emitTaskCreated(route, 'task-2');
            expect(enqueue).not.toHaveBeenCalled();
            expect(heldLines()).toHaveLength(1);
            expect(heldLines()[0][1]).toMatchObject({ switch: 'AUTOMATION_WEB_EVENTS_ENABLED', event: 'TASK_CREATED' });
        });

        it('reads the switch per event, so turning it on needs no new install', async () => {
            const { startup, route } = split();
            startup.installAutomationBusDispatcher('web');
            await emitTaskCreated(route);
            expect(enqueue).not.toHaveBeenCalled();
            process.env.AUTOMATION_WEB_EVENTS_ENABLED = '1';
            await emitTaskCreated(route);
            expect(enqueue).toHaveBeenCalledTimes(1);
        });
    });

    describe('the worker tier never reads the switch', () => {
        it.each([undefined, '0', '1'])('switch %p: a worker-emitted event is dispatched', async (value) => {
            if (value !== undefined) process.env.AUTOMATION_WEB_EVENTS_ENABLED = value;
            let worker!: BootstrapModule;
            let bus!: BusModule;
            jest.isolateModules(() => {
                worker = jest.requireActual('@/app-layer/automation/bus-bootstrap');
                bus = jest.requireActual('@/app-layer/automation/automation-bus');
            });
            worker.installAutomationBusDispatcher('worker');
            await emitTaskCreated(bus);
            expect(enqueue).toHaveBeenCalledTimes(1);
            expect(heldLines()).toHaveLength(0);
        });
    });
});
