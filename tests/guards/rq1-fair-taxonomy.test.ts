/**
 * RQ-1 ratchet — FAIR taxonomy must stay wired: the calculator core, the
 * Risk schema columns + enum + migration, the recompute usecase + route,
 * the analytics resolveALE switch, and the detail-page panel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('RQ-1 FAIR taxonomy', () => {
    it('the calculator exposes the FAIR ontology + resolver', () => {
        // B2-4 — the FAIR maths moved to src/lib/fair-math.ts so client
        // components stop value-importing a usecase module; the path in
        // app-layer is now a re-export shim.
        const src = read('src/lib/fair-math.ts');
        for (const fn of ['computeLEF', 'computePLM', 'computeFairALE', 'computeTEF', 'computeVulnerability', 'sampleFairALE', 'pointToPert', 'resolveALE', 'seededRng']) {
            expect(src).toContain(`export function ${fn}`);
        }
    });

    it('Risk schema carries the FAIR columns + FairConfidence enum + migration', () => {
        const schema = readPrismaSchema();
        for (const col of ['threatEventFrequency', 'vulnerabilityProbability', 'primaryLossMagnitude', 'secondaryLossMagnitude', 'lossEventFrequency', 'fairAle', 'fairInputsJson']) {
            expect(schema).toMatch(new RegExp(col));
        }
        expect(read('prisma/schema/enums.prisma')).toMatch(/enum FairConfidence/);
        expect(exists('prisma/migrations/20260610120000_rq1_fair_taxonomy/migration.sql')).toBe(true);
    });

    it('updateRiskFair recomputes derived fields + analytics uses resolveALE', () => {
        const risk = read('src/app-layer/usecases/risk.ts');
        expect(risk).toMatch(/export async function updateRiskFair/);
        expect(risk).toMatch(/recomputeFairDerived/);
        expect(read('src/app-layer/usecases/risk-analytics.ts')).toMatch(/resolveALE/);
    });

    it('the FAIR route + detail-page panel exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/[id]/fair/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/[riskId]/FairAnalysisPanel.tsx')).toBe(true);
        expect(read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx')).toMatch(/FairAnalysisPanel/);
    });
});
