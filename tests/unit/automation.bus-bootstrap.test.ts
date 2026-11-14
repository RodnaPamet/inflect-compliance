/**
 * Unit Test: bus → BullMQ wiring.
 *
 * After `installAutomationBusDispatcher()`, emitting on the bus
 * must:
 *   - enqueue an `automation-event-dispatch` job
 *   - serialize `emittedAt` to an ISO string (JSON-safe)
 *   - preserve all tenant-safe metadata from the event
 *   - carry top-level `tenantId` matching the event (the mismatch
 *     guard in the executor depends on this)
 */

// Mock the queue before importing the bootstrap — binds the import.
const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => enqueue(...args),
}));

import {
    installAutomationBusDispatcher,
    bullmqAutomationDispatcher,
    toDispatchPayload,
    resetAutomationBus,
    emitAutomationEvent,
    getAutomationBus,
} from '@/app-layer/automation';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-1',
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

describe('bus-bootstrap', () => {
    beforeEach(() => {
        enqueue.mockClear();
        resetAutomationBus();
    });

    describe('toDispatchPayload', () => {
        it('serializes emittedAt to ISO string', () => {
            const now = new Date('2026-04-22T10:00:00.000Z');
            const payload = toDispatchPayload({
                event: 'RISK_CREATED',
                tenantId: 'tenant-A',
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: 'user-1',
                emittedAt: now,
                data: { title: 't', score: 1, category: null },
            });
            expect(payload.tenantId).toBe('tenant-A');
            expect(payload.event.emittedAt).toBe('2026-04-22T10:00:00.000Z');
            expect(payload.event.tenantId).toBe('tenant-A');
        });

        it('top-level tenantId always matches event.tenantId (mismatch guard)', () => {
            const p = toDispatchPayload({
                event: 'RISK_CREATED',
                tenantId: 'tenant-X',
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: null,
                emittedAt: new Date(),
                data: { title: 't', score: 1, category: null },
            });
            expect(p.tenantId).toBe(p.event.tenantId);
        });
    });

    describe('bullmqAutomationDispatcher', () => {
        it('enqueues automation-event-dispatch with serialized payload', async () => {
            await bullmqAutomationDispatcher({
                event: 'RISK_CREATED',
                tenantId: 'tenant-A',
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: 'user-1',
                emittedAt: new Date('2026-04-22T10:00:00.000Z'),
                data: { title: 't', score: 1, category: null },
            });

            expect(enqueue).toHaveBeenCalledWith(
                'automation-event-dispatch',
                expect.objectContaining({
                    tenantId: 'tenant-A',
                    event: expect.objectContaining({
                        event: 'RISK_CREATED',
                        tenantId: 'tenant-A',
                        emittedAt: '2026-04-22T10:00:00.000Z',
                    }),
                })
            );
        });

        it('propagates enqueue failures so the bus logs them', async () => {
            enqueue.mockRejectedValueOnce(new Error('redis down'));
            await expect(
                bullmqAutomationDispatcher({
                    event: 'RISK_CREATED',
                    tenantId: 'tenant-A',
                    entityType: 'Risk',
                    entityId: 'r-1',
                    actorUserId: null,
                    emittedAt: new Date(),
                    data: { title: 't', score: 1, category: null },
                })
            ).rejects.toThrow('redis down');
        });
    });

    describe('installAutomationBusDispatcher', () => {
        it('after install, emit() triggers queue.enqueue once per event', async () => {
            installAutomationBusDispatcher('worker');

            await emitAutomationEvent(makeCtx(), {
                event: 'RISK_CREATED',
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: 'user-1',
                data: { title: 't', score: 1, category: null },
            });

            expect(enqueue).toHaveBeenCalledTimes(1);
            const [jobName, payload] = enqueue.mock.calls[0];
            expect(jobName).toBe('automation-event-dispatch');
            expect(payload.tenantId).toBe('tenant-A');
            expect(payload.event.event).toBe('RISK_CREATED');
            // emittedAt serialized to string for Redis.
            expect(typeof payload.event.emittedAt).toBe('string');
        });

        it('surviving subscribers still fire alongside queue enqueue', async () => {
            const observed: string[] = [];
            getAutomationBus().subscribe('RISK_CREATED', (e) => {
                observed.push(e.event);
            });
            installAutomationBusDispatcher('worker');

            await emitAutomationEvent(makeCtx(), {
                event: 'RISK_CREATED',
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: null,
                data: { title: 't', score: 1, category: null },
            });

            expect(observed).toEqual(['RISK_CREATED']);
            expect(enqueue).toHaveBeenCalledTimes(1);
        });

        it('is idempotent — repeated install does not multiply dispatch', async () => {
            installAutomationBusDispatcher('worker');
            installAutomationBusDispatcher('worker');
            installAutomationBusDispatcher('worker');

            await emitAutomationEvent(makeCtx(), {
                event: 'RISK_CREATED',
                entityType: 'Risk',
                entityId: 'r-1',
                actorUserId: null,
                data: { title: 't', score: 1, category: null },
            });

            expect(enqueue).toHaveBeenCalledTimes(1);
        });

        it('enqueue failure does not throw out of emit (bus swallows)', async () => {
            enqueue.mockRejectedValueOnce(new Error('redis down'));
            installAutomationBusDispatcher('worker');

            await expect(
                emitAutomationEvent(makeCtx(), {
                    event: 'RISK_CREATED',
                    entityType: 'Risk',
                    entityId: 'r-1',
                    actorUserId: null,
                    data: { title: 't', score: 1, category: null },
                })
            ).resolves.toBeUndefined();
        });
    });
});
