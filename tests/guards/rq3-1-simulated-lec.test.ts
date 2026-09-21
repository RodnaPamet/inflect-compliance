/**
 * RQ3-1 — "one LEC: the simulated curve takes the stage" ratchet.
 *
 * Regression classes guarded:
 *
 *   - the rank-based coverage sketch sneaking back onto the
 *     dashboard dressed as a loss exceedance curve (the original
 *     sin this PR removed): the dashboard page must not consume
 *     `coverageSketch` / `lecPoints` and must not mount a
 *     `<LossExceedanceCurve>` of its own — the only LEC is the
 *     simulated one inside MonteCarloPanel;
 *   - the analytics usecase losing its demotion disclaimer, or the
 *     payload field reverting to the curve-implying `lecPoints`
 *     name;
 *   - the per-risk tail-percentile cache (the RQ3-3/-4/-10 data
 *     spine) losing a percentile, the schema column, or the
 *     retrieval helper;
 *   - the simulated curve dropping its percentile markers or the
 *     appetite carry-over.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file, not
// assumed from the directory it lives in.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));
const dashboard = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const mcPanel = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/MonteCarloPanel.tsx');
const analytics = read('src/app-layer/usecases/risk-analytics.ts');
// The DELIBERATE raw twin (#2246). This file's own test draws the line:
// "the docstring may reference the history; the SHAPE may not" — so the shape
// assertions read MASKED and the demotion disclaimer, whose entire subject is
// the docstring, reads RAW. Masked, that disclaimer could never pass again.
const analyticsDoc = readRaw('src/app-layer/usecases/risk-analytics.ts');
const engine = read('src/app-layer/usecases/monte-carlo.ts');
const schema = readPrismaSchema();
const migration = readSql('prisma/migrations/20260612000000_rq3_1_simulation_p80/migration.sql');

describe('RQ3-1 — the simulated curve is the only dashboard LEC', () => {
    test('the dashboard page renders no rank-based curve', () => {
        expect(dashboard).not.toMatch(/lecPoints/);
        expect(dashboard).not.toMatch(/coverageSketch/);
        expect(dashboard).not.toMatch(/<LossExceedanceCurve\b/);
        expect(dashboard).not.toMatch(/LossExceedanceCurve\s*\}?\s*from/);
    });

    test('the simulated stage is mounted with the appetite payload', () => {
        // B3-2: this asserted `<MonteCarloPanel appetite={appetite}` — the
        // prop had to be FIRST, so adding any prop before it failed the
        // build. Assert the mount and the prop independently; JSX attribute
        // order carries no meaning.
        expect(dashboard).toMatch(/<MonteCarloPanel\b/);
        expect(dashboard).toMatch(/appetite=\{appetite\}/);
    });

    test('the analytics payload carries the demoted sketch under its honest name', () => {
        expect(analytics).toMatch(/coverageSketch:/);
        // The field must not revert to the curve-implying name (the
        // docstring may reference the history; the SHAPE may not).
        expect(analytics).not.toMatch(/lecPoints:/);
        // The demotion disclaimer — a future "simplify the docstring"
        // PR must not erase the reason the sketch is not an LEC.
        expect(analyticsDoc).toMatch(/NOT a\s+\*?\s*simulated loss distribution/);
        expect(analytics).toMatch(/CoverageSketchPoint/);
    });
});

describe('RQ3-1 — per-risk tail-percentile cache (the RQ3 data spine)', () => {
    test('the engine samples and emits the per-risk tail trio', () => {
        for (const k of ['aleP50', 'aleP90', 'aleP95']) {
            expect(engine).toContain(`${k},`);
            expect(engine).toMatch(new RegExp(`${k} = percentile\\(s, 0\\.\\d+\\)`));
        }
    });

    test('VaR-80 is computed and persisted alongside the existing percentiles', () => {
        expect(engine).toMatch(/p80: percentile\(sorted, 0\.8\)/);
        expect(engine).toMatch(/portfolioP80: result\.portfolioAle\.p80/);
        expect(schema).toMatch(/^\s*portfolioP80\s+Float\?/m);
        expect(migration).toMatch(/ADD COLUMN "portfolioP80" DOUBLE PRECISION/);
    });

    test('the retrieval helper exists and delegates to the shared parse', () => {
        expect(engine).toMatch(/export async function getPerRiskPercentiles/);
        expect(engine).toMatch(/export interface PerRiskPercentilesSnapshot/);
        // B2-6 — the mean-fallback used to be inlined here and was pinned by
        // two source regexes. It now lives in `@/lib/risk/per-risk-results`,
        // shared with the report + board reads that had their own weaker
        // copies, and is covered BEHAVIOURALLY by
        // `tests/unit/risks/per-risk-results.test.ts` (which mutation-testing
        // confirms fails when the fallback is removed — the source regex
        // could only ever prove the characters were present).
        expect(engine).toMatch(/parsePerRiskResults\(run\.perRiskResultsJson\)/);
    });
});

describe('RQ3-1 — the simulated curve carries its markers', () => {
    test('P50 / P80 / P95 percentile markers ride the referenceLines seam', () => {
        expect(mcPanel).toMatch(/label: 'P50'/);
        expect(mcPanel).toMatch(/label: 'P80'/);
        expect(mcPanel).toMatch(/label: 'P95'/);
        expect(mcPanel).toMatch(/portfolioP80/);
    });

    test('the appetite carry-over renders the breach probability off the curve', () => {
        expect(mcPanel).toMatch(/exceedanceProbabilityAt/);
        expect(mcPanel).toMatch(/lec-portfolio-appetite-note/);
        expect(mcPanel).toMatch(/mc-per-risk-appetite-note/);
        // The per-risk note reads the cached P90, not the mean alone.
        expect(mcPanel).toMatch(/r\.aleP90 \?\? r\.aleMean/);
    });
});
