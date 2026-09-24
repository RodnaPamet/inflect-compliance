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

// #2246 Class A — the mask goes at the READ SEAM for the two `.tsx` reads
// below. The `docs/design-system.md` read is NARROWED instead, section by
// section, and that is not a second-best: this document's assertions are the
// case where NEITHER markdown masker works.
//
// Measured. Of the thirteen needles, ten name CODE (`<DataTable>`, `` `ghost`
// ``, `elevation="flat"`, the five spacing tokens) and would survive
// `mdCodeOf` but die under `mdProseOf`. The other three STRADDLE the boundary:
// `/hover:scale-\*.*banned/` matches `- \`hover:scale-*\`, … are banned.`,
// whose left half is a code span and whose right half is prose — it counts 1
// raw and ZERO through BOTH maskers. A mask cannot serve a needle that spans
// the two categories it separates; a narrowing keeps the text byte-for-byte.
//
// Narrowing is also what these assertions MEAN. "Documents the spacing-token
// vocabulary" is a claim about the spacing section, not about the document,
// and binding it there tightens the loose ones considerably — `/\bpage\b/`
// from 14 satisfying positions to 3, `/\bdefault\b/` from 8 to 3.
import { mdSection } from "../helpers/markdown-regions";
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
    const doc = fs.readFileSync(
        path.join(ROOT, "docs/design-system.md"),
        "utf8",
    );
    // One section per claim. `mdSection` is fence-aware, so a `#` inside a
    // fenced sample cannot end a section early, and it THROWS when a heading
    // is gone — a renamed section fails loudly rather than asserting against
    // an empty string.
    const decisionTree = mdSection(doc, "Decision tree by intent");
    const spacing = mdSection(doc, "Spacing — semantic scale (v2-PR-2)");
    const motion = mdSection(doc, "Motion language (v2-PR-4)");
    const elevation = mdSection(doc, "Card elevation (v2-PR-9)");
    const variants = mdSection(doc, "Button variants (v2-PR-1, post-cull)");

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
            expect(decisionTree).toContain(primitive);
        }
    });

    it("documents the spacing-token vocabulary", () => {
        expect(spacing).toMatch(/\btight\b/);
        expect(spacing).toMatch(/\bcompact\b/);
        expect(spacing).toMatch(/\bdefault\b/);
        expect(spacing).toMatch(/\bsection\b/);
        expect(spacing).toMatch(/\bpage\b/);
    });

    it("documents the post-cull Button variant set (primary | secondary | ghost | destructive | destructive-outline)", () => {
        for (const variant of [
            "`primary`",
            "`secondary`",
            "`ghost`",
            "`destructive`",
            "`destructive-outline`",
        ]) {
            expect(variants).toContain(variant);
        }
        // Retired variants must NOT show as recommended. Bound to the section
        // rather than masked: the needle spans a code span and the em-dash
        // beside it, so under either markdown mask it could never match and
        // the negative would pass vacuously. Narrowing keeps the text verbatim
        // AND says what "shown as recommended" means — appearing in the
        // Button variants list, not anywhere in the document.
        expect(variants).not.toMatch(/`outline` —/);
        expect(variants).not.toMatch(/`success` —/);
    });

    it("documents the 3 elevation levels", () => {
        for (const level of [
            'elevation="flat"',
            'elevation="raised"',
            'elevation="floating"',
        ]) {
            expect(elevation).toContain(level);
        }
    });

    it("documents the motion language ban list", () => {
        expect(motion).toMatch(/hover:translate-\*.*banned/i);
        expect(motion).toMatch(/hover:scale-\*.*banned/i);
        expect(motion).toMatch(/hover:shadow-\*.*banned/i);
    });
});
