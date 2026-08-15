/**
 * Controls KPI cards read the SERVER count, not the loaded array.
 *
 * `controlsKey` puts the active filters in the SWR key, so `controls` is the
 * current-FILTER result set — and backfill-capped on top. Counting it was
 * wrong in two independent ways, neither needing a large tenant:
 *
 *   `total` displayed the FILTERED length while its click calls clearAll().
 *   With Owner=Alice set the card read 12 and the click returned the whole
 *   register.
 *
 *   the status cards counted inside a set that already had `status` applied,
 *   while their click REPLACES that dimension. Under any active status filter
 *   two of the three read 0 permanently.
 *
 * This is the fourth surface in the same class (Policies #1905, Vendors
 * #1917, Tests #1918) and the last of the peers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CLIENT = 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx';
const REPO = 'src/app-layer/repositories/ControlRepository.ts';
const ROUTE = 'src/app/api/t/[tenantSlug]/controls/route.ts';

describe('Controls KPI counts come from the database', () => {
    it('the repository exposes kpiCounts', () => {
        expect(codeOnly(read(REPO))).toMatch(/static async kpiCounts\(/);
    });

    it('it counts the TENANT for total, not the filtered set', () => {
        // `total`'s click is clearAll(), so its number must ignore filters.
        const src = codeOnly(read(REPO));
        const body = src.slice(src.indexOf('static async kpiCounts('));
        expect(body.slice(0, 2600)).toMatch(/db\.control\.count\(\{[\s\S]{0,200}tenantId: ctx\.tenantId/);
    });

    it('the status buckets group over the OTHER filters, dropping status', () => {
        const src = codeOnly(read(REPO));
        const body = src.slice(src.indexOf('static async kpiCounts('));
        // The status cards REPLACE that dimension, so it must not constrain
        // the groupBy — this is the half that made two cards read 0.
        expect(body.slice(0, 2600)).toMatch(/\.\.\.filters, status: undefined/);
        expect(body.slice(0, 2600)).toMatch(/groupBy\(\{[\s\S]{0,120}by: \['status'\]/);
    });

    it('the route returns them alongside the rows', () => {
        const src = codeOnly(read(ROUTE));
        expect(src).toMatch(/listControlKpiCounts\(/);
        expect(src).toMatch(/kpiCounts \}\);|\.\.\.result, kpiCounts/);
    });

    it('the client PREFERS the server counts over the array', () => {
        const src = codeOnly(read(CLIENT));
        expect(src).toMatch(/controlsData\?\.kpiCounts/);
        // and returns them before the fallback runs
        expect(src).toMatch(/if \(server\) return server;/);
    });

    it('inProgress counts BOTH statuses the card displays', () => {
        // The card labels IN_PROGRESS + IMPLEMENTING under one heading. A
        // count that included only one would under-report the card's own
        // meaning — the Policies `approved` defect in a different costume.
        const src = codeOnly(read(REPO));
        expect(src).toMatch(/of\('IN_PROGRESS', 'IMPLEMENTING'\)/);
    });
});
