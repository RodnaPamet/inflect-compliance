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
