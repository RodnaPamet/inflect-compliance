/**
 * Behavioural contract of the count-ratchet drift sentinel
 * (`tests/helpers/ratchet-slack.ts`).
 *
 * The regression this guards against is not a shape but a behaviour: a
 * count ratchet whose baseline sits above the live tree keeps passing
 * while the gap between them is spendable headroom. `raw-color-ratchet`
 * carried 44 units of it for months of green CI. Every assertion below
 * is a boundary of "does the sentinel actually fire", so weakening the
 * helper — widening the comparison, returning `null` unconditionally,
 * swallowing the throw — turns this file red rather than turning four
 * ratchets quietly permissive.
 */
import * as fs from 'fs';
import * as path from 'path';

import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

const base = { constantName: 'BASELINE', allowance: 5 } as const;

describe('ratchet drift sentinel', () => {
    it('is silent when the baseline is seated exactly on the live count', () => {
        expect(ratchetSlackFailure({ ...base, baseline: 51, count: 51 })).toBeNull();
    });

    it('is silent at the allowance boundary, and fires one unit past it', () => {
        // slack === allowance → tolerated (in-flight work).
        expect(ratchetSlackFailure({ ...base, baseline: 56, count: 51 })).toBeNull();
        // slack === allowance + 1 → reported.
        expect(ratchetSlackFailure({ ...base, baseline: 57, count: 51 })).not.toBeNull();
    });

    it('fires on the drift that actually happened (95 against a live 51)', () => {
        const failure = ratchetSlackFailure({ ...base, baseline: 95, count: 51 });
        expect(failure).not.toBeNull();
        // The message must carry the numbers a reader needs to re-seat the
        // constant, not just say "failed".
        expect(failure).toContain('51');
        expect(failure).toContain('95');
        expect(failure).toContain('44');
        expect(failure).toContain('BASELINE');
    });

    it('stays silent when the count is ABOVE the baseline', () => {
        // That is a real regression, and it belongs to the ratchet's own
        // `count <= baseline` assertion, which can list the offending
        // sites. A sentinel that also fired here would double-report and
        // bury the useful message.
        expect(ratchetSlackFailure({ ...base, baseline: 51, count: 60 })).toBeNull();
    });

    it('names the constant it was given, so the failure points at the right line', () => {
        const failure = ratchetSlackFailure({
            constantName: 'BORDER_DEFAULT_BUDGET',
            baseline: 200,
            count: 111,
            allowance: 10,
        });
        expect(failure).toContain('BORDER_DEFAULT_BUDGET');
        expect(failure).not.toContain('BASELINE ');
    });

    it('assertRatchetSlack throws exactly when the reporting form is non-null', () => {
        expect(() => assertRatchetSlack({ ...base, baseline: 57, count: 51 })).toThrow(
            /unspent slack/i,
        );
        expect(() => assertRatchetSlack({ ...base, baseline: 56, count: 51 })).not.toThrow();
    });
});

/**
 * The allowance is the only knob that can neuter a sentinel.
 *
 * A baseline cannot be quietly raised — raising it widens the slack,
 * which is exactly what the sentinel measures. So when a sentinel goes
 * red, the cheapest path back to green is to widen its
 * `DRIFT_ALLOWANCE` rather than re-seat the baseline. That is the same
 * move that let these four ratchets decay in the first place, and left
 * unchecked it turns every sentinel above into decoration.
 *
 * Two things are asserted per adopting guard: that it still routes
 * through the shared helper at all (a deleted sentinel and a passing
 * one look identical from the outside), and that its allowance stays
 * in a range where it can still catch a real drift.
 */
describe('adopting ratchets keep their sentinel meaningful', () => {
    // Widest allowance any ratchet may declare. Five is the model
    // sentinel's tolerance in `no-explicit-any-ratchet.test.ts`, and it
    // sits against a count in the hundreds; every guard below counts far
    // fewer sites, so five is already generous. Raising this cap
    // re-opens the headroom the sentinels exist to close — re-seat the
    // baseline instead.
    const MAX_ALLOWANCE = 5;

    const ADOPTERS = [
        'guardrails/raw-color-ratchet.test.ts',
        'guardrails/table-platform-drift.test.ts',
        'guards/epic52-datatable-ratchet.test.ts',
        'guards/border-tone-budget.test.ts',
    ] as const;

    const readAdopter = (rel: string) =>
        fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');

    it.each(ADOPTERS)('%s routes through the shared sentinel', (rel) => {
        const src = readAdopter(rel);
        expect(src).toContain("from '../helpers/ratchet-slack'");
        expect(src).toContain('assertRatchetSlack(');
    });

    it.each(ADOPTERS)('%s declares an allowance that can still catch drift', (rel) => {
        const src = readAdopter(rel);
        const declared = [
            ...src.matchAll(/^\s*(?:const|let)\s+\w*DRIFT_ALLOWANCE\s*=\s*(\d+)\s*;/gm),
        ].map(([, value]) => Number(value));

        // An absence is ambiguous: with zero matches a `for` loop of
        // assertions passes while checking nothing.
        expect(declared.length).toBeGreaterThan(0);

        for (const value of declared) {
            expect(value).toBeLessThanOrEqual(MAX_ALLOWANCE);
            expect(value).toBeGreaterThanOrEqual(0);
        }
    });
});
