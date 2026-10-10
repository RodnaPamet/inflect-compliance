/**
 * Giving the reconciliation run a production caller.
 *
 * WHAT THIS SUITE IS ABOUT. Before this change `runLegacyReconcile` had no
 * production caller at all — no job executor, no route, no schedule, and every
 * importer of it was a test. A tenant could pull a snapshot and open the review
 * queue, and the queue was empty for ever, because the only writer of
 * `LegacyAccountResolution` was a function nothing called.
 *
 * That is not a kind of defect a test of the run can find: the run's own 30
 * integration assertions all passed throughout. So the assertions here are
 * about the SEAM — who calls it, under what authority, with what payload —
 * rather than about what the run computes.
 *
 * The enqueued job NAME is checked by `tsc` (it is a key of `JobPayloadMap`)
 * and the registry/payload-map/schedule triangle by
 * `tests/guardrails/runtime-wiring-coverage.test.ts`, which was mutation-proven
 * against this entry. What is left for a test is the request path's refusals
 * and the job path's identity.
 */

const fakeDb = {
    legacyAccessSnapshot: { findFirst: jest.fn() },
};

// Typed with variadic args so `mock.calls[0][1]` is readable: a `jest.fn()`
// declared with no parameters has `[]` tuples for its calls, and indexing one
// is a type error rather than the assertion it looks like.
const enqueueMock = jest.fn(async (..._args: unknown[]) => ({ id: 'job-1' }));
const logEventMock = jest.fn(async (..._args: unknown[]) => undefined);
const buildSystemContextMock = jest.fn((input: { tenantId: string; job: string }) => ({
    requestId: `job:${input.job}`,
    userId: null,
    tenantId: input.tenantId,
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true },
    appPermissions: {},
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(fakeDb),
}));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: enqueueMock }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: logEventMock }));
jest.mock('@/app-layer/context-system', () => ({
    buildSystemContext: buildSystemContextMock,
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));

import { requestLegacyReconcile } from '@/app-layer/usecases/legacy-reconcile';
import { makeRequestContext } from '../helpers/make-context';

const ctx = (role: 'OWNER' | 'READER' = 'OWNER') =>
    makeRequestContext(role, { tenantId: 'tenant-1', userId: 'user-1' });

beforeEach(() => {
    jest.clearAllMocks();
    fakeDb.legacyAccessSnapshot.findFirst.mockResolvedValue({
        id: 'snap-1',
        connectionId: 'conn-1',
    });
    enqueueMock.mockResolvedValue({ id: 'job-1' });
});

describe('requestLegacyReconcile', () => {
    it('enqueues one run for the snapshot it was given', async () => {
        const result = await requestLegacyReconcile(ctx(), 'snap-1');

        expect(result.jobId).toBe('job-1');
        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock).toHaveBeenCalledWith('legacy-reconcile', {
            tenantId: 'tenant-1',
            snapshotId: 'snap-1',
        });
    });

    it('enqueues the SNAPSHOT id the lookup returned, not the one asked for', async () => {
        // They are the same here, and the assertion is still worth making: the
        // payload must carry a snapshot that was resolved under tenant context,
        // so a caller cannot enqueue a run against an id this tenant cannot see.
        fakeDb.legacyAccessSnapshot.findFirst.mockResolvedValue({
            id: 'snap-resolved',
            connectionId: 'conn-1',
        });
        await requestLegacyReconcile(ctx(), 'snap-1');
        expect(enqueueMock.mock.calls[0][1]).toMatchObject({ snapshotId: 'snap-resolved' });
    });

    it('scopes the lookup to the tenant', async () => {
        await requestLegacyReconcile(ctx(), 'snap-1');
        expect(fakeDb.legacyAccessSnapshot.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'snap-1', tenantId: 'tenant-1' },
            }),
        );
    });

    it('refuses an unknown snapshot with a 404 and enqueues NOTHING', async () => {
        fakeDb.legacyAccessSnapshot.findFirst.mockResolvedValue(null);

        await expect(requestLegacyReconcile(ctx(), 'nope')).rejects.toThrow(/not found/i);
        // The half that matters: a queued job for a snapshot nobody can see
        // would record its refusal in a job result an administrator is not
        // looking at, instead of a 404 they can act on.
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('refuses a READER, and enqueues nothing', async () => {
        await expect(requestLegacyReconcile(ctx('READER'), 'snap-1')).rejects.toThrow();
        expect(enqueueMock).not.toHaveBeenCalled();
        // And it refuses BEFORE the lookup — authorization is not something to
        // decide after reading a tenant's rows.
        expect(fakeDb.legacyAccessSnapshot.findFirst).not.toHaveBeenCalled();
    });

    it('writes one audit row naming the snapshot, the job and the requester', async () => {
        await requestLegacyReconcile(ctx(), 'snap-1');

        expect(logEventMock).toHaveBeenCalledTimes(1);
        const entry = logEventMock.mock.calls[0][2] as unknown as {
            entityType: string;
            entityId: string;
            action: string;
            detailsJson: Record<string, unknown>;
        };
        expect(entry.entityType).toBe('LegacyAccessSnapshot');
        expect(entry.entityId).toBe('snap-1');
        expect(entry.action).toBe('LEGACY_RECONCILE_REQUESTED');
        expect(entry.detailsJson).toMatchObject({
            event: 'legacy_reconcile_requested',
            snapshotId: 'snap-1',
            connectionId: 'conn-1',
            jobId: 'job-1',
            requestedByUserId: 'user-1',
        });
    });

    it('audits AFTER the enqueue, so the row can name the job id', async () => {
        // A row written first would carry `jobId: null` for every run, and "which
        // job was this request?" is the only link between the trail and the queue.
        const order: string[] = [];
        enqueueMock.mockImplementation(async () => {
            order.push('enqueue');
            return { id: 'job-1' };
        });
        logEventMock.mockImplementation(async () => {
            order.push('audit');
        });
        await requestLegacyReconcile(ctx(), 'snap-1');
        expect(order).toEqual(['enqueue', 'audit']);
    });
});

describe('the job entry point', () => {
    it('builds a system context for the tenant, with a greppable job identity', async () => {
        // There is no signed-in person inside a worker, so the run cannot take a
        // real principal — and `runLegacyReconcile` asserts admin. A system
        // context is how the pull solves the same problem, and naming the job
        // keeps machine writes filterable in the trail.
        const { runLegacyReconcileJob } = await import('@/app-layer/usecases/legacy-reconcile');

        // The run itself needs a database; this asserts the context it is given,
        // which is the part this change introduced.
        await runLegacyReconcileJob({ tenantId: 'tenant-9', snapshotId: 'snap-9' }).catch(
            () => undefined,
        );

        expect(buildSystemContextMock).toHaveBeenCalledWith({
            tenantId: 'tenant-9',
            job: 'legacy-reconcile',
        });
    });

});
