/**
 * P3 — make the risk-analytics pages honest, self-explaining, and findable.
 *
 * Locks: (1) the six analytics pages fetch via useTenantSWR + render honest
 * load/error/empty states (no swallowed-catch blank-card), (2) concept
 * guidance via InfoTooltip, (3) the correlations title truncation fix,
 * (4) the labeled Views menu + AI-Systems re-shelf.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const P = (rel: string) => `src/app/t/[tenantSlug]/(app)/risks/${rel}`;
const PAGES = ['scenarios', 'hierarchy', 'kri', 'correlations', 'loss-events', 'reports'];

describe('P3 — honest data fetching', () => {
    /**
     * B3-5 — the primitive's BEHAVIOUR is covered by
     * `tests/rendered/risk-analytics-state.test.tsx`, which renders it.
     *
     * The case removed here checked that the file exists and contains the
     * string `data-testid="analytics-error"`. That proves a testid is
     * present in a source file — not that the error branch is reachable, and
     * not the property that actually matters: `error` must beat `isEmpty`.
     * A failed load almost always arrives with `isEmpty === true` (no rows
     * came back), so if the empty branch were checked first, every failure
     * would render as "you have none" — which is exactly the
     * `.catch(() => {})` bug this primitive replaced. No source scan can see
     * that ordering; the rendered test asserts it directly.
     *
     * The adoption sweep below stays: which PAGES mount the primitive, and
     * that they no longer carry the swallow, is a whole-file claim.
     */


    it.each(PAGES)('%s migrates to useTenantSWR + AnalyticsState (no swallowed load)', (page) => {
        const src = read(P(`${page}/page.tsx`));
        expect(src).toMatch(/useTenantSWR/);
        expect(src).toMatch(/<AnalyticsState\b/);
        // The old raw-fetch page-load swallow is gone.
        expect(src).not.toMatch(/catch\s*\{\s*\/\*\s*ignore\s*\*\/\s*\}/);
        expect(src).not.toMatch(/catch\s*\{\s*\/\*\s*failure-soft\s*\*\/\s*\}/);
    });
});

describe('P3 — concept guidance', () => {
    const withConcept = ['scenarios', 'hierarchy', 'kri', 'correlations', 'loss-events'];
    it.each(withConcept)('%s renders an InfoTooltip', (page) => {
        expect(read(P(`${page}/page.tsx`))).toMatch(/<InfoTooltip\b/);
    });

    it('correlations no longer hard-slices risk titles', () => {
        const src = read(P('correlations/page.tsx'));
        expect(src).not.toMatch(/\.slice\(0,\s*8\)/);
        expect(src).not.toMatch(/\.slice\(0,\s*12\)/);
        // and explains PSD.
        expect(src).toMatch(/correlations\.psdHelp/);
    });
});

describe('P3 — findability + AI-Systems re-shelf', () => {
    const client = read(P('RisksClient.tsx'));
    const menu = read('src/components/ui/views-menu.tsx');

    it('replaces the icon-button rail with a labeled Views menu', () => {
        expect(client).toMatch(/id="risks-views-menu"/);
        expect(client).toMatch(/viewsMenu/);
        // The popover moved into the shared `<ViewsMenu>` primitive when
        // the menu was generalised across the main list pages (2026-08-01)
        // — the page mounts it, the primitive owns the popover.
        expect(client).toMatch(/<ViewsMenu\b/);
        expect(menu).toMatch(/<Popover\b/);
    });

    it('re-shelves AI-Systems into its own labeled Registry entry', () => {
        expect(client).toMatch(/'data-testid': 'views-menu-ai-systems'/);
        expect(client).toMatch(/viewsRegistry/);
        expect(client).toMatch(/\/risks\/ai-systems/);
    });

    it('shelves the DORA Register of Information beside it', () => {
        // Same "Registry" heading, same reasoning: a regulatory register
        // ABOUT the estate, not an analytics view OVER it.
        expect(client).toMatch(/'data-testid': 'views-menu-information-registry'/);
        expect(client).toMatch(/\/risks\/information-registry/);
        expect(exists(P('information-registry/page.tsx'))).toBe(true);
    });

    it('keeps the page dashboard OUT of the menu, as its own icon', () => {
        // The one destination worth toolbar width. It must not be in
        // RISK_VIEW_LINKS (which renders into the menu) and must render as
        // a `size: 'icon'` link beside the trigger.
        expect(client).not.toMatch(/href: '\/risks\/dashboard'/);
        expect(client).toMatch(/id="risks-dashboard-btn"/);
        expect(client).toMatch(/tenantHref\('\/risks\/dashboard'\)/);
    });
});
