/**
 * An age-bounded fixture must not carry a FIXED instant.
 *
 * WHY THIS EXISTS
 * ---------------
 * `resolveWriteTarget` bounds `onPremStateObservedAt` by `OBSERVATION_FRESHNESS_MS`
 * against the wall clock, and `disableAccount` injects no `now`. So a test that
 * seeds that column with a literal instant does not assert a behaviour — it
 * asserts a behaviour *until a date*, and then reverses.
 *
 * This is not hypothetical. `new Date('2026-08-26T02:00:00.000Z')` was green when
 * #2158 merged at 2026-08-27T22:54Z and had taken main red by 02:00Z the next
 * morning: three unit failures, in a Test shard, with **no diff between the green
 * commit and the red one**. Nothing in CI can catch that, because the commit that
 * introduces the fuse passes every check — the clock is the only input that moved.
 *
 * The guard is deliberately narrow: one column, one shape. It asks whether a
 * fixture for an age-bounded field was written as a fixed point in time, which a
 * regex can answer exactly. It makes no claim about any other date literal in the
 * suite, most of which are correct precisely BECAUSE they are fixed.
 */
import * as fs from 'fs';
import { repoFiles, repoRelative } from '../helpers/repo-files';

/**
 * Columns whose meaning is "how long ago", so a literal expires.
 *
 * Add a field here when it becomes age-bounded — that is the same diff that
 * introduces the hazard.
 */
const AGE_BOUNDED_FIELDS = ['onPremStateObservedAt'] as const;

/** `new Date('…')` / `new Date("…")` — a fixed instant. Not `new Date(expr)`. */
const FIXED_INSTANT = String.raw`new Date\(\s*['"]`;

describe('a fixture for an age-bounded column is relative, never a fixed instant', () => {
    const testFiles = repoFiles({ under: 'tests', extensions: ['.ts', '.tsx'] });

    it.each(AGE_BOUNDED_FIELDS)('%s is never seeded with a literal date', (field) => {
        // Same line, or the line immediately after — covers both
        // `x: new Date('…')` and a wrapped `x:\n    new Date('…')`.
        const offenders: string[] = [];

        for (const abs of testFiles) {
            if (abs.endsWith('observation-clock-is-relative.test.ts')) continue;
            const lines = fs.readFileSync(abs, 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (!line.includes(field)) return;
                const window = `${line}\n${lines[i + 1] ?? ''}`;
                if (new RegExp(FIXED_INSTANT).test(window)) {
                    offenders.push(`${repoRelative(abs)}:${i + 1}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    it('the detector actually fires — a fixed instant is caught', () => {
        // Without this the assertion above is satisfied by a regex that matches
        // nothing, which is the failure mode a "no offenders" test cannot tell
        // apart from success.
        const sample = `            onPremStateObservedAt: new Date('2026-08-26T02:00:00.000Z'),`;
        expect(new RegExp(FIXED_INSTANT).test(sample)).toBe(true);
        expect(sample.includes(AGE_BOUNDED_FIELDS[0])).toBe(true);
    });

    it('a relative seed is NOT caught', () => {
        const sample = `            onPremStateObservedAt: new Date(Date.now() - 60 * 60 * 1000),`;
        expect(new RegExp(FIXED_INSTANT).test(sample)).toBe(false);
    });

    it('scans a real population', () => {
        // An empty file list would make every assertion above vacuous.
        expect(testFiles.length).toBeGreaterThan(500);
    });
});
