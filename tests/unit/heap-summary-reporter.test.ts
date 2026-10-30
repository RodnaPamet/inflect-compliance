/**
 * THE HEAP SUMMARY'S VERDICT IS ONLY TRUSTWORTHY IN-BAND (#3977).
 *
 * The reporter exists to make the next `exit 134` arrive with evidence, and it
 * was asserting the very thing the issue was opened to investigate. Its
 * `shape … RETENTION` line fired on "rss essentially never receded" in EITHER
 * mode — and under `--maxWorkers=N` the sample is the PARENT, a process that
 * runs no tests, so its rss has nothing to give back and "never receded" is
 * true of it always.
 *
 * Measured on one hash-shuffled 1/50 slice, the same 61 files both ways:
 *
 *   workers (parent sample)    1 of 227 steps receded   ->  "RETENTION"
 *   in-band (real process)    16 of  60 steps receded   ->  no verdict
 *
 * So every local run printed RETENTION, because workers is the default. The
 * verdict is now gated on the mode it can be true of, and these are the
 * assertions that keep it there — the reporter had no test at all before,
 * despite being registered for every jest project in `jest.config.js`.
 */
import * as path from 'path';

const HeapSummaryReporter = require(
    path.resolve(__dirname, '../reporters/heap-summary-reporter.js'),
) as new (globalConfig: { maxWorkers: number }) => {
    onTestResult: (t: unknown, r: { testFilePath: string }) => void;
    onRunComplete: () => void;
};

/** Drive the reporter over a scripted rss sequence and capture its block. */
function runWith(opts: { maxWorkers: number; rssSeriesMb: number[] }): string {
    const MB = 1024 * 1024;
    const real = process.memoryUsage;
    let i = 0;
    // `as never`: the real signature carries an `rss()` member we do not need.
    process.memoryUsage = (() => {
        const rss = (opts.rssSeriesMb[Math.min(i, opts.rssSeriesMb.length - 1)] ?? 0) * MB;
        i += 1;
        return { rss, heapUsed: rss / 2, heapTotal: rss, external: 0, arrayBuffers: 0 };
    }) as never;

    const written: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
    }) as never;

    try {
        const reporter = new HeapSummaryReporter({ maxWorkers: opts.maxWorkers });
        opts.rssSeriesMb.forEach((_, n) =>
            reporter.onTestResult({}, { testFilePath: `/repo/tests/unit/f${n}.test.ts` }),
        );
        reporter.onRunComplete();
    } finally {
        process.memoryUsage = real;
        process.stderr.write = realWrite;
    }
    return written.join('');
}

/** 15 samples that never recede — the input that used to produce RETENTION. */
const NEVER_RECEDES = Array.from({ length: 15 }, (_, n) => 200 + n * 10);

describe('heap summary — the shape verdict', () => {
    it('does NOT claim RETENTION from a parent sample, and says why', () => {
        const out = runWith({ maxWorkers: 4, rssSeriesMb: NEVER_RECEDES });

        // The regression this file exists for: same input, workers mode.
        expect(out).not.toContain('RETENTION');
        expect(out).toContain('NOT ASSESSED');
        // And it names the way to get a verdict rather than leaving a gap.
        expect(out).toContain('--runInBand');
    });

    it('DOES claim RETENTION in-band, where the sample is the test process', () => {
        // The verdict is gated, not deleted — it is still the thing the
        // reporter is for, in the one mode it can be true of.
        const out = runWith({ maxWorkers: 1, rssSeriesMb: NEVER_RECEDES });
        expect(out).toContain('RETENTION');
    });

    it('withholds the verdict in-band when rss DOES recede', () => {
        // The discriminator, proved in the direction that matters: a run whose
        // memory comes back must not be reported as retaining it.
        const sawtooth = [200, 400, 250, 450, 280, 500, 300, 520, 330, 540, 350, 560, 380, 580, 400];
        const out = runWith({ maxWorkers: 1, rssSeriesMb: sawtooth });
        expect(out).not.toContain('RETENTION');
        expect(out).not.toContain('NOT ASSESSED');
    });

    it('reports the retained set, or names what it could not measure', () => {
        // Every other figure in the block is PRE-GC, so it counts garbage V8
        // has not got to — which is why "never receded" cannot tell cumulative
        // weight from a leak. Without `--expose-gc` the block says so rather
        // than letting the reader take the rss numbers for the retained set.
        const out = runWith({ maxWorkers: 1, rssSeriesMb: NEVER_RECEDES });
        if (typeof globalThis.gc === 'function') {
            expect(out).toMatch(/retained \(post-GC\) +\d+ MB heap/);
        } else {
            expect(out).toContain('not measured — add --expose-gc');
        }
    });
});

/**
 * THE TRAIL MUST EXIST WHEN THE RUN DOES NOT FINISH (#4613).
 *
 * Shard 7/7 died three times on 2026-10-30 at ~10.2 GB and printed nothing: the
 * summary above is written by `onRunComplete`, and an `exit 134` never gets
 * there. These drive `onTestResult` ALONE — no `onRunComplete` — which is the
 * crash, and assert what is on stderr at that point.
 */
function trailFor(heapSeriesMb: number[]): string[] {
    const MB = 1024 * 1024;
    const real = process.memoryUsage;
    let i = 0;
    process.memoryUsage = (() => {
        const heapUsed = (heapSeriesMb[Math.min(i, heapSeriesMb.length - 1)] ?? 0) * MB;
        i += 1;
        return { rss: heapUsed + 900 * MB, heapUsed, heapTotal: heapUsed, external: 0, arrayBuffers: 0 };
    }) as never;

    const written: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
    }) as never;

    try {
        const reporter = new HeapSummaryReporter({ maxWorkers: 1 });
        heapSeriesMb.forEach((_, n) =>
            reporter.onTestResult({}, { testFilePath: `${process.cwd()}/tests/unit/f${n}.test.ts` }),
        );
        // Deliberately no onRunComplete(): the process is assumed dead here.
    } finally {
        process.memoryUsage = real;
        process.stderr.write = realWrite;
    }
    return written
        .join('')
        .split('\n')
        .filter((l) => l.startsWith('heap trail (#4613)'));
}

const marksOf = (lines: string[]) => lines.map((l) => l.match(/passed (\d+) GB/)?.[1]);

describe('heap trail — written per file, before any crash', () => {
    it('prints nothing for a run that stays at its usual ~2 GB', () => {
        // The shape of a normal shard 7 on main: up to ~2.3 GB heapUsed, receding.
        expect(trailFor([300, 1400, 2300, 1700, 2100, 1900, 3900])).toEqual([]);
    });

    it('prints one line at 4 GB and at each 2 GB above it, with no onRunComplete', () => {
        // Marks are binary GB: 4096, 6144, 8192 and 10240 MB.
        const series = [700, 1800, 3000, 4100, 4500, 5200, 6300, 7000, 8200, 10300];
        const lines = trailFor(series);

        expect(marksOf(lines)).toEqual(['4', '6', '8', '10']);
        // Each names the file that had just finished and its 1-based index…
        expect(lines[0]).toContain('after tests/unit/f3.test.ts — file 4,');
        expect(lines[1]).toContain('after tests/unit/f6.test.ts — file 7,');
        // …and how many files ran since the previous mark: the range to bisect.
        expect(lines[0]).toContain('4 files since the previous mark');
        expect(lines[1]).toContain('3 files since the previous mark');
        expect(lines[2]).toContain('2 files since the previous mark');
        expect(lines[3]).toContain('1 file since the previous mark');
        // The step that landed the mark, and the clock V8's GC trace uses.
        expect(lines[1]).toContain('step +1100 MB');
        expect(lines[1]).toMatch(/at \d+ s$/);
    });

    it('names only the highest mark a single step jumps to, and never repeats a mark', () => {
        // +6.3 GB in one file (4 and 6 jumped over, 8 reached), then a dip and
        // a climb back over 8 that must not print 8 again.
        const lines = trailFor([1000, 2000, 8300, 6000, 8500, 9900, 10300]);
        expect(marksOf(lines)).toEqual(['8', '10']);
        expect(lines[0]).toContain('step +6300 MB');
        expect(lines[1]).toContain('4 files since the previous mark');
    });
});
