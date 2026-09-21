/**
 * v2-PR-15 — Capstone ratchet (final PR of the v2 Premium Polish package).
 *
 * Locks three additive contributions:
 *   1. <SkeletonTable rows cols> — full-table loading skeleton
 *      with header row + N body rows.
 *   2. <EmptyState size="sm|md"> — typed size axis on EmptyState
 *      so in-card empties read at a different visual weight than
 *      full-pane empties.
 *   3. docs/design-system.md — single primitive-by-intent index
 *      that names every canonical primitive and points to the
 *      per-epic deep-dive doc.
 *
 * No consumer migration in this PR — the primitives are additive
 * (existing EmptyState callers without `size` keep their `md`
 * rendering by default; SkeletonTable is opt-in).
 *
 * Pairs with:
 *   - src/components/ui/skeleton.tsx (the SkeletonTable primitive)
 *   - src/components/ui/empty-state.tsx (the size axis)
 *   - docs/design-system.md (the index)
 */
import * as fs from "fs";
import * as path from "path";

// #2246 Class A — the mask goes at the READ SEAM. The two `.tsx` reads below
// are masked; the `docs/design-system.md` read is NOT, because `codeOf` lexes
// TypeScript and markdown is not a language it lexes. That read is prose and
// is tracked as an unmasked seam rather than spelled with the wrong lexer.
import { codeOf } from "../helpers/source-blocks";

const ROOT = path.resolve(__dirname, "../..");

describe("v2-PR-15 SkeletonTable primitive", () => {
    const src = codeOf(
        fs.readFileSync(path.join(ROOT, "src/components/ui/skeleton.tsx"), "utf8"),
    );

    it("exports the SkeletonTable function", () => {
        expect(src).toMatch(/export\s+function\s+SkeletonTable\b/);
    });

    it("declares rows + cols + className props", () => {
        expect(src).toMatch(/SkeletonTable\(\{\s*rows[\s\S]*?cols[\s\S]*?className/);
    });

    it("default rows = 6, cols = 8", () => {
        expect(src).toMatch(/rows\s*=\s*6/);
        expect(src).toMatch(/rows[\s\S]*?cols\s*=\s*8/);
    });

    it("renders a <table> with thead + tbody (structural fidelity)", () => {
        // The whole point of SkeletonTable is to mirror the real
        // DataTable shape so the loading state doesn't reflow when
        // data lands.
        expect(src).toMatch(/<table\b/);
        expect(src).toMatch(/<thead\b/);
        expect(src).toMatch(/<tbody\b/);
    });

    it("composes via <SkeletonTableRow> for each row", () => {
        expect(src).toMatch(/<SkeletonTableRow\b/);
    });

    it("forwards a stable test marker", () => {
        expect(src).toMatch(/data-skeleton-table/);
    });
});

describe("v2-PR-15 EmptyState size axis", () => {
    const src = codeOf(
        fs.readFileSync(path.join(ROOT, "src/components/ui/empty-state.tsx"), "utf8"),
    );

    it("declares the EmptyStateSize type", () => {
        expect(src).toMatch(
            /export\s+type\s+EmptyStateSize\s*=\s*["']sm["']\s*\|\s*["']md["']/,
        );
    });

    it("EmptyStateProps accepts an optional size", () => {
        expect(src).toMatch(/size\?:\s*EmptyStateSize/);
    });

    it("default size is 'md' (preserves existing visual)", () => {
        // Existing call sites that don't pass `size` keep their
        // current rendering. The default must NOT silently switch
        // visual register.
        expect(src).toMatch(/size\s*=\s*["']md["']/);
    });

    it("size='sm' uses size-10 icon container, size='md' uses size-14", () => {
        // Tightly couples the size token to the icon-frame size so
        // a future size addition can't silently drift.
        expect(src).toMatch(/size === ["']sm["']\s*\?\s*["']size-10["']\s*:\s*["']size-14["']/);
    });

    it("forwards data-empty-state-size for E2E targeting", () => {
        expect(src).toMatch(/data-empty-state-size/);
    });
});

describe("v2-PR-15 design-system.md primitive-by-intent index", () => {
    const src = fs.readFileSync(
        path.join(ROOT, "docs/design-system.md"),
        "utf8",
    );

    it("documents every v2 primitive", () => {
        // Each primitive shipped in the v2 package should appear in
        // the table by name. If a future PR ships a new primitive,
        // it must update this doc — that's the system invariant.
        for (const primitive of [
            "<EntityListPage>",
            "<EntityDetailLayout>",
            "<DashboardLayout>",
            "<PageHeader>",
            "<HeroMetric>",
            "<MetricCard>",
            "<Card>",
            "<FilterToolbar>",
            "<DataTable>",
            "<StatusBadge>",
            "<ActionCluster>",
            "<NextBestActionCard>",
            "<InlineNotice>",
            "<ErrorState>",
            "<EmptyState",
            "<MetadataBar>",
            "<TabSection>",
        ]) {
            expect(src).toContain(primitive);
        }
    });

    it("documents the spacing-token vocabulary", () => {
        expect(src).toMatch(/\btight\b/);
        expect(src).toMatch(/\bcompact\b/);
        expect(src).toMatch(/\bdefault\b/);
        expect(src).toMatch(/\bsection\b/);
        expect(src).toMatch(/\bpage\b/);
    });

    it("documents the post-cull Button variant set (primary | secondary | ghost | destructive | destructive-outline)", () => {
        for (const variant of [
            "`primary`",
            "`secondary`",
            "`ghost`",
            "`destructive`",
            "`destructive-outline`",
        ]) {
            expect(src).toContain(variant);
        }
        // Retired variants must NOT show as recommended.
        expect(src).not.toMatch(/`outline` —/);
        expect(src).not.toMatch(/`success` —/);
    });

    it("documents the 3 elevation levels", () => {
        for (const level of [
            'elevation="flat"',
            'elevation="raised"',
            'elevation="floating"',
        ]) {
            expect(src).toContain(level);
        }
    });

    it("documents the motion language ban list", () => {
        expect(src).toMatch(/hover:translate-\*.*banned/i);
        expect(src).toMatch(/hover:scale-\*.*banned/i);
        expect(src).toMatch(/hover:shadow-\*.*banned/i);
    });
});
