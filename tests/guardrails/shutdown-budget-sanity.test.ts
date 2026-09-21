import {
    SHUTDOWN_AUDIT_FLUSH_MS,
    SHUTDOWN_PAUSE_RUNS_MS,
    SHUTDOWN_OTEL_MS,
    SHUTDOWN_SENTRY_MS,
    SHUTDOWN_STAGES_TOTAL_MS,
    SHUTDOWN_TOTAL_CEILING_MS,
} from '@/lib/observability/shutdown-budget';

describe('shutdown budget sanity', () => {
    it('sum of stage budgets fits under the total ceiling', () => {
        // Reads the DECLARED total rather than re-adding the stages here.
        //
        // This test used to sum three named constants by hand, and when a
        // fourth stage was added (pausing in-flight agentic runs) the sum went
        // on reporting the old three — so the ceiling check silently understated
        // the real budget by 2s and would have kept passing however many stages
        // were added. A guard that enumerates its own population by hand stops
        // covering the thing it is named for the moment that population grows.
        expect(SHUTDOWN_STAGES_TOTAL_MS).toBeLessThan(SHUTDOWN_TOTAL_CEILING_MS);
    });

    it('the declared total really is the sum of every stage', () => {
        // The other half: `SHUTDOWN_STAGES_TOTAL_MS` is only trustworthy while
        // it actually adds up. A fifth stage added to the handler and to this
        // list, but forgotten in the total, would sail under the ceiling.
        expect(SHUTDOWN_STAGES_TOTAL_MS).toBe(
            SHUTDOWN_AUDIT_FLUSH_MS +
                SHUTDOWN_PAUSE_RUNS_MS +
                SHUTDOWN_OTEL_MS +
                SHUTDOWN_SENTRY_MS,
        );
    });

    it('ceiling leaves at least 10s for Next HTTP drain under k8s 30s grace', () => {
        expect(SHUTDOWN_TOTAL_CEILING_MS).toBeLessThanOrEqual(20_000);
    });

    it('every stage budget is a positive number of milliseconds', () => {
        // A stage silently set to 0 is a stage that never runs: `Promise.race`
        // against a zero timer resolves before the work starts.
        expect(
            [
                SHUTDOWN_AUDIT_FLUSH_MS,
                SHUTDOWN_PAUSE_RUNS_MS,
                SHUTDOWN_OTEL_MS,
                SHUTDOWN_SENTRY_MS,
            ].filter((ms) => !(ms > 0)),
        ).toEqual([]);
    });
});
