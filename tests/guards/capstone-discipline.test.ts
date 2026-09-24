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
// TypeScript and markdown is not a language it lexes.
//
// The markdown masker is not the answer either. `mdCodeOf` keeps a document's
// CODE and blanks its PROSE, and measured on this document that takes all
// three motion-ban needles from 1 match to 0 — three assertions that would
// then pass for ever without the ban being written down anywhere. So the
// markdown reads are NARROWED instead: each positive assertion is bound to
// the section its own test names, which is where the fact it checks is
// supposed to live.
//
// TWO ASSERTIONS STAY WHOLE-DOCUMENT AND MUST: the retired-variant checks are
// `.not.toMatch`, and a negative assertion is satisfied by ANY restriction of
// the text it reads. Narrowing one to the Button-variants section would let a
// "`outline` — use for …" line reappear in the decision tree with the guard
// still green, which is the defect this issue is about wearing a fix's
// costume. Measured, both needles are at 0 over the whole document today.
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
    const src = fs.readFileSync(
        path.join(ROOT, "docs/design-system.md"),
        "utf8",
    );

    it("documents every v2 primitive", () => {
        // Each primitive shipped in the v2 package should appear in
        // the table by name — in the DECISION TREE, which is the index this
        // doc exists to be; a primitive named only in "What this index is
        // NOT" is not documented by it. Measured, every one of the 17
        // occurrences is inside that section today (counts unchanged
        // raw → section), so this binds the claim without weakening it.
        const index = mdSection(src, "Decision tree by intent");
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
            expect(index).toContain(primitive);
        }
    });

    it("documents the spacing-token vocabulary", () => {
        // The spacing scale is one named subsection, and these five words are
        // ordinary English: over the whole document `/\bpage\b/` matched 14
        // times and `/\bdefault\b/` 8, so the scale could have been deleted
        // outright with both still green. Measured raw → section: 2→2, 1→1,
        // 8→3, 2→2, 14→3.
        const spacing = mdSection(src, "Spacing — semantic scale (v2-PR-2)");
        expect(spacing).toMatch(/\btight\b/);
        expect(spacing).toMatch(/\bcompact\b/);
        expect(spacing).toMatch(/\bdefault\b/);
        expect(spacing).toMatch(/\bsection\b/);
        expect(spacing).toMatch(/\bpage\b/);
    });

    it("documents the post-cull Button variant set (primary | secondary | ghost | destructive | destructive-outline)", () => {
        const variants = mdSection(src, "Button variants (v2-PR-1, post-cull)");
        for (const variant of [
            "`primary`",
            "`secondary`",
            "`ghost`",
            "`destructive`",
            "`destructive-outline`",
        ]) {
            expect(variants).toContain(variant);
        }
        // Retired variants must NOT show as recommended. These two stay on
        // the WHOLE document deliberately — see the note at the import. A
        // negative is satisfied by any subset of the text it reads, so
        // narrowing it would weaken the assertion while looking converted.
        expect(src).not.toMatch(/`outline` —/);
        expect(src).not.toMatch(/`success` —/);
    });

    it("documents the 3 elevation levels", () => {
        const elevation = mdSection(src, "Card elevation (v2-PR-9)");
        for (const level of [
            'elevation="flat"',
            'elevation="raised"',
            'elevation="floating"',
        ]) {
            expect(elevation).toContain(level);
        }
    });

    it("documents the motion language ban list", () => {
        // Narrowed, and NOT masked: all three needles are 1 raw and 0 through
        // `mdCodeOf`, because the word "banned" is prose. 1→1 through the
        // section.
        const motion = mdSection(src, "Motion language (v2-PR-4)");
        expect(motion).toMatch(/hover:translate-\*.*banned/i);
        expect(motion).toMatch(/hover:scale-\*.*banned/i);
        expect(motion).toMatch(/hover:shadow-\*.*banned/i);
    });
});
