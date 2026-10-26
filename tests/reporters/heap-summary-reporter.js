/**
 * ONE SUMMARY BLOCK, SO THE NEXT `exit 134` ARRIVES WITH EVIDENCE (#3977).
 *
 * Four heap incidents on the `Test` matrix in about a month, each diagnosed from
 * a bare `exit 134` and each resolved by giving the suite more room. The
 * workflow's own comment reached "A seventh is the next step". Nothing has ever
 * captured what the heap was doing at the moment it died.
 *
 * ── WHY IT SAMPLES RSS ITSELF RATHER THAN USING --logHeapUsage ──────────────
 *
 * `--logHeapUsage` is the obvious source and it is the wrong one here: it makes
 * the default reporter append ` (123 MB heap size)` to EVERY `PASS` line, which
 * is ~1,650 lines of per-file noise in a log other people read. This samples
 * `process.memoryUsage()` in `onTestResult` and prints once, so a passing job
 * grows by a dozen lines and a failing one finally says something.
 *
 * ── WHAT IT MEASURES, AND WHERE THAT IS TRUE ───────────────────────────────
 *
 * `ci.yml:711` runs the shards with `--runInBand`, so the main process IS the
 * test process and its RSS is the number that hits the ceiling. That is the
 * configuration this exists for.
 *
 * Under `--maxWorkers=N` the same sample measures the PARENT, which is not where
 * the OOM happens — so the block says which mode it observed instead of
 * presenting a parent's RSS as if it were a worker's. A reporter that reported
 * the wrong process confidently would be worse than none, and getting that
 * distinction wrong is exactly what sent my own measurement of this issue
 * astray twice.
 */
const MB = 1024 * 1024;

class HeapSummaryReporter {
    constructor(globalConfig) {
        this._inBand = globalConfig?.maxWorkers === 1;
        this._samples = [];
        this._peak = { rss: 0, heap: 0, path: null };
    }

    onTestResult(test, testResult) {
        const { rss, heapUsed } = process.memoryUsage();
        const path = testResult?.testFilePath ?? test?.path ?? '(unknown)';
        this._samples.push({ path, rss, heapUsed });
        if (rss > this._peak.rss) this._peak = { rss, heap: heapUsed, path };
    }

    onRunComplete() {
        if (this._samples.length === 0) return;

        const first = this._samples[0];
        const last = this._samples[this._samples.length - 1];
        const mb = (n) => `${Math.round(n / MB)} MB`;
        // Signed, because the largest "step" is negative on a short run and
        // `+-12 MB` reads like a typo rather than a reading.
        const signed = (n) => `${n < 0 ? '-' : '+'}${Math.round(Math.abs(n) / MB)} MB`;

        // Biggest single-step growth. Reported as "the step landed here", NOT as
        // "this file is heavy": measured on this suite, the file blamed for a
        // +4.7 GB step used 338 MB when run alone. The step falls on whichever
        // file runs when V8 stops collecting, so naming it as a consumer sends
        // people to optimise innocent tests.
        let worst = { delta: -Infinity, path: null };
        for (let i = 1; i < this._samples.length; i += 1) {
            const delta = this._samples[i].rss - this._samples[i - 1].rss;
            if (delta > worst.delta) worst = { delta, path: this._samples[i].path };
        }
        const receded = this._samples.filter(
            (s, i) => i > 0 && s.rss < this._samples[i - 1].rss,
        ).length;

        const rel = (p) => (typeof p === 'string' ? p.replace(`${process.cwd()}/`, '') : String(p));
        const lines = [
            '',
            '─── heap summary (#3977) ─────────────────────────────────────',
            `  mode              ${this._inBand ? 'in-band — this process IS the test process' : 'workers — SAMPLED THE PARENT, not where an OOM lands'}`,
            `  files observed    ${this._samples.length}`,
            `  rss first → last  ${mb(first.rss)} → ${mb(last.rss)}`,
            `  rss peak          ${mb(this._peak.rss)}  (heapUsed ${mb(this._peak.heap)})`,
            `  peak after        ${rel(this._peak.path)}`,
        ];
        // Only when there IS a step. With one file there are no deltas, and the
        // sentinel printed `-Infinity MB after null` — a line that looks like a
        // crash in the thing meant to explain crashes.
        if (this._samples.length > 1) {
            lines.push(`  largest step      ${signed(worst.delta)} after ${rel(worst.path)}`);
            lines.push(`  steps that receded ${receded} of ${this._samples.length - 1}`);
        }
        // ─── THE SHAPE VERDICT, AND WHY IT IS GATED ON IN-BAND (#3977) ────
        //
        // This used to fire on `receded <= 2` in EITHER mode, and in workers
        // mode that is a verdict about the parent — a process that runs no
        // tests, so its RSS has nothing to give back and "never receded" is
        // true of it always. Every local run (workers is the default) therefore
        // printed `RETENTION`, which is the claim the issue was opened to
        // investigate, asserted by the instrument meant to investigate it.
        //
        // Measured on one hash-shuffled 1/50 slice, same 61 files:
        //
        //   workers (parent sample)   1 of 227 steps receded  -> "RETENTION"
        //   in-band (real process)   16 of  60 steps receded  -> no verdict
        //
        // So the verdict is only ever printed for the mode it can be true of.
        if (this._inBand && receded <= 2 && this._samples.length > 10) {
            lines.push('  shape             RETENTION — rss essentially never receded');
        } else if (!this._inBand && receded <= 2 && this._samples.length > 10) {
            // Say why there is no verdict, rather than leaving a gap that
            // reads as "nothing to report".
            lines.push(
                '  shape             NOT ASSESSED — a parent that runs no tests cannot recede;',
            );
            lines.push(
                '                    re-run with --runInBand for a verdict (that is what CI does)',
            );
        }
        // ─── THE RETAINED SET, ONCE, WHEN IT CAN BE HAD (#3977) ───────────
        //
        // Every number above is PRE-GC: `process.memoryUsage()` counts garbage
        // V8 has not got round to, which is why "rss never receded" cannot tell
        // cumulative weight from a leak. One forced collection at the end gives
        // the figure that can: what SURVIVED the whole shard.
        //
        // Once, deliberately. Jest will force a GC per file given
        // `--expose-gc` AND `--logHeapUsage` (jest-runner calls
        // `globalThis.gc?.()` only on that path), and measured on one 1/50
        // slice that costs 79% more wall clock — 69 s to 123 s for 61 files —
        // against a 19% lower peak. That trade does not fit a 35-minute shard
        // budget, so this takes one sample rather than 500.
        //
        // `--expose-gc` is in no workflow today, so this line is usually the
        // absence notice. That is the point: it names what the run could not
        // measure instead of leaving the reader to assume the numbers above are
        // the retained set.
        if (typeof globalThis.gc === 'function') {
            globalThis.gc();
            const { heapUsed, rss } = process.memoryUsage();
            lines.push(`  retained (post-GC) ${mb(heapUsed)} heap, ${mb(rss)} rss`);
        } else {
            lines.push('  retained (post-GC) not measured — add --expose-gc to NODE_OPTIONS');
        }
        lines.push('──────────────────────────────────────────────────────────────', '');
        process.stderr.write(lines.join('\n'));
    }
}

module.exports = HeapSummaryReporter;
