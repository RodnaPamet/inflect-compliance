/**
 * v2-PR-6 — `<DashboardLayout>` primitive contract + adoption ratchet.
 *
 * Asserts the new dashboard composition shell exists and that the
 * canonical adoption site (the executive dashboard) consumes it.
 *
 * Three public layout shells now coexist:
 *   - <EntityListPage>     — list pages (DataTable + FilterToolbar)
 *   - <EntityDetailLayout> — entity detail pages (header + tabs + body)
 *   - <DashboardLayout>    — dashboard pages (this PR)
 *
 * All three delegate the page header to the same `<PageHeader>`
 * primitive (v2-PR-5), so reading order, typography, and spacing are
 * unified across the entire app.
 *
 * Pairs with:
 *   - src/components/layout/DashboardLayout.tsx
 *   - src/components/layout/PageHeader.tsx
 *   - tests/guards/page-header-discipline.test.ts
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

describe("v2-PR-6 DashboardLayout primitive contract", () => {
    const src = fs.readFileSync(
        path.join(ROOT, "src/components/layout/DashboardLayout.tsx"),
        "utf8",
    );

    it("exports the DashboardLayout component + props interface", () => {
        expect(src).toMatch(/export\s+function\s+DashboardLayout/);
        expect(src).toMatch(/export\s+interface\s+DashboardLayoutProps/);
    });

    it("delegates the header to <PageHeader>", () => {
        expect(src).toMatch(
            /import\s+\{[^}]*PageHeader[^}]*\}\s+from\s+["']\.\/PageHeader["']/,
        );
        expect(src).toMatch(/<PageHeader\b/);
    });

    it("requires a header prop typed as PageHeaderProps", () => {
        expect(src).toMatch(/header:\s*PageHeaderProps/);
    });

    it("wraps in `space-y-section animate-fadeIn`", () => {
        // The shared dashboard rhythm — vertical sections + fade on
        // first paint. Asserting both classes appear on the wrapper
        // keeps the rhythm constant across consumers.
        expect(src).toMatch(/space-y-section/);
        expect(src).toMatch(/animate-fadeIn/);
    });

    it("carries the data-dashboard-layout marker for E2E selectors", () => {
        expect(src).toMatch(/data-dashboard-layout/);
    });
});

describe("v2-PR-6 executive dashboard adoption", () => {
    const src = fs.readFileSync(
        path.join(
            ROOT,
            "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx",
        ),
        "utf8",
    );

    it("imports + renders <DashboardLayout>", () => {
        expect(src).toMatch(
            /import\s+\{\s*DashboardLayout\s*\}\s+from\s+["']@\/components\/layout\/DashboardLayout["']/,
        );
        expect(src).toMatch(/<DashboardLayout\b/);
    });

    it("no longer hand-rolls the dashboard outer wrapper", () => {
        // Before: <div className="space-y-section animate-fadeIn"> followed
        // immediately by an inline header block. After: those concerns live
        // inside <DashboardLayout>. The flag asserts the inline wrapper
        // pattern is gone.
        expect(src).not.toMatch(
            /<div\s+className="space-y-section animate-fadeIn">\s*\n\s*<OnboardingBanner/,
        );
    });

    it("no longer hand-rolls a level-1 page heading", () => {
        // The page now passes `title` to <DashboardLayout>'s header
        // prop instead of rendering <Heading level={1}> inline. Lower-
        // level <Heading> nodes (e.g. level=2/3 inside section cards)
        // are unaffected.
        expect(src).not.toMatch(/<Heading\s+level=\{1\}/);
    });

    it("the custom-KPI section header start-aligns its picker to the top-right", () => {
        // The header is a two-line title block (heading + subtitle) beside
        // a one-line picker. With `sm:items-center` the picker centres
        // against the taller block and floats BELOW the heading's top
        // edge; `sm:items-start` parks it in the section's top-right
        // corner, level with the heading. Fixed 2026-08-04.
        const header = src.match(
            /<div className="flex flex-col gap-tight sm:flex-row[^"]*">/,
        )?.[0];
        expect(header).toBeDefined();
        expect(header).toContain("sm:items-start");
        expect(header).not.toContain("sm:items-center");
        // …and it stays on the right.
        expect(header).toContain("sm:justify-between");
    });
});
