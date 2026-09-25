/**
 * A jest run that executed nothing must not read as a clean one (#2897).
 *
 * Every fixture below is REAL output, captured from this repo rather than
 * composed to suit the assertions — including the load failure, which was
 * produced by pointing a throwaway suite at a module that does not exist.
 * A hand-written fixture would prove only that the parser matches the shape I
 * imagined, and the shape I imagined is exactly what went wrong.
 */
import {
    parseJestSummary,
    summaryIsGreen,
    summaryRanSomething,
} from '../helpers/jest-summary';

/** A suite that failed to LOAD. Note the `Tests:` line carries no failure. */
const LOAD_FAILURE = `
Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
`;

/** An ordinary green run: 77 suites from the executor work. */
const CLEAN = `
Test Suites: 77 passed, 77 total
Tests:       1255 passed, 1255 total
Snapshots:   0 total
`;

/**
 * Every test passed and the SUITE still failed — a throw in `afterAll`, or an
 * open handle. Real, and the shape that isolates the suites term: counting
 * only failed tests scores this green.
 */
const SUITE_FAILED_TESTS_PASSED = `
Test Suites: 1 failed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
`;

/**
 * Nothing ran and nothing failed. Synthetic, and labelled as such: this jest
 * prints "No tests found" with no summary at all rather than zeroed counts, so
 * the shape is currently unreachable from the CLI. It is asserted anyway
 * because `summaryIsGreen` is read by harnesses that assemble summaries from
 * other reporters, and a zeroed summary is the one input for which "nothing
 * failed" and "it passed" come apart completely.
 */
const RAN_NOTHING = `
Test Suites: 0 total
Tests:       0 total
`;

/** An ordinary red run: one assertion failed, the suite loaded fine. */
const ASSERTION_FAILURE = `
Test Suites: 1 failed, 1 total
Tests:       1 failed, 7 passed, 8 total
Snapshots:   0 total
`;

describe('a jest summary is read from both count lines', () => {
    it('scores a clean run as green', () => {
        const s = parseJestSummary(CLEAN);
        expect(s).toEqual({
            suitesFailed: 0,
            suitesTotal: 77,
            testsFailed: 0,
            testsTotal: 1255,
        });
        expect(summaryIsGreen(s)).toBe(true);
    });

    it('scores an ordinary assertion failure as red', () => {
        const s = parseJestSummary(ASSERTION_FAILURE);
        expect(s.testsFailed).toBe(1);
        expect(summaryIsGreen(s)).toBe(false);
    });

    // ─── the defect this file exists for ───

    it('refuses to call a suite that never loaded a pass', () => {
        const s = parseJestSummary(LOAD_FAILURE);
        expect(summaryIsGreen(s)).toBe(false);
    });

    it('shows WHY the suites line is required: the tests line reports no failure', () => {
        const s = parseJestSummary(LOAD_FAILURE);

        // This is the whole trap in two assertions. A harness that counts only
        // failed TESTS sees zero here and reports success, for a run in which
        // not one assertion executed.
        expect(s.testsFailed).toBe(0);
        expect(s.suitesFailed).toBe(1);
    });

    it('separates "ran nothing" from "nothing failed"', () => {
        expect(summaryRanSomething(parseJestSummary(LOAD_FAILURE))).toBe(false);
        expect(summaryRanSomething(parseJestSummary(CLEAN))).toBe(true);
    });

    it('reads the summary line, not a summary line quoted in a failure', () => {
        // Jest echoes a failing test's NAME, and a suite that tests a summary
        // parser has fixtures in its names. So the token appears earlier in the
        // output than the real summary does, indented under a bullet. An
        // unanchored needle takes the first match and reports 9 failed suites
        // for a run that had 1. This file is itself such a suite.
        const s = parseJestSummary(`
  ● a jest summary is read from both count lines › Test Suites: 9 failed, 9 total
Test Suites: 1 failed, 1 total
Tests:       2 failed, 3 passed, 5 total
`);
        expect(s.suitesFailed).toBe(1);
        expect(s.testsFailed).toBe(2);
    });

    it('scores a passing-tests/failing-suite run as red', () => {
        const s = parseJestSummary(SUITE_FAILED_TESTS_PASSED);

        // The tests line is spotless. Only the suites line knows.
        expect(s.testsFailed).toBe(0);
        expect(s.suitesFailed).toBe(1);
        expect(summaryIsGreen(s)).toBe(false);
    });

    it('scores a run with zeroed counts as red, not as nothing-failed', () => {
        const s = parseJestSummary(RAN_NOTHING);

        expect(s.suitesFailed).toBe(0);
        expect(s.testsFailed).toBe(0);
        expect(summaryRanSomething(s)).toBe(false);
        expect(summaryIsGreen(s)).toBe(false);
    });

    // ─── refusing to guess ───

    it('throws rather than assume a verdict when a line is missing', () => {
        expect(() => parseJestSummary('Tests: 3 passed, 3 total')).toThrow(/Test Suites/);
        expect(() => parseJestSummary('Test Suites: 1 passed, 1 total')).toThrow(/Tests/);
        // A crashed run summarises nothing at all. Defaulting that to green is
        // how an OOM-killed typecheck reported zero errors.
        expect(() => parseJestSummary('FATAL ERROR: heap out of memory')).toThrow();
    });
});
