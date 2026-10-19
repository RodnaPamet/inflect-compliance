/**
 * Running a scan on the estate's schedule.
 *
 * The cadence is the estate's (`schedule.everyHours`). The tenant declares the
 * same cadence on its estate in Inflect, and the reports page holds every scan
 * this loop posts against it: a run that fails, or a scanner that stops, shows
 * there as a STALE estate rather than as silence. That is why a failed run is
 * logged and the loop carries on — stopping would turn one bad night into an
 * estate nobody scans, and the page would be the first to know.
 *
 * Runs are anchored to their START, so a slow scan does not drift the
 * schedule later every day; a run that overran its slot is followed by the
 * next one at once rather than skipped.
 */
import type { ScannerLog } from './log';

export async function runOnSchedule(opts: {
    readonly everyHours: number;
    readonly run: () => Promise<void>;
    readonly log: ScannerLog;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    /** Stop after this many runs (tests); unbounded otherwise. */
    readonly maxRuns?: number;
}): Promise<number> {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const period = opts.everyHours * 3_600_000;
    let runs = 0;
    for (;;) {
        const started = now();
        try {
            await opts.run();
        } catch (err) {
            opts.log.error('scheduled scan failed; the schedule continues', {
                error: err instanceof Error ? err.name : 'unknown',
            });
        }
        runs += 1;
        if (opts.maxRuns !== undefined && runs >= opts.maxRuns) return runs;
        const wait = started + period - now();
        if (wait > 0) await sleep(wait);
    }
}
