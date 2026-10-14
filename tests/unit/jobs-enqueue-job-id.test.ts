/**
 * `enqueue()` refuses an invalid BullMQ custom job id (#3554).
 *
 * THE SEAM HAD NO TEST, and that is a large part of why #3554 reached
 * production and stayed there. Every other suite in the repo mocks
 * `@/app-layer/jobs/queue`, so the real `enqueue` — the one function every job
 * in the system passes through — was exercised by nothing.
 *
 * The scheduler's own unit test mocks it too, which is why it could assert the
 * exact id string BullMQ rejects and stay green for seven days while ~4,300
 * real enqueues failed.
 *
 * The precondition is checked BEFORE the queue is constructed, so these tests
 * need no Redis: the `bullmq` mock below exists only to prove the rejection
 * happens on our side of the boundary, never reaching `queue.add`.
 */

import { isValidBullMqJobId, scheduledJobId } from '@/app-layer/jobs/fan-out';

const mockAdd = jest.fn().mockResolvedValue({ id: 'job-1' });

jest.mock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
}));
jest.mock('@/lib/redis', () => ({ createRedisClient: () => ({}) }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Imported after the mocks, which is what makes them apply.
import { enqueue } from '@/app-layer/jobs/queue';

describe('enqueue refuses a job id BullMQ would reject (#3554)', () => {
    beforeEach(() => {
        mockAdd.mockClear();
    });

    it('throws on the id that caused the outage', async () => {
        // The real shape: `ctr:{planId}:{ISO instant}`. Five colon-separated
        // segments, because the timestamp brings two of its own.
        const bad = `ctr:cmosxcqt0000abcd1234bxyi:${new Date(1760000000000).toISOString()}`;
        expect(isValidBullMqJobId(bad)).toBe(false);
        await expect(
            enqueue('control-test-runner', { tenantId: 't', testPlanId: 'p' } as never, {
                jobId: bad,
            }),
        ).rejects.toThrow(/not a valid BullMQ custom id/);
    });

    it('rejects BEFORE reaching BullMQ, so the message names our rule', async () => {
        // The point of putting the check at the seam rather than letting the
        // library throw: `Custom Id cannot contain :` had to be decoded twice,
        // five weeks apart, by two different people reading two different logs.
        await expect(
            enqueue('control-test-runner', { tenantId: 't' } as never, { jobId: 'a:b:c:d' }),
        ).rejects.toThrow(/dispatchJobId\(\) or scheduledJobId\(\)/);
        expect(mockAdd).not.toHaveBeenCalled();
    });

    it('lets a factory-built id through to the queue', async () => {
        // The other half: a precondition that rejected everything would also
        // pass the two tests above. `scheduledJobId` is colon-free and must
        // reach `queue.add`.
        const good = scheduledJobId('ctr', 'cmosxcqt0000abcd1234bxyi', 1760000000000);
        await enqueue('control-test-runner', { tenantId: 't' } as never, { jobId: good });
        expect(mockAdd).toHaveBeenCalledTimes(1);
        expect(mockAdd.mock.calls[0][2]).toMatchObject({ jobId: good });
    });

    it('lets the three-segment dispatchJobId format through', async () => {
        // BullMQ accepts it today, and eight call sites depend on that. If this
        // ever fails, the colon carve-out is gone and those sites need the
        // colon-free factory — see the TODO quoted in
        // `tests/guards/bullmq-job-id-rule.test.ts`.
        await enqueue('identity-sync', { tenantId: 't' } as never, {
            jobId: 'identity-sync:conn1:1760000000000',
        });
        expect(mockAdd).toHaveBeenCalledTimes(1);
    });

    it('enqueues without a custom id at all', async () => {
        // The manual-trigger path. It passes no `jobId`, which is exactly why a
        // manual run worked perfectly throughout both outages and made the
        // feature look healthy from the outside.
        await enqueue('control-test-runner', { tenantId: 't' } as never);
        expect(mockAdd).toHaveBeenCalledTimes(1);
    });
});
