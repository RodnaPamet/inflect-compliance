/**
 * RQ-8 ratchet — correlation stays wired: model + migration (RLS), the
 * pure Cholesky/correlated-sampling (monte-carlo) + PSD/CRUD/suggest
 * service, the routes, and the matrix page.
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

describe('RQ-8 correlation', () => {
    it('RiskCorrelation model + migration with RLS', () => {
        expect(readPrismaSchema()).toMatch(/model RiskCorrelation/);
        const mig = 'prisma/migrations/20260610240000_rq8_correlation/migration.sql';
        expect(exists(mig)).toBe(true);
        expect(readSql(mig)).toMatch(/CREATE POLICY tenant_isolation ON "RiskCorrelation"/);
    });

    it('monte-carlo exposes Cholesky + correlated-uniform sampling', () => {
        const src = read('src/app-layer/usecases/monte-carlo.ts');
        expect(src).toMatch(/export function choleskyDecompose/);
        expect(src).toMatch(/export function generateCorrelatedUniforms/);
        expect(src).toMatch(/correlationMatrix/);
        // RQ-8 follow-up: correlated path samples the FULL FAIR factor set.
        expect(src).toMatch(/export function sampleFairALEFromUniform/);
        expect(src).toMatch(/sampleFairALEFromUniform\(risk\.distributions/);
    });

    it('the service exposes PSD + CRUD + suggestions', () => {
        const src = read('src/app-layer/usecases/risk-correlation.ts');
        expect(src).toMatch(/export function validatePSD/);
        expect(src).toMatch(/export function computeSuggestions/);
        for (const fn of ['setCorrelation', 'removeCorrelation', 'getCorrelationMatrix', 'suggestCorrelations']) {
            expect(src).toContain(`export async function ${fn}`);
        }
    });

    it('the routes + matrix page exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/correlations/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/correlations/suggest/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/correlations/page.tsx')).toBe(true);
    });
});
