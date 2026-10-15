import { resumePositionOf } from '@/app-layer/usecases/workflow-runs';

/**
 * WHERE A QUEUED RUN RESUMES (#3602).
 *
 * ## The defect
 *
 * `executeQueuedWorkflowRun` passed `row.stepCount` as the resume point, under a
 * header stating that the index comes from the ledger rather than the payload
 * "because the steps that call tools are not idempotent". The column is not the
 * ledger: it is a denormalised counter with a single writer, and every path that
 * dies before that writer leaves it behind the committed rows.
 *
 * Measured in production: a `posture-review` run on 2026-09-24 carried
 * `stepCount 0` alongside FOUR committed, guard-CLEAN `TOOL_CALL` rows, its
 * segment having been killed mid-dispatch before `settleTurns`. The retry
 * arrived 3h34m later and was refused by the wall-clock cap, so the
 * re-execution never happened — but a retry inside the hour would have replayed
 * all four non-idempotent tool calls.
 *
 * ## Why this is a unit test of arithmetic
 *
 * Nothing exercised the expression. Reaching `executeQueuedWorkflowRun` needs
 * Prisma, a registered agent and a real dispatch, which is why a stale read sat
 * there unnoticed. Extracting the two-number decision is what makes it
 * assertable at all; `flue-propose-charges-the-cap` pins that the call site
 * still goes through it.
 */
describe('resumePositionOf — the greater of the ledger and the counter', () => {
    it('resumes AFTER committed rows when the counter is stale', () => {
        // The production shape: 4 rows at seq 0..3, counter never written.
        // Resuming at 0 would re-run every one of them.
        expect(resumePositionOf(3, 0)).toBe(4);
    });

    it('resumes where a human checkpoint decided, when that is further on', () => {
        // `resumeWorkflowRun` writes `resumedFrom + 1` before enqueueing,
        // because the argument does not survive the hop to the worker. A run
        // released past a checkpoint must not resume before that point.
        expect(resumePositionOf(2, 7)).toBe(7);
    });

    it('agrees with both when they agree', () => {
        // The ordinary case: 5 rows at seq 0..4 and a counter of 5.
        expect(resumePositionOf(4, 5)).toBe(5);
    });

    it('starts at 0 for a run that has committed nothing', () => {
        // `max(seq)` over an empty ledger is -1, which must mean "no rows", not
        // "resume at -1".
        expect(resumePositionOf(-1, 0)).toBe(0);
    });

    it('never returns a position behind committed work, for any counter', () => {
        // The property, not an example. Whatever the counter says, the result
        // cannot land on a row that already committed — that is the whole
        // safety claim, and `stepCount` is an untrusted input to it.
        for (const ledgerMaxSeq of [-1, 0, 3, 4, 49]) {
            for (const stepCount of [0, 1, 3, 5, 50]) {
                expect(resumePositionOf(ledgerMaxSeq, stepCount)).toBeGreaterThanOrEqual(
                    ledgerMaxSeq + 1,
                );
            }
        }
    });

    it('never returns a position behind a counter the resume path wrote', () => {
        // The other direction of the same property. Both inputs are
        // authoritative about different things, so neither may be discarded.
        for (const ledgerMaxSeq of [-1, 0, 3, 49]) {
            for (const stepCount of [0, 2, 7, 50]) {
                expect(resumePositionOf(ledgerMaxSeq, stepCount)).toBeGreaterThanOrEqual(
                    stepCount,
                );
            }
        }
    });
});
