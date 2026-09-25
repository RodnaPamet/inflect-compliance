/**
 * Reading a jest run's verdict without being lied to (#2897).
 *
 * Jest prints two count lines adjacently and BOTH match a naive `N failed`
 * needle, so a harness that greps for the first one reads SUITES where it meant
 * tests. The worse failure is the opposite: a suite that fails to LOAD prints
 *
 *     Test Suites: 1 failed, 1 total
 *     Tests:       0 total
 *
 * — no `N failed` group on the `Tests:` line at all. A harness that counts
 * failed TESTS therefore scores a suite which never executed a single
 * assertion as zero failures, which is indistinguishable from a clean pass.
 *
 * That is not a hypothetical either. It is how a new suite reported success
 * three times while failing to load from a mock that was a subset of the real
 * module, and how a mutation that never applied was read as a mutation the
 * guard survived.
 *
 * So: parse both lines, refuse to guess when either is missing, and treat "ran
 * nothing" as its own answer rather than folding it into "nothing failed".
 */

export interface JestSummary {
    readonly suitesFailed: number;
    readonly suitesTotal: number;
    readonly testsFailed: number;
    readonly testsTotal: number;
}

/** Pull `N failed` and `N total` out of one summary line. */
function counts(output: string, label: 'Test Suites' | 'Tests'): { failed: number; total: number } {
    // Anchored at line start so the `Tests:` pattern cannot match inside
    // `Test Suites:`, which shares its prefix.
    const line = new RegExp(`^${label}:[^\\n]*`, 'm').exec(output)?.[0];
    if (!line) {
        throw new Error(
            `no "${label}:" line in the jest output — the run may have crashed before summarising. ` +
                'Refusing to report a verdict rather than assuming a clean one.',
        );
    }
    const failed = /(\d+) failed/.exec(line);
    const total = /(\d+) total/.exec(line);
    if (!total) throw new Error(`malformed "${label}:" line: ${line}`);
    return { failed: failed ? Number(failed[1]) : 0, total: Number(total[1]) };
}

export function parseJestSummary(output: string): JestSummary {
    const suites = counts(output, 'Test Suites');
    const tests = counts(output, 'Tests');
    return {
        suitesFailed: suites.failed,
        suitesTotal: suites.total,
        testsFailed: tests.failed,
        testsTotal: tests.total,
    };
}

/**
 * Did this run actually execute assertions?
 *
 * Separate from "did anything fail", because the two are genuinely different
 * facts and collapsing them is the whole defect above. A run that executed
 * nothing proves nothing — it is not a pass.
 */
export function summaryRanSomething(s: JestSummary): boolean {
    return s.suitesTotal > 0 && s.testsTotal > 0;
}

/** Green means: something ran, no suite failed to load, and no test failed. */
export function summaryIsGreen(s: JestSummary): boolean {
    return summaryRanSomething(s) && s.suitesFailed === 0 && s.testsFailed === 0;
}
