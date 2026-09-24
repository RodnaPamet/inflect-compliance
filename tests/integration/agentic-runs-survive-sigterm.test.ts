/**
 * A SIGTERM mid-run must leave the run RESUMABLE, not abandoned.
 *
 * ── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
 *
 * Runs execute inline. A rolling deploy sends SIGTERM to the process walking
 * the steps, and before this change the row was simply left `RUNNING` — with no
 * executor, and nothing noticing for a long time. `agent-run-reaper` selects on
 * `updatedAt < now - WALL_CLOCK_MS - REAP_GRACE_MS`, so the run sat there for a
 * full wall-clock budget plus ten minutes and was then settled to FAILED with a
 * permanent hash-chained row asserting it had no executor.
 *
 * ── THE ASSERTION THAT MATTERS MOST IS THE NEGATIVE ONE ─────────────────────
 *
 * "Pause every RUNNING run" is the obvious implementation and it is a
 * cross-instance outage: pod A's SIGTERM would pause the runs pod B is actively
 * executing. No query can tell those apart, because the difference is not in
 * the database — it is in which process holds the run in memory.
 *
 * So the test that earns its place is `leaves another process's run alone`. A
 * drain that paused everything would satisfy every other assertion here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import {
    pauseInFlightRuns,
    trackInFlightRun,
    untrackInFlightRun,
    inFlightRunIds,
    _resetInFlightRunsForTesting,
} from '@/lib/agentic/in-flight-runs';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { REPO_ROOT } from '../helpers/repo-files';
import { functionBodyOf } from '../helpers/source-blocks';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT = 'sigterm-drain-tenant';
const BUDGET = 2_000;

async function makeRun(id: string, status: 'RUNNING' | 'COMPLETED', stepCount = 3) {
    await prisma.workflowRun.create({
        data: { id, tenantId: TENANT, workflowKey: 'audit-prep', status, stepCount },
    });
}

const statusOf = async (id: string) =>
    (await prisma.workflowRun.findUnique({ where: { id }, select: { status: true } }))?.status;

describeFn('the SIGTERM drain pauses this process\'s runs and nothing else', () => {
    beforeAll(async () => {
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
    });

    beforeEach(async () => {
        _resetInFlightRunsForTesting();
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
    });

    afterAll(async () => {
        if (TENANT) {
            await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } });
            await prisma.tenant.deleteMany({ where: { id: TENANT } });
        }
        _resetInFlightRunsForTesting();
        await prisma.$disconnect();
    });

    it('moves a tracked RUNNING run to PAUSED', async () => {
        await makeRun('drain-mine', 'RUNNING');
        trackInFlightRun('drain-mine');

        const outcome = await pauseInFlightRuns(BUDGET);

        expect(outcome).toEqual({ attempted: 1, paused: 1, timedOut: false });
        expect(await statusOf('drain-mine')).toBe('PAUSED');
    });

    it('leaves another process\'s run alone', async () => {
        // THE ONE THAT EARNS ITS PLACE. Both rows are RUNNING and
        // indistinguishable in the database; only the in-memory set says which
        // is ours. A drain that paused every RUNNING row would pass every other
        // test in this file and take down every other pod's work.
        await makeRun('drain-mine', 'RUNNING');
        await makeRun('drain-theirs', 'RUNNING');
        trackInFlightRun('drain-mine');

        const outcome = await pauseInFlightRuns(BUDGET);

        expect(outcome.attempted).toBe(1);
        expect({
            mine: await statusOf('drain-mine'),
            theirs: await statusOf('drain-theirs'),
        }).toEqual({ mine: 'PAUSED', theirs: 'RUNNING' });
    });

    it('does not walk a settled run backwards into PAUSED', async () => {
        // The race the `status: 'RUNNING'` condition exists for: a run can
        // complete between the snapshot and the write. Without the condition
        // this would move a COMPLETED run to PAUSED, which is a finished run
        // reappearing in the resume queue.
        await makeRun('drain-finished', 'COMPLETED');
        trackInFlightRun('drain-finished');

        const outcome = await pauseInFlightRuns(BUDGET);

        expect({ attempted: outcome.attempted, paused: outcome.paused }).toEqual({
            attempted: 1,
            paused: 0,
        });
        expect(await statusOf('drain-finished')).toBe('COMPLETED');
    });

    it('is a no-op, with no query, when this process runs nothing', async () => {
        await makeRun('drain-idle', 'RUNNING');

        const outcome = await pauseInFlightRuns(BUDGET);

        expect(outcome).toEqual({ attempted: 0, paused: 0, timedOut: false });
        expect(await statusOf('drain-idle')).toBe('RUNNING');
    });

    it('reports BOTH numbers, so a partial drain is visible', async () => {
        // "paused: 1" alone cannot distinguish a clean drain from one that
        // found two runs and saved one — and the difference is a run that gets
        // reaped to FAILED in an hour.
        await makeRun('drain-a', 'RUNNING');
        await makeRun('drain-b', 'COMPLETED');
        trackInFlightRun('drain-a');
        trackInFlightRun('drain-b');

        const outcome = await pauseInFlightRuns(BUDGET);

        expect({ attempted: outcome.attempted, paused: outcome.paused }).toEqual({
            attempted: 2,
            paused: 1,
        });
    });

    it('a PAUSED run is what resumeWorkflowRun already knows how to restart', async () => {
        // Not a new resume path: `resumeWorkflowRun` finds no PENDING step (a
        // SIGTERM lands mid-step, not at a checkpoint), falls through its
        // `pending?.seq ?? run.stepCount - 1` branch and executes from
        // `stepCount`. This pins the two facts that makes true — the status it
        // accepts, and that `stepCount` is the count of completed steps.
        await makeRun('drain-resumable', 'RUNNING', 4);
        trackInFlightRun('drain-resumable');
        await pauseInFlightRuns(BUDGET);

        const row = await prisma.workflowRun.findUnique({
            where: { id: 'drain-resumable' },
            select: { status: true, stepCount: true },
        });
        expect(row).toEqual({ status: 'PAUSED', stepCount: 4 });

        const pending = await prisma.workflowStep.count({
            where: { runId: 'drain-resumable', status: 'PENDING' },
        });
        expect(pending).toBe(0);
    });
});

describe('the in-flight registry itself', () => {
    beforeEach(() => _resetInFlightRunsForTesting());
    afterAll(() => _resetInFlightRunsForTesting());

    it('tracks and untracks', () => {
        trackInFlightRun('a');
        trackInFlightRun('b');
        expect(inFlightRunIds().sort()).toEqual(['a', 'b']);
        untrackInFlightRun('a');
        expect(inFlightRunIds()).toEqual(['b']);
    });

    it('is idempotent in both directions', () => {
        trackInFlightRun('a');
        trackInFlightRun('a');
        expect(inFlightRunIds()).toEqual(['a']);
        untrackInFlightRun('a');
        untrackInFlightRun('a');
        expect(inFlightRunIds()).toEqual([]);
    });

    it('hands out a snapshot, never the live set', () => {
        // A caller mutating the returned array must not silently untrack a run.
        trackInFlightRun('a');
        inFlightRunIds().push('ghost');
        expect(inFlightRunIds()).toEqual(['a']);
    });
});

describe('BOTH tiers install the drain, not just the one that had it', () => {
    // The function above is only worth anything where it is CALLED, and it was
    // called in one of the two processes that execute runs.
    //
    // `executeFrom` tracks every run through `trackInFlightRun` on both tiers,
    // so the worker's register was populated and read by nobody:
    // `scripts/worker.ts` closed BullMQ, quit Redis and drained OTel on
    // SIGTERM, and never paused a run it was executing. #2824 made that live
    // by routing Flue resumes to the worker.
    //
    // SLICED TO THE HANDLER, not read whole. A whole-file read is what
    // `assertion-needle-uniqueness-ratchet` counts as un-analysable, and it is
    // the weaker assertion anyway: the claim is about what each tier's
    // SHUTDOWN PATH does, not about a string appearing somewhere in a file.
    const bodyOf = (rel: string, fn: string) =>
        functionBodyOf(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), fn);

    const webHandler = bodyOf('src/lib/observability/shutdown.ts', 'installShutdownHandlers');
    const workerHandler = bodyOf('scripts/worker.ts', 'shutdown');

    it('the slices are the handlers — otherwise the assertions below are vacuous', () => {
        // `functionBodyOf` mis-bounds on a return type containing braces.
        // Neither of these has one, and this is the check that says so.
        expect(webHandler.length).toBeGreaterThan(200);
        expect(workerHandler.length).toBeGreaterThan(200);
        expect(workerHandler).toContain('shutdownTelemetry');
    });

    it('the web tier drains', () => {
        expect(webHandler).toContain('pauseInFlightRuns(');
    });

    it('the worker drains too', () => {
        expect(workerHandler).toContain('pauseInFlightRuns(');
    });

    it('the worker drains BEFORE it closes the queue', () => {
        // `worker.close()` waits for the active job. A reasoning run is
        // bounded by WALL_CLOCK_MS — an hour — and a deploy's grace period is
        // seconds, so waiting does not save the run; pausing it does, and only
        // while there is still time to write.
        const drain = workerHandler.indexOf('pauseInFlightRuns(');
        const close = workerHandler.indexOf('worker?.close()');
        expect(drain).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(-1);
        expect(drain).toBeLessThan(close);
    });
});
