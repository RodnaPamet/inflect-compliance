/**
 * `agent-run-execute` is ONE JOB PER RUN SEGMENT (#5854 finding 2).
 *
 * It was enqueued with no `jobId`, so nothing but the enqueue sites stood
 * between a run and two jobs for it. The id is now derived from the run and
 * the instant of the transition that authorised the segment, which makes a
 * second enqueue of one segment a job BullMQ itself refuses: `Queue.add` with
 * an id the queue already holds adds nothing and hands back the first job.
 *
 * `bullmq` is replaced by a queue that keeps that one documented rule, so the
 * real `enqueue` (the seam every job passes through) is what is exercised.
 * The rule itself was checked against a real BullMQ and Redis when this was
 * written; the Test job has no Redis to repeat that on every run.
 */
const jobs = new Map<string, { id: string; name: string; data: unknown }>();
let added = 0;
const mockAdd = jest.fn(async (name: string, data: unknown, opts: { jobId?: string } = {}) => {
    const id = opts.jobId ?? `auto-${++added}`;
    // BullMQ's rule: an id the queue already holds is not added again.
    const existing = jobs.get(id);
    if (existing) return existing;
    const job = { id, name, data };
    jobs.set(id, job);
    return job;
});

jest.mock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
}));
jest.mock('@/lib/redis', () => ({ createRedisClient: () => ({}) }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { enqueue } from '@/app-layer/jobs/queue';
import { agentRunExecuteJobId } from '@/app-layer/jobs/agent-run-job-id';
import { isValidBullMqJobId } from '@/app-layer/jobs/fan-out';

describe('agent-run-execute is one job per run segment (#5854)', () => {
    beforeEach(() => {
        jobs.clear();
        mockAdd.mockClear();
    });

    it('a second enqueue of the same segment is refused by its jobId', async () => {
        const runId = 'cmwtqju1m0007sy7dgbf5zz7q';
        const startedAt = new Date('2026-11-23T10:00:00.000Z');

        await enqueue('agent-run-execute', { tenantId: 't1', runId }, { jobId: agentRunExecuteJobId(runId, startedAt) });
        await enqueue('agent-run-execute', { tenantId: 't1', runId }, { jobId: agentRunExecuteJobId(runId, startedAt) });

        expect(mockAdd).toHaveBeenCalledTimes(2);
        expect(jobs.size).toBe(1);
    });

    it('two segments of one run are two jobs, so a resume is never dropped as a duplicate of its start', async () => {
        const runId = 'cmwtqju1m0007sy7dgbf5zz7q';
        const ids = [
            agentRunExecuteJobId(runId, new Date('2026-11-23T10:00:00.000Z')),
            agentRunExecuteJobId(runId, new Date('2026-11-23T10:05:00.000Z')),
            agentRunExecuteJobId(runId, new Date('2026-11-23T10:05:00.001Z')),
        ];
        for (const jobId of ids) await enqueue('agent-run-execute', { tenantId: 't1', runId }, { jobId });
        expect(jobs.size).toBe(3);
    });

    it('two runs never share an id, and every id is colon-free', () => {
        const at = new Date('2026-11-23T10:00:00.000Z');
        const a = agentRunExecuteJobId('cmwtqju1m0007sy7dgbf5zz7q', at);
        const b = agentRunExecuteJobId('cmwtqjucu000esy7di0ebjqya', at);
        expect(a).not.toBe(b);
        expect([a, b].map((id) => [id.includes(':'), isValidBullMqJobId(id)])).toEqual([
            [false, true],
            [false, true],
        ]);
        expect(a).toBe('agent-run-cmwtqju1m0007sy7dgbf5zz7q-1795428000000');
    });
});
