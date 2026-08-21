/**
 * The `av-rescan` executor's job record must be able to say that the run
 * HALTED.
 *
 * The circuit breaker stops a rescan whose INFECTED proportion looks wrong
 * rather than letting it go on condemning files. That decision reached the
 * audit row and a dedicated log line, but not the BullMQ job record — the
 * executor built its `details` block by naming counters one at a time, and
 * the list was written before `scannerThrew` / `backedOff` / `halted` /
 * `haltReason` / `haltRemediation` existed.
 *
 * The property under test is not "the fields are present" — it is that a
 * halted run and a clean finish produce DISTINGUISHABLE records. Both runs
 * below carry identical counters, so the halt is the only thing that can
 * separate them; every top-level field is asserted equal to prove the
 * difference lives where an operator will actually look.
 */
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import type { JobRunResult } from '@/app-layer/jobs/types';

const HALT_REMEDIATION =
    'Verdicts already written were left in place. Verify the ClamAV signature '
    + 'database before re-running; clear any false positive with POST '
    + '/api/t/:slug/admin/files/:fileId/clear-quarantine (OWNER only).';

/**
 * A full `AvRescanResult`. Kept as one literal rather than a partial so the
 * drift assertion below has the complete key set to compare the record
 * against — the failure being guarded is precisely a field existing on the
 * result and never reaching the record.
 */
function makeAvRescanResult(overrides: Record<string, unknown> = {}) {
    return {
        tenantId: 't-av',
        jobRunId: 'run-av',
        scanned: 12,
        clean: 4,
        infected: 6,
        leftPending: 1,
        integrityMismatch: 0,
        oversize: 0,
        scannerError: 0,
        scannerThrew: 2,
        readError: 0,
        refusedSyntheticClean: 0,
        lostClaim: 1,
        backedOff: 1,
        halted: false,
        haltReason: null as string | null,
        haltRemediation: null as string | null,
        durationMs: 9_999,
        ...overrides,
    };
}

const runAvRescan = jest.fn(
    async (_options: unknown): Promise<ReturnType<typeof makeAvRescanResult>> => makeAvRescanResult(),
);

jest.mock('@/app-layer/jobs/av-rescan', () => ({
    runAvRescan: (options: unknown) => runAvRescan(options),
}));

const reg = executorRegistry as unknown as {
    execute(name: string, payload: unknown): Promise<JobRunResult>;
};

const PAYLOAD = {
    tenantId: 't-av',
    initiatedByUserId: 'u-1',
    limit: 50,
    requestId: 'req-1',
};

/** Fields that legitimately differ between any two runs. */
function stable(result: JobRunResult) {
    const { jobRunId, startedAt, completedAt, durationMs, details, ...rest } = result;
    void jobRunId;
    void startedAt;
    void completedAt;
    void durationMs;
    void details;
    return rest;
}

async function runOnce(overrides: Record<string, unknown> = {}) {
    runAvRescan.mockResolvedValueOnce(makeAvRescanResult(overrides));
    return reg.execute('av-rescan', PAYLOAD);
}

beforeEach(() => {
    runAvRescan.mockClear();
});

describe('av-rescan executor — the halt reaches the job record', () => {
    it('carries every result field except the job body duration into details', async () => {
        const result = await runOnce();

        // Positive: the executor actually ran the job, so an assertion about
        // what it produced is an assertion about a decision that happened.
        expect(runAvRescan).toHaveBeenCalledTimes(1);
        expect(runAvRescan).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-av' }));

        const details = result.details as Record<string, unknown>;
        const expected = makeAvRescanResult();
        for (const key of Object.keys(expected)) {
            if (key === 'durationMs') continue;
            expect(details).toHaveProperty(key, expected[key as keyof typeof expected]);
        }

        // The one deliberate omission: the record's top-level `durationMs`
        // is the executor's wall clock, and the job body's own measure must
        // not shadow it under the same name.
        expect(details.durationMs).toBeUndefined();
        expect(typeof result.durationMs).toBe('number');

        // The counters added after the hand-written list was frozen.
        expect(details.scannerThrew).toBe(2);
        expect(details.backedOff).toBe(1);
    });

    it('records a halted run as halted, with reason and remediation', async () => {
        const result = await runOnce({
            halted: true,
            haltReason: 'infection-ratio',
            haltRemediation: HALT_REMEDIATION,
        });

        const details = result.details as Record<string, unknown>;
        expect(details.halted).toBe(true);
        expect(details.haltReason).toBe('infection-ratio');
        expect(details.haltRemediation).toBe(HALT_REMEDIATION);
    });

    it('makes a HALTED run distinguishable from a COMPLETED one', async () => {
        const completed = await runOnce();
        const halted = await runOnce({
            halted: true,
            haltReason: 'infection-ratio',
            haltRemediation: HALT_REMEDIATION,
        });

        // Everything OUTSIDE details is identical — the two runs examined the
        // same rows and reached the same verdicts. Without the details fix the
        // two records would be indistinguishable, which is the bug.
        expect(stable(halted)).toEqual(stable(completed));
        expect(halted.itemsScanned).toBe(completed.itemsScanned);
        expect(halted.itemsActioned).toBe(completed.itemsActioned);

        // …and the details block is what separates them.
        expect(halted.details).not.toEqual(completed.details);
        expect((completed.details as Record<string, unknown>).halted).toBe(false);
        expect((completed.details as Record<string, unknown>).haltReason).toBeNull();
        expect((halted.details as Record<string, unknown>).halted).toBe(true);
    });

    it('keeps a halted run a SUCCESS so the queue does not retry it', async () => {
        const halted = await runOnce({
            halted: true,
            haltReason: 'infection-ratio',
            haltRemediation: HALT_REMEDIATION,
        });

        // A halt is not a job failure: the run did exactly what it was told
        // to do. Reporting failure would have BullMQ retry the same sweep
        // against the same suspect signature database.
        expect(halted.success).toBe(true);
        expect(halted.errorMessage).toBeUndefined();
        expect(halted.noRetry).toBeUndefined();
    });
});
