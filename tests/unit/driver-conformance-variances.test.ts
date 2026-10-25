/**
 * The variance rule of the driver conformance suite (Step 0b).
 *
 * An engine that cannot satisfy a scenario as written may declare a variance,
 * but only one that names the owner decision accepting it and the stronger
 * property it asserts instead. `describeDriverConformance` runs
 * `checkVariances` as a case of its own, so an adapter that breaks the rule
 * fails the suite. This file proves the rule refuses what it should, and that
 * it accepts a well-formed variance (the positive control).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    ADMISSION_SCENARIOS,
    CONFORMANCE_SCENARIOS,
    checkVariances,
    type ConformanceVariance,
} from '../helpers/driver-conformance';

const noop = () => undefined;

function variance(over: Partial<ConformanceVariance> = {}): ConformanceVariance {
    return {
        scenario: 'ledger-accounts-for-every-call',
        decision: 'a fixture decision, for this test only',
        strongerProperty: 'a fixture property, for this test only',
        assert: noop,
        ...over,
    };
}

describe('a variance must name an owner decision', () => {
    it('accepts a variance that names a decision and a stronger property', () => {
        expect(() => checkVariances([variance()])).not.toThrow();
    });

    it.each([
        ['an empty decision', { decision: '' }],
        ['a blank decision', { decision: '   ' }],
    ])('refuses %s', (_label, over) => {
        expect(() => checkVariances([variance(over)])).toThrow(/names no owner decision/);
    });

    it('refuses a variance that names no stronger property', () => {
        expect(() => checkVariances([variance({ strongerProperty: ' ' })])).toThrow(/names no stronger property/);
    });

    it('refuses a variance for a scenario the table does not have', () => {
        expect(() =>
            checkVariances([variance({ scenario: 'no-such-scenario' as ConformanceVariance['scenario'] })]),
        ).toThrow(/unknown scenario "no-such-scenario"/);
    });

    it('refuses two variances for one scenario', () => {
        expect(() => checkVariances([variance(), variance()])).toThrow(/two variances name/);
    });

    it('checks an admission variance against the admission table, not the run table', () => {
        const admission = { scenario: ADMISSION_SCENARIOS[0].id, decision: 'decision 9', strongerProperty: 'p' };
        expect(() => checkVariances([admission], ADMISSION_SCENARIOS.map((s) => s.id))).not.toThrow();
        expect(() => checkVariances([admission])).toThrow(/unknown scenario/);
    });
});

describe('the suite holds no engine branch', () => {
    // Engine differences live in the adapter. The helper reads the adapter's
    // engine name in exactly two places, both describe titles, and compares it
    // with nothing.
    const source = readFileSync(path.join(__dirname, '../helpers/driver-conformance.ts'), 'utf8');

    it('reads the engine name only to title the two describe blocks', () => {
        const reads = source.match(/\.engine\b/g) ?? [];
        const titles = source.match(/\$\{adapter\.engine\}/g) ?? [];
        expect({ reads: reads.length, titles: titles.length }).toEqual({ reads: 2, titles: 2 });
    });
});

describe('the tables', () => {
    it('give every scenario a distinct id', () => {
        const ids = [...CONFORMANCE_SCENARIOS, ...ADMISSION_SCENARIOS].map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
