/**
 * RQ-3 ratchet — Monte Carlo engine stays wired: schema + migration (with
 * RLS), the pure simulation core + PRNG + PERT sample, the run+latest
 * service, the route, and the dashboard panel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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
const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const readSql = (p: string) => sqlCodeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('RQ-3 Monte Carlo', () => {
    it('RiskSimulationRun schema + migration with RLS', () => {
        expect(readPrismaSchema()).toMatch(/model RiskSimulationRun/);
        const mig = 'prisma/migrations/20260610160000_rq3_monte_carlo/migration.sql';
        expect(exists(mig)).toBe(true);
        expect(readSql(mig)).toMatch(/CREATE POLICY tenant_isolation ON "RiskSimulationRun"/);
    });

    it('the engine exposes the simulation core + PRNG + PERT sample', () => {
        const src = read('src/app-layer/usecases/monte-carlo.ts');
        expect(src).toMatch(/export function simulatePortfolio/);
        expect(src).toMatch(/export function samplePert/);
        expect(src).toMatch(/export const createPRNG/);
        expect(src).toMatch(/export async function runSimulation/);
        expect(src).toMatch(/export async function getLatestSimulation/);
        // reuses RQ-1's sampler
        expect(src).toMatch(/sampleFairALE/);
    });

    it('the route + dashboard panel exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/simulate/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/dashboard/MonteCarloPanel.tsx')).toBe(true);
        expect(read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx')).toMatch(/MonteCarloPanel/);
    });
});
