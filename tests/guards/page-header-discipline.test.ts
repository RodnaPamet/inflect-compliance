/**
 * v2-PR-5 — `<PageHeader>` primitive contract + adoption ratchet.
 *
 * Asserts that the canonical `<PageHeader>` primitive exists with the
 * documented slot shape, and that both layout shells
 * (`EntityListPage` + `EntityDetailLayout`) consume it internally
 * instead of hand-rolling the same flex / wrap / breadcrumbs / title /
 * actions structure.
 *
 * Why this is one ratchet:
 *   - The two shells used to spell the structure in different places
 *     with subtly different copy (e.g. `count` vs no equivalent on
 *     detail). Drift between them was invisible to reviewers.
 *   - Application pages that aren't list/detail shells (admin
 *     dashboards, auth pages) will adopt this primitive directly in
 *     subsequent PRs. The ratchet for those is intentionally NOT
 *     here yet — it's a wider migration that gets its own PR.
 *
 * Pairs with:
 *   - `src/components/layout/PageHeader.tsx` (the primitive)
 *   - `src/components/layout/EntityListPage.tsx`
 *   - `src/components/layout/EntityDetailLayout.tsx`
 */
import * as fs from "fs";
import * as path from "path";
import { codeOf } from "../helpers/source-blocks";

const ROOT = path.resolve(__dirname, "../..");
// #2246 Class A — comments blanked at the read, string literals kept.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("v2-PR-5 PageHeader primitive contract", () => {
    const src = read("src/components/layout/PageHeader.tsx");

    it("exports the PageHeader component + props interface", () => {
        expect(src).toMatch(/export\s+function\s+PageHeader/);
        expect(src).toMatch(/export\s+interface\s+PageHeaderProps/);
        expect(src).toMatch(/export\s+interface\s+PageHeaderBackLink/);
    });

    it("declares the documented slot props", () => {
        // Each slot is a typed prop on PageHeaderProps. Order in the
        // interface doesn't matter; presence does.
        for (const slot of [
            "breadcrumbs",
            "back",
            "eyebrow",
            "title",
            "description",
            "meta",
            "actions",
        ]) {
            expect(src).toMatch(new RegExp(`\\b${slot}\\??:`));
        }
    });

    it("title is required (no `?`); other slots are optional", () => {
        // `title: React.ReactNode` (no `?:`) — required.
        expect(src).toMatch(/\btitle:\s*React\.ReactNode/);
        // Other slots are optional via `?:`.
        for (const slot of [
            "breadcrumbs",
            "back",
            "eyebrow",
            "description",
            "meta",
            "actions",
        ]) {
            expect(src).toMatch(new RegExp(`\\b${slot}\\?:`));
        }
    });

    it("renders <Heading level={1}> internally", () => {
        expect(src).toMatch(/<Heading\s+level=\{1\}/);
    });

    it("forwards stable test ids per slot", () => {
        // Consumers rely on these for E2E targeting.
        for (const id of [
            "page-header-breadcrumbs",
            "page-header-back",
            "page-header-eyebrow",
            "page-header-title",
            "page-header-description",
            "page-header-meta",
            "page-header-actions",
        ]) {
            expect(src).toContain(`"${id}"`);
        }
    });
});

describe("v2-PR-5 layout shells consume PageHeader", () => {
    it("EntityListPage imports + renders <PageHeader>", () => {
        const src = read("src/components/layout/EntityListPage.tsx");
        expect(src).toMatch(
            /import\s+\{\s*PageHeader\s*\}\s+from\s+["']@\/components\/layout\/PageHeader["']/,
        );
        expect(src).toMatch(/<PageHeader\b/);
        // Should no longer hand-roll a `<Heading level={1}>` for the
        // list-page header — that responsibility moved into the
        // primitive.
        expect(src).not.toMatch(/<Heading\s+level=\{1\}/);
    });

    it("EntityDetailLayout imports + renders <PageHeader>", () => {
        const src = read("src/components/layout/EntityDetailLayout.tsx");
        expect(src).toMatch(
            /import\s+\{\s*PageHeader\s*\}\s+from\s+["']@\/components\/layout\/PageHeader["']/,
        );
        expect(src).toMatch(/<PageHeader\b/);
        expect(src).not.toMatch(/<Heading\s+level=\{1\}/);
    });
});
