/**
 * Epic O-4 + Epic 41 — structural contract for the portfolio overview page.
 *
 * Static-file checks (no jsdom, no React render). After the Epic 41
 * page rewire, the load-bearing properties shifted from "the page
 * itself renders four hardcoded sections" to "the page fetches
 * widgets + portfolio data and delegates to a client island".
 *
 * Locks:
 *
 *   1. The page exists at the canonical (app)/page.tsx path
 *   2. dynamic = "force-dynamic" (per-request freshness)
 *   3. OrgContext resolved via getOrgCtx; errors collapse to notFound()
 *      (no slug echo on forbidden / missing)
 *   4. Page consumes BOTH:
 *        - listOrgDashboardWidgets (Epic 41 — persisted layout)
 *        - getPortfolioOverview with trendDays: 90 (Epic E.3 single-fetch
 *          orchestrator, NOT the three independent usecases)
 *   5. Server hands serialised props to <PortfolioDashboard> (the
 *      client island that owns edit-mode + drag/resize wiring)
 *   6. canConfigureDashboard from OrgPermissionSet drives the canEdit
 *      prop (the ORG_ADMIN-only edit affordance)
 *   7. Server-side toPlainJson boundary on both prop drops
 *      (Date / Decimal sanitisation per the existing convention)
 *   8. Page does NOT reintroduce hardcoded sections — the visual
 *      composition lives in widget rows now, not in this file
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const PAGE_PATH = 'src/app/org/[orgSlug]/(app)/page.tsx';
/**
 * MASKED AT THE READ SEAM — #2246 Class A. 22 whole-file assertions against
 * one page; three needles were measured prose-inflated, and this file's own
 * header (point 8, "page does NOT reintroduce hardcoded sections") is the
 * shape that goes wrong: a negative assertion that a COMMENT can redden and
 * a positive one that a comment can satisfy. `codeOf` keeps string literals.
 */
const read = () => codeOf(fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf-8'));

describe('Epic 41 — portfolio overview structural contract (post-rewire)', () => {
    it('page exists at the canonical (app)/page.tsx path', () => {
        expect(fs.existsSync(path.join(ROOT, PAGE_PATH))).toBe(true);
    });

    it('declares dynamic = "force-dynamic" (per-request freshness)', () => {
        expect(read()).toMatch(
            /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/,
        );
    });

    it('resolves OrgContext via getOrgCtx and collapses errors to notFound()', () => {
        const src = read();
        expect(src).toMatch(/from\s+['"]@\/app-layer\/context['"]/);
        expect(src).toMatch(/getOrgCtx\s*\(\s*\{[^}]*orgSlug/);
        // Defensive try/catch must route to notFound() — no slug echo.
        expect(src).toMatch(/}\s*catch\b[\s\S]*?notFound\s*\(\s*\)/);
    });

    it('fetches persisted widgets via listOrgDashboardWidgets', () => {
        const src = read();
        // Epic 41 — the page reads widget rows from the DB, not a
        // hardcoded composition.
        expect(src).toMatch(/from\s+['"]@\/app-layer\/usecases\/org-dashboard-widgets['"]/);
        expect(src).toMatch(/listOrgDashboardWidgets/);
    });

    it('fetches live portfolio data via the single-fetch orchestrator', () => {
        const src = read();
        // Epic E.3 invariant — the page uses the orchestrator (one
        // round-trip) instead of three independent usecases that fired
        // duplicated `getOrgTenantIds` × 3 + `getLatestSnapshots` × 2.
        expect(src).toMatch(/from\s+['"]@\/app-layer\/usecases\/portfolio['"]/);
        expect(src).toMatch(/getPortfolioOverview/);
        // Must NOT fall back to the three separate usecases.
        expect(src).not.toMatch(
            /import\s*\{[^}]*getPortfolioSummary[^}]*\}\s*from\s+['"]@\/app-layer\/usecases\/portfolio['"]/,
        );
    });

    it('passes the 90-day trend window to the orchestrator', () => {
        expect(read()).toMatch(
            /getPortfolioOverview\s*\(\s*ctx\s*,\s*\{[^}]*trendDays:\s*90/,
        );
    });

    it('runs the two server fetches in parallel (Promise.all)', () => {
        // Sequential awaits would double the page TTFB. The
        // parallelism is small but real — locking it prevents a
        // future refactor from quietly serialising the calls.
        expect(read()).toMatch(/Promise\.all\s*\(\s*\[/);
    });

    it('delegates rendering to <PortfolioDashboard> client component', () => {
        const src = read();
        expect(src).toMatch(/import\s*\{[^}]*PortfolioDashboard[^}]*\}\s*from\s+['"]\.\/PortfolioDashboard['"]/);
        expect(src).toMatch(/<PortfolioDashboard\b/);
    });

    it('passes initialWidgets + data through toPlainJson (RSC boundary)', () => {
        const src = read();
        expect(src).toMatch(/from\s+['"]@\/lib\/server\/to-plain-json['"]/);
        // Both server props go through the boundary so Dates and
        // Prisma Decimal types serialise cleanly.
        expect(src).toMatch(/initialWidgets=\{toPlainJson\(/);
        expect(src).toMatch(/data=\{toPlainJson\(/);
    });

    it('drives canEdit from canConfigureDashboard (ORG_ADMIN only)', () => {
        const src = read();
        expect(src).toMatch(/canEdit=\{ctx\.permissions\.canConfigureDashboard\}/);
    });

    // ── Deliberately removed sections — assert they DON'T re-appear ─

    it('does not reintroduce hardcoded section components in the page itself', () => {
        const src = read();
        // The visual composition is in widget rows now. A future
        // refactor that hand-rolls a section back into the page would
        // bypass the configurable engine — this assertion catches it.
        expect(src).not.toMatch(/<StatCardsRow\b/);
        expect(src).not.toMatch(/<RagDistributionCard\b/);
        expect(src).not.toMatch(/<RiskTrendCard\b/);
    });

    it('does not hand-roll a raw <table> or <svg>', () => {
        const src = read();
        // The page is a thin server component. Tables / SVGs belong
        // inside dispatched widgets, not the page itself.
        expect(src).not.toMatch(/<table\b/);
        expect(src).not.toMatch(/<svg\b/);
    });
});
