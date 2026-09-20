/**
 * RQ3-9 — Dashboard orchestrator ratchet.
 *
 * Regression classes guarded:
 *
 *   - the dashboard sliding back into a per-widget fetch waterfall
 *     (every widget owning its own `useEffect(fetch(...))` was the
 *     legacy shape; one orchestrated `useTenantSWR` is the new
 *     contract);
 *   - the `score-0-25` ladder coming back to colour the heatmap
 *     (the canonical band resolver is the single source of truth);
 *   - the orchestrator endpoint growing a mutation verb (it is a
 *     pure read fan-out);
 *   - the orchestrator dropping its failure-soft per-slot contract.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const usecase = read('src/app-layer/usecases/risk-dashboard.ts');
const route = read('src/app/api/t/[tenantSlug]/risks/dashboard/route.ts');
const page = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const tone = read('src/lib/design/status-tone.ts');

describe('RQ3-9 — the dashboard page consumes the orchestrator (no waterfall)', () => {
    test('the page uses ONE useTenantSWR on /risks/dashboard', () => {
        expect(page).toMatch(/useTenantSWR<DashboardPayload>/);
        expect(page).toMatch(/['"]\/risks\/dashboard['"]/);
    });

    test('the legacy per-widget fetch waterfall is gone', () => {
        // The dashboard previously fired six `fetch(apiUrl('/risks/coherence'))`-
        // style useEffects. None should remain.
        expect(page).not.toMatch(/fetch\(apiUrl\(['"]\/risks\/coherence['"]\)\)/);
        expect(page).not.toMatch(/fetch\(apiUrl\(['"]\/risks\/staleness['"]\)\)/);
        expect(page).not.toMatch(/fetch\(apiUrl\(['"]\/risk-appetite['"]\)\)/);
        expect(page).not.toMatch(/fetch\(apiUrl\(['"]\/risks\/analytics['"]\)\)/);
        expect(page).not.toMatch(/fetch\(apiUrl\(['"]\/risks\/simulate['"]\)\)/);
    });
});

describe('RQ3-9 — the orchestrator stays a pure read fan-out', () => {
    test('the endpoint is GET-only', () => {
        expect(route).toMatch(/export const GET = withApiErrorHandling/);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(route).not.toMatch(new RegExp(`export const ${verb}`));
        }
    });

    test('all eight slots fan out in parallel via Promise.allSettled', () => {
        expect(usecase).toMatch(/Promise\.allSettled/);
        for (const fn of [
            'listRisks',
            'getRiskQuantitativeAnalytics',
            'getRiskCoherence',
            'getRiskStaleness',
            'getAppetiteConfig',
            'getAppetiteStatus',
            'getLatestSimulation',
            'getRiskMatrixConfig',
        ]) {
            expect(usecase).toMatch(new RegExp(fn + '\\('));
        }
    });

    test('failure-soft per slot: each non-matrix slot maps to null on rejection', () => {
        // The shape is `*Res.status === 'fulfilled' ? *Res.value : null`
        // for every slot EXCEPT matrix (which throws — the heatmap
        // cannot render bandless) and the appetite envelope (which
        // collapses on EITHER side failing).
        expect(usecase).toMatch(/risksRes\.status === 'fulfilled' \? .*risksRes\.value.* : \[\]/);
        expect(usecase).toMatch(/analyticsRes\.status === 'fulfilled' \? analyticsRes\.value : null/);
        expect(usecase).toMatch(/coherenceRes\.status === 'fulfilled' \? coherenceRes\.value : null/);
        expect(usecase).toMatch(/stalenessRes\.status === 'fulfilled' \? stalenessRes\.value : null/);
        expect(usecase).toMatch(/simulationRes\.status === 'fulfilled' \? simulationRes\.value : null/);
        // Appetite envelope: both legs must succeed.
        expect(usecase).toMatch(/appetiteConfigRes\.status === 'fulfilled' && appetiteStatusRes\.status === 'fulfilled'/);
        // Matrix throws on rejection.
        expect(usecase).toMatch(/throw matrixRes\.reason/);
    });
});

describe('RQ3-9 — the score-0-25 ladder is dead', () => {
    test('the StatusScale union no longer carries the score-0-25 member', () => {
        // The string literal must not appear in the union declaration.
        // (It may still appear inside doc comments — we look at the
        // `export type StatusScale` declaration only.)
        const match = tone.match(/export type StatusScale =[\s\S]*?;/);
        expect(match).not.toBeNull();
        expect(match![0]).not.toMatch(/'score-0-25'/);
    });

    test('the heatmap reads the canonical band resolver, not getStatusTone', () => {
        expect(page).toMatch(/resolveBandForScore/);
        expect(page).not.toMatch(/getStatusTone\(s, ['"]score-0-25['"]\)/);
    });
});
