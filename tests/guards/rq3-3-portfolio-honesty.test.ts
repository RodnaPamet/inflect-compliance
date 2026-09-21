/**
 * RQ3-3 — "portfolio honesty: stop summing means" ratchet.
 *
 * Regression classes guarded:
 *
 *   - the dashboard headline reverting to Σ(mean ALE) when a
 *     simulation exists: the simulated-run branch must headline
 *     P50/P80/P95 tiles and demote the sum to the subordinate line
 *     with its explanatory tooltip;
 *   - breach detection quietly returning to the naive sum: the pure
 *     check must honour `testedPercentile`, the loader must feed it
 *     the latest run's percentiles, and "approaching" must track the
 *     tested figure;
 *   - stored correlations (RQ-8) silently dropped from the default
 *     simulation path — the headline percentiles must reflect them;
 *   - the schema column / migration / route schema drifting apart.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));

const dashboard = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const appetite = read('src/app-layer/usecases/risk-appetite.ts');
const engine = read('src/app-layer/usecases/monte-carlo.ts');
const route = read('src/app/api/t/[tenantSlug]/risk-appetite/route.ts');
const adminPage = read('src/app/t/[tenantSlug]/(app)/admin/risk-appetite/page.tsx');
const schema = readPrismaSchema();
const migration = readSql('prisma/migrations/20260612020000_rq3_3_tested_percentile/migration.sql');

describe('RQ3-3 — the headline is a distribution, not a sum', () => {
    test('with a run, the quant card headlines P50/P80/P95', () => {
        expect(dashboard).toMatch(/risk-quant-tile-p50/);
        expect(dashboard).toMatch(/risk-quant-tile-p80/);
        expect(dashboard).toMatch(/risk-quant-tile-p95/);
        expect(dashboard).toMatch(/simRun\.portfolioP80/);
    });

    test('the naive Σ is demoted to a subordinate line with the gap tooltip', () => {
        expect(dashboard).toMatch(/risk-quant-sum-line/);
        // copy migrated to next-intl (riskManager.dash.*); resolve it there.
        const dash = (JSON.parse(read('messages/en.json')) as {
            riskManager: { dash: Record<string, string> };
        }).riskManager.dash;
        expect(dash.sumLine).toMatch(/a sum of averages, not a distribution/);
        expect(dash.sumTooltip).toMatch(/Summing each risk's mean ALE ignores correlation/);
        // The Σ tile (headline position) exists ONLY in the no-run branch,
        // which carries the run-a-simulation nudge.
        expect(dashboard).toMatch(/risk-quant-sum-nudge/);
        const sumTileCount = (dashboard.match(/risk-quant-tile-total/g) ?? []).length;
        expect(sumTileCount).toBe(1);
    });
});

describe('RQ3-3 — appetite checks honour the tested percentile', () => {
    test('the pure check takes simulated percentiles and reports what it tested', () => {
        expect(appetite).toMatch(/simulatedPercentiles\?: SimulatedPortfolioPercentiles \| null/);
        expect(appetite).toMatch(/config\.testedPercentile \?\? 80/);
        expect(appetite).toMatch(/portfolioTested/);
    });

    test('the loader feeds the latest run into the check', () => {
        expect(appetite).toMatch(/import \{ getLatestSimulation \} from '\.\/monte-carlo'/);
        expect(appetite).toMatch(/loadSimulatedPercentiles/);
        expect(appetite).toMatch(/detectBreaches\(config, risks, simulated\)/);
    });

    test('"approaching" tracks the tested figure, not the naive sum', () => {
        expect(appetite).toMatch(/result\.portfolioTested\.value > config\.totalAleThreshold \* 0\.8/);
    });

    test('schema + migration + route schema stay paired', () => {
        expect(schema).toMatch(/testedPercentile\s+Int\s+@default\(80\)/);
        expect(migration).toMatch(/ADD COLUMN "testedPercentile" INTEGER NOT NULL DEFAULT 80/);
        expect(route).toMatch(/testedPercentile: z/);
        expect(route).toMatch(/z\.literal\(50\), z\.literal\(80\), z\.literal\(90\), z\.literal\(95\), z\.literal\(99\)/);
    });

    test('the admin page exposes the board-level percentile choice', () => {
        expect(adminPage).toMatch(/appetite-tested-percentile/);
        // "Ceiling tested at:" migrated to next-intl; assert the key + en value
        expect(adminPage).toMatch(/riskAppetite\.ceilingTestedAt/);
        const en = JSON.parse(read('messages/en.json')) as {
            admin: { riskAppetite: Record<string, string> };
        };
        expect(en.admin.riskAppetite.ceilingTestedAt).toMatch(/Ceiling tested at/);
    });
});

describe('RQ3-3 — correlations apply by default', () => {
    test('runSimulation loads stored pairwise correlations when no explicit matrix is given', () => {
        expect(engine).toMatch(/loadStoredCorrelationMatrix/);
        expect(engine).toMatch(/config\.correlationMatrix \?\?/);
        expect(engine).toMatch(/db\.riskCorrelation\.findMany/);
    });
});
