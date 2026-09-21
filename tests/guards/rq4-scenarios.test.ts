/**
 * RQ-4 ratchet — scenario & what-if stays wired: schema + migration (RLS),
 * the pure override/ROI core + simulateScenario reusing RQ-3, the routes,
 * and the scenarios page.
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

describe('RQ-4 scenarios', () => {
    it('RiskScenario schema + migration with RLS', () => {
        expect(readPrismaSchema()).toMatch(/model RiskScenario\b/);
        const mig = 'prisma/migrations/20260610180000_rq4_scenarios/migration.sql';
        expect(exists(mig)).toBe(true);
        expect(readSql(mig)).toMatch(/CREATE POLICY tenant_isolation ON "RiskScenario"/);
    });

    it('the service exposes pure override/ROI core + simulateScenario + CRUD', () => {
        const src = read('src/app-layer/usecases/risk-scenario.ts');
        expect(src).toMatch(/export function applyOverrides/);
        expect(src).toMatch(/export function computeRoi/);
        for (const fn of ['createScenario', 'listScenarios', 'getScenario', 'archiveScenario', 'cloneScenario', 'simulateScenario']) {
            expect(src).toContain(`export async function ${fn}`);
        }
        // reuses RQ-3 engine + RQ-1 calculator
        expect(src).toMatch(/simulatePortfolio/);
        expect(src).toMatch(/computeFairALE/);
    });

    it('the routes + scenarios page exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/scenarios/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/scenarios/[scenarioId]/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/scenarios/[scenarioId]/simulate/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/scenarios/page.tsx')).toBe(true);
    });
});
