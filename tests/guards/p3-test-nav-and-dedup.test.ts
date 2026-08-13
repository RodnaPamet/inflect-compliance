/**
 * R3-P3 — test-surface disambiguation, dashboard de-dup, sub-nav, polish.
 *
 *   1. One shared sub-nav spine (Tests / Due / Dashboard) on all three pages.
 *   2. Dashboard de-dup: the duplicate result-distribution donut is gone, and
 *      the restated plan-total / overdue COUNT KPIs are off the dashboard.
 *   3. Disambiguation cross-links between the test dashboard's "framework test
 *      coverage" and the /coverage risk-map.
 *   4. Polish: /tests H1 is visible; /due + /dashboard carry breadcrumbs.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const SUBNAV = 'src/app/t/[tenantSlug]/(app)/tests/_components/TestsSubNav.tsx';
const TESTS = 'src/app/t/[tenantSlug]/(app)/tests/page.tsx';
const DUE = 'src/app/t/[tenantSlug]/(app)/tests/due/page.tsx';
const DASH = 'src/app/t/[tenantSlug]/(app)/tests/dashboard/page.tsx';
const G2 = 'src/components/TestDashboardG2Section.tsx';
const COVERAGE = 'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx';

describe('R3-P3 (1) shared sub-nav', () => {
    it('a TestsSubNav exists and all three pages mount it with the right active tab', () => {
        expect(read(SUBNAV)).toMatch(/export function TestsSubNav/);
        expect(read(TESTS)).toMatch(/<TestsSubNav active="tests"/);
        expect(read(DUE)).toMatch(/<TestsSubNav active="due"/);
        expect(read(DASH)).toMatch(/<TestsSubNav active="dashboard"/);
    });
});

describe('R3-P3 (2) dashboard de-dup', () => {
    it('the duplicate result-distribution donut is removed from the G2 section', () => {
        const g2 = read(G2);
        expect(g2).not.toMatch(/DonutChart/);
        expect(g2).not.toMatch(/donutSegments/);
    });
    it('the restated count KPIs (overdue plans / active plans) are off the dashboard', () => {
        const dash = read(DASH);
        expect(dash).not.toMatch(/dashboard\.kpi\.overduePlans/);
        expect(dash).not.toMatch(/dashboard\.kpi\.activePlans/);
    });
});

describe('R3-P3 (3) coverage/readiness disambiguation', () => {
    it('the test dashboard cross-links to the /coverage map', () => {
        const dash = read(DASH);
        expect(dash).toMatch(/dashboard\.fwCoverageVsCoverage/);
        expect(dash).toMatch(/tenantHref\('\/coverage'\)/);
    });
    it('the /coverage map cross-links back to the test dashboard', () => {
        const cov = read(COVERAGE);
        expect(cov).toMatch(/vsTestCoverage/);
        expect(cov).toMatch(/tenantHref\('\/tests\/dashboard'\)/);
    });
});

describe('R3-P3 (4) polish', () => {
    it('the /tests H1 is sr-only, matching every peer list page', () => {
        // INVERTED (U4). This asserted the opposite — that the H1 must NOT be
        // sr-only — and so forbade the canonical form character-for-character.
        //
        // Every peer list page renders `<Heading level={1} className="sr-only">`
        // (risks, assets, evidence, vendors, tasks), and the rule is codified in
        // the shared primitive: `PageHeader.tsx` sets `titleHidden` for a route
        // classified 'main'. /tests was the sole holdout, printing "Tests"
        // directly beneath a breadcrumb trail ending in "Tests".
        //
        // The heading is kept, not deleted: it remains the document's H1 for
        // assistive tech and the skip-link target. Only its visibility changes.
        const tests = read(TESTS);
        expect(tests).toMatch(/id="tests-page-title"/);
        expect(tests).toMatch(/id="tests-page-title" className="sr-only"/);
    });
    it('/due and /dashboard carry breadcrumbs', () => {
        expect(read(DUE)).toMatch(/PageBreadcrumbs/);
        expect(read(DASH)).toMatch(/breadcrumbs:/);
    });
});

describe('R3-P3 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.controlTests.subnav.tests).toBeTruthy();
            expect(l.controlTests.subnav.due).toBeTruthy();
            expect(l.controlTests.subnav.dashboard).toBeTruthy();
            expect(l.controlTests.dashboard.crumb).toBeTruthy();
            expect(l.controlTests.dashboard.fwCoverageVsCoverage).toBeTruthy();
            expect(l.controlTests.due.crumb).toBeTruthy();
            expect(l.coverage.vsTestCoverage).toBeTruthy();
        }
    });
});
