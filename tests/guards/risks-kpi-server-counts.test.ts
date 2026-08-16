/**
 * Risks KPI cards read the SERVER count, and the "Open" card filters what it
 * counts.
 *
 * `risksKey` puts the active filters in the SWR key, so `risks` is the
 * current-FILTER result set — and backfill-capped on top. Counting it was
 * wrong in two independent ways, neither needing a large tenant:
 *
 *   `total` displayed the FILTERED length while its click calls clearAll(),
 *   so the number and the click disagreed under any active filter.
 *
 *   `open` counted inside a set that already had `status` applied, while its
 *   click REPLACES that dimension — so under any status filter it read 0.
 *
 * Plus a third, independent of windowing: the card counted OPEN + MITIGATING
 * but applied OPEN alone, so clicking it returned fewer risks than the number
 * on the card promised.
 *
 * Risks was the last of the five peers (Policies #1905, Vendors #1917, Tests
 * #1918, Controls) still counting client-side. The arithmetic itself is
 * covered behaviourally by tests/unit/repositories/RiskRepository.kpi-counts;
 * this file guards the WIRING across the three layers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CLIENT = 'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx';
const REPO = 'src/app-layer/repositories/RiskRepository.ts';
const ROUTE = 'src/app/api/t/[tenantSlug]/risks/route.ts';
const USECASE = 'src/app-layer/usecases/risk.ts';

describe('Risks KPI counts come from the database', () => {
    it('the repository exposes kpiCounts', () => {
        expect(codeOnly(read(REPO))).toMatch(/static async kpiCounts\(/);
    });

    it('the usecase gates it behind the read policy', () => {
        // Every sibling KPI-count usecase asserts before it aggregates; a
        // count is still tenant data.
        const src = codeOnly(read(USECASE));
        const body = src.slice(src.indexOf('export async function listRiskKpiCounts'));
        expect(body.slice(0, 400)).toMatch(/assertCanRead\(ctx\)/);
    });

    it('the route returns them alongside the rows', () => {
        const src = codeOnly(read(ROUTE));
        expect(src).toMatch(/listRiskKpiCounts\(/);
        expect(src).toMatch(/\.\.\.result, kpiCounts/);
    });

    it('the client PREFERS the server counts over the loaded array', () => {
        const src = codeOnly(read(CLIENT));
        expect(src).toMatch(/risksQuery\.data\?\.kpiCounts/);
        // All three cards, not just the one that is easiest to notice.
        expect(src).toMatch(/serverKpis\?\.total \?\?/);
        expect(src).toMatch(/serverKpis\?\.open \?\?/);
        expect(src).toMatch(/serverKpis\?\.avgScore \?\?/);
    });

    it('the "Open" card APPLIES both statuses it counts', () => {
        // The count/filter mismatch, which no amount of server-side counting
        // would fix on its own: widen the filter to the card's own meaning
        // rather than shrinking the count to the filter's.
        const src = codeOnly(read(CLIENT));
        const defs = src.slice(src.indexOf("id: 'open'"));
        const body = defs.slice(0, 600);
        expect(body).toMatch(/ctx\.set\('status', 'OPEN'\)/);
        expect(body).toMatch(/ctx\.add\('status', 'MITIGATING'\)/);
        // and it stays lit only when BOTH are present, so toggling reads true
        expect(body).toMatch(/includes\('OPEN'\)[\s\S]{0,80}includes\('MITIGATING'\)/);
    });
});
