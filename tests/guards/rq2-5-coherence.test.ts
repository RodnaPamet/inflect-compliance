/**
 * RQ2-5 — qual ↔ quant coherence ratchet.
 *
 * The bridge between the two risk languages only works while every
 * surface keeps speaking both. Regression classes guarded:
 *
 *   - the list / detail ALE chips silently disappearing (the
 *     side-by-side display IS the feature);
 *   - the matrix overlay losing its zero-cost guarantee (toggle
 *     rendering without ALE data, or overlay state leaking into
 *     count mode);
 *   - the detector drifting off the rank-based contract (absolute
 *     thresholds would make it currency-scale-dependent);
 *   - the coherence endpoint growing a mutation verb.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const lib = read('src/lib/risk-coherence.ts');
const usecase = read('src/app-layer/usecases/risk-analytics.ts');
const route = read('src/app/api/t/[tenantSlug]/risks/coherence/route.ts');
const risksClient = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
const riskDetail = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const dashboard = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const dashboardOrchestrator = read('src/app-layer/usecases/risk-dashboard.ts');
const matrix = read('src/components/risks/RiskMatrix.tsx');
const matrixCell = read('src/components/risks/RiskMatrixCell.tsx');
const repo = read('src/app-layer/repositories/RiskRepository.ts');

describe('RQ2-5 — both languages on every surface', () => {
    test('the list select ships the quant inputs and the score cell renders the ALE chip', () => {
        for (const f of ['sleAmount: true', 'aroAmount: true', 'fairAle: true']) {
            expect(repo).toContain(f);
        }
        expect(risksClient).toMatch(/riskAle\(row\.original\)/);
        expect(risksClient).toMatch(/formatCompactCurrency/);
    });

    test('the detail header carries the ALE next to the score chip', () => {
        expect(riskDetail).toMatch(/resolveALE\(/);
        // ALE header label migrated to next-intl; assert the key + en value
        expect(riskDetail).toMatch(/label: t\('detail\.ale'\)/);
        const en = JSON.parse(read('messages/en.json')) as { risks: { detail: Record<string, string> } };
        expect(en.risks.detail.ale).toBe('ALE');
    });

    test('the dashboard mounts the coherence widget behind the min-quantified gate', () => {
        // RQ3-9 — the dashboard now reads from the orchestrator
        // (`/risks/dashboard`) rather than firing its own
        // `/risks/coherence` fetch. The widget still renders from
        // the `coherence` slot of the payload; the orchestrator
        // pulls it via getRiskCoherence on the server.
        expect(dashboardOrchestrator).toMatch(/getRiskCoherence/);
        expect(dashboard).toMatch(/coherence\.quantifiedCount >= coherence\.minRequired/);
        expect(dashboard).toMatch(/risk-coherence-widget/);
    });
});

describe('RQ2-5 — detector contract', () => {
    test('rank-based, not absolute-threshold-based', () => {
        expect(lib).toMatch(/percentileRanks/);
        expect(lib).toMatch(/MIN_QUANTIFIED_FOR_COHERENCE = 4/);
        expect(lib).toMatch(/HIGH_QUARTILE = 0\.75/);
        expect(lib).toMatch(/LOW_QUARTILE = 0\.25/);
    });

    test('only quantified risks participate (ale !== null filter)', () => {
        expect(lib).toMatch(/r\.ale !== null/);
    });

    test('the usecase routes through resolveALE (FAIR over legacy) and the pure detector', () => {
        expect(usecase).toMatch(/detectIncoherence/);
        const block = usecase.slice(usecase.indexOf('export async function getRiskCoherence'));
        expect(block).toMatch(/resolveALE\(/);
        expect(block).toMatch(/deletedAt: null/);
    });

    test('the coherence endpoint stays GET-only', () => {
        expect(route).toMatch(/export const GET = withApiErrorHandling/);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(route).not.toMatch(new RegExp(`export const ${verb}`));
        }
    });
});

describe('RQ2-5 — matrix overlay zero-cost guarantee', () => {
    test('the toggle renders only when a cell carries ALE data', () => {
        expect(matrix).toMatch(/hasAleData && \(/);
        expect(matrix).toMatch(/maxCellAle > 0/);
    });

    test('the overlay is opt-in state, never the default paint', () => {
        expect(matrix).toMatch(/useState\(false\)[\s\S]{0,400}aleOverlay && hasAleData/);
        // Count-mode paint stays the classic 0.92 when the overlay is off.
        expect(matrixCell).toMatch(/aleOverlay\s*\?[\s\S]{0,120}:\s*0\.92/);
    });

    test('the cell announces ALE to assistive tech when the overlay is on', () => {
        expect(matrixCell).toMatch(/annualised loss expectancy/);
    });
});
