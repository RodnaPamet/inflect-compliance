/**
 * B10 — Advanced analytics ratchet.
 *
 *   1. Risk schema carries the two quantitative-input columns:
 *      `sleAmount Float?` + `aroAmount Float?`. ALE is derived;
 *      no third column.
 *   2. Migration `20260524180000_b10_risk_quantitative` declares
 *      both `ADD COLUMN` statements with `DOUBLE PRECISION`.
 *   3. Analytics usecase exists at the canonical path, asserts
 *      read permission, and emits the documented shape (totals +
 *      topByAle + byCategory + coverageSketch — the latter renamed
 *      from `lecPoints` by the RQ3-1 demotion: it is a rank-based
 *      coverage statement, not a loss distribution).
 *   4. The API route `GET /api/t/<slug>/risks/analytics`
 *      delegates to the usecase.
 *   5. The `<LossExceedanceCurve>` chart primitive exists and is
 *      re-exported via the chart barrel.
 *   6. Risk dashboard mounts the quantitative analytics block
 *      gated on `analytics.totals.quantifiedCount > 0`. RQ3-1:
 *      the dashboard's loss exceedance curve is the SIMULATED one
 *      inside MonteCarloPanel — see
 *      `tests/guards/rq3-1-simulated-lec.test.ts` for that ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B10 — advanced analytics', () => {
    describe('Schema + migration', () => {
        const compliance = readPrismaSchema();
        const migration = read(
            'prisma/migrations/20260524180000_b10_risk_quantitative/migration.sql',
        );

        it('Risk model declares sleAmount + aroAmount as Float?', () => {
            expect(compliance).toMatch(/^\s*sleAmount\s+Float\?/m);
            expect(compliance).toMatch(/^\s*aroAmount\s+Float\?/m);
        });

        it('migration adds both columns as DOUBLE PRECISION', () => {
            expect(migration).toMatch(
                /ALTER TABLE "Risk" ADD COLUMN "sleAmount" DOUBLE PRECISION/,
            );
            expect(migration).toMatch(
                /ALTER TABLE "Risk" ADD COLUMN "aroAmount" DOUBLE PRECISION/,
            );
        });

        it('does NOT store a derived ALE column', () => {
            // ALE is computed at read time. Storing a derived
            // column would require maintaining the `null OR
            // sleAmount * aroAmount` invariant in every write path.
            expect(compliance).not.toMatch(/^\s*aleAmount\s+Float/m);
        });
    });

    describe('Analytics usecase', () => {
        const src = read('src/app-layer/usecases/risk-analytics.ts');

        it('exports getRiskQuantitativeAnalytics', () => {
            expect(src).toMatch(
                /export async function getRiskQuantitativeAnalytics/,
            );
        });

        it('asserts read permission before touching the DB', () => {
            expect(src).toMatch(/assertCanRead\(ctx\)/);
        });

        it('emits the documented shape — totals + topByAle + byCategory + coverageSketch', () => {
            expect(src).toMatch(/totals:/);
            expect(src).toMatch(/topByAle:/);
            expect(src).toMatch(/byCategory:/);
            expect(src).toMatch(/coverageSketch:/);
        });

        it('top-N is capped to 10 entries', () => {
            expect(src).toMatch(/const TOP_N = 10/);
            expect(src).toMatch(/\.slice\(0,\s*TOP_N\)/);
        });

        it('quantified subset resolves ALE (RQ-1: FAIR ALE → legacy SLE×ARO → null)', () => {
            // RQ-1 replaced the inline `r.sleAmount != null && r.aroAmount != null`
            // filter with the unified `resolveALE` resolver, which prefers the
            // stored FAIR ALE and falls back to legacy SLE×ARO. A risk is in the
            // quantified subset iff resolveALE yields a finite value.
            expect(src).toMatch(/resolveALE\(\{[\s\S]*?sleAmount[\s\S]*?aroAmount/);
            expect(src).toMatch(/ale\s*!=\s*null\s*&&\s*isFinite\(ale\)/);
        });
    });

    describe('API route', () => {
        const src = read(
            'src/app/api/t/[tenantSlug]/risks/analytics/route.ts',
        );

        it('is a GET handler delegating to the usecase', () => {
            expect(src).toMatch(/export const GET/);
            expect(src).toMatch(/getRiskQuantitativeAnalytics\(ctx\)/);
        });
    });

    describe('LossExceedanceCurve primitive', () => {
        const src = read(
            'src/components/ui/charts/loss-exceedance-curve.tsx',
        );
        const barrel = read('src/components/ui/charts/index.ts');

        it('exports the primitive + the props/point types', () => {
            expect(src).toMatch(/export function LossExceedanceCurve/);
            expect(src).toMatch(
                /export interface LossExceedanceCurveProps/,
            );
            expect(src).toMatch(/export interface LossExceedancePoint/);
        });

        it('uses visx scaleLinear + LinePath + Area (advanced chart)', () => {
            expect(src).toMatch(/scaleLinear/);
            expect(src).toMatch(/LinePath/);
            expect(src).toMatch(/Area/);
            // curveStepAfter — the LEC's discrete-step interpolation.
            expect(src).toMatch(/curveStepAfter/);
        });

        it('paints through the token-backed chart-series colour', () => {
            // Token-based theming — the LossExceedanceCurve consumes
            // `--chart-series-1` so a future re-theme works without
            // touching the primitive. Hex fallback only.
            expect(src).toMatch(/--chart-series-1/);
        });

        it('is re-exported via the chart barrel', () => {
            expect(barrel).toMatch(/export\s*\{\s*LossExceedanceCurve\s*\}/);
        });
    });

    describe('Risk dashboard adoption', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx',
        );
        const orchestrator = read(
            'src/app-layer/usecases/risk-dashboard.ts',
        );

        it('fetches analytics via the RQ3-9 orchestrator (single batched read)', () => {
            // RQ3-9 — the page no longer fires its own
            // `/risks/analytics` fetch. The orchestrator pulls
            // analytics via getRiskQuantitativeAnalytics and the
            // dashboard reads it from the `analytics` slot of the
            // payload.
            expect(orchestrator).toMatch(/getRiskQuantitativeAnalytics/);
            expect(src).toMatch(/data\?\.analytics/);
        });

        it('gates the analytics block on quantifiedCount > 0', () => {
            expect(src).toMatch(
                /analytics\.totals\.quantifiedCount\s*>\s*0/,
            );
        });

        it('keeps the analytics card + mounts the simulated LEC stage (RQ3-1)', () => {
            expect(src).toMatch(/data-testid="risk-quant-analytics"/);
            // RQ3-1 — the page no longer renders a rank-based curve;
            // the simulated LEC lives in MonteCarloPanel, which gets
            // the appetite payload for its threshold lines.
            expect(src).toMatch(/<MonteCarloPanel appetite=\{appetite\}/);
            expect(src).not.toMatch(/<LossExceedanceCurve\b/);
        });
    });
});
