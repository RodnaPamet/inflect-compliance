/**
 * v2-PR-13 — `<MetadataBar>` + `<TabSection>` primitive contracts.
 *
 * Two new detail-page primitives shipped together — both are
 * additive (no consumer migration) so the ratchet locks the
 * primitive contracts only. Per-detail-page adoption is a follow-up.
 *
 * MetadataBar:
 *   Single horizontal `Label: value · …` strip with a "+N more"
 *   collapse — replaces the 6 hand-rolled metadata layouts that
 *   detail pages currently use (sidebar, header description,
 *   separate Card under the header, inline meta row).
 *
 * TabSection:
 *   Standardised tab body wrapper with optional title + description
 *   + actions cluster. Replaces the ad-hoc `<div className="space-y-
 *   section">` + inline heading patterns that drifted between tabs.
 *
 * Pairs with:
 *   - src/components/ui/MetadataBar.tsx
 *   - src/components/ui/TabSection.tsx
 *   - <EntityDetailLayout> (v2-PR-5) — the parent surface for both
 */
import * as fs from "fs";
import * as path from "path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");

describe("v2-PR-13 MetadataBar primitive contract", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/ui/MetadataBar.tsx"),
        "utf8",
    ));

    it("exports the component + props + item type", () => {
        expect(src).toMatch(/export\s+function\s+MetadataBar/);
        expect(src).toMatch(/export\s+interface\s+MetadataBarProps/);
        expect(src).toMatch(/export\s+interface\s+MetadataBarItem/);
    });

    it("declares the documented slot props", () => {
        expect(src).toMatch(/\bitems:\s*ReadonlyArray<MetadataBarItem>/);
        expect(src).toMatch(/\bmaxVisible\?:\s*number/);
    });

    it("MetadataBarItem requires id + label + value", () => {
        const itemBlock = src.match(
            /export\s+interface\s+MetadataBarItem\s*\{([\s\S]*?)\}/,
        );
        expect(itemBlock).not.toBeNull();
        const inner = itemBlock![1];
        expect(inner).toMatch(/\bid:\s*string/);
        expect(inner).toMatch(/\blabel:\s*React\.ReactNode/);
        expect(inner).toMatch(/\bvalue:\s*React\.ReactNode/);
    });

    it("default maxVisible is 6", () => {
        expect(src).toMatch(/DEFAULT_MAX_VISIBLE\s*=\s*6/);
    });

    it("renders separator dots between items", () => {
        // The middle-dot separator (`·`) is the canonical
        // delimiter for these strips. Hardcoded as a literal so it
        // can't drift.
        expect(src).toMatch(/·/);
    });

    it("renders the `+N more` overflow chip", () => {
        expect(src).toMatch(/\+\$\{?overflow\}?\s*more|\+\{?overflow\}?\s*more/);
    });

    it("forwards stable test markers", () => {
        for (const id of [
            "data-metadata-bar",
            "data-metadata-bar-item",
            "data-metadata-bar-item-id",
            "data-metadata-bar-overflow",
        ]) {
            expect(src).toContain(id);
        }
    });

    it("returns null when items array is empty", () => {
        expect(src).toMatch(/items\.length\s*===\s*0\s*\)\s*return\s+null/);
    });
});

describe("v2-PR-13 TabSection primitive contract", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/ui/TabSection.tsx"),
        "utf8",
    ));

    it("exports the component + props interface", () => {
        expect(src).toMatch(/export\s+function\s+TabSection/);
        expect(src).toMatch(/export\s+interface\s+TabSectionProps/);
    });

    it("declares the documented slot props", () => {
        for (const slot of ["title", "description", "actions", "children"]) {
            expect(src).toMatch(new RegExp(`\\b${slot}\\??:`));
        }
    });

    it("`children` is required; title/description/actions are optional", () => {
        expect(src).toMatch(/\bchildren:\s*React\.ReactNode/);
        for (const slot of ["title", "description", "actions"]) {
            expect(src).toMatch(new RegExp(`\\b${slot}\\?:`));
        }
    });

    it("uses Heading level={2} for the title (one level below page header)", () => {
        // Page header is level=1; tab section is level=2; cards
        // inside the body use level=3. Predictable hierarchy.
        expect(src).toMatch(/<Heading\s+level=\{2\}/);
    });

    it("wraps in a `<section>` with `space-y-section` rhythm", () => {
        expect(src).toMatch(/<section\b[\s\S]*?space-y-section/);
    });

    it("forwards stable test markers", () => {
        for (const id of [
            "data-tab-section",
            "data-tab-section-header",
            "tab-section-title",
            "tab-section-description",
            "tab-section-actions",
        ]) {
            expect(src).toContain(id);
        }
    });

    it("only renders the header row when title or actions is present", () => {
        // `hasHeader` gates the header render. Tab bodies that
        // supply only `children` get NO header at all — the
        // primitive doesn't impose chrome for nothing.
        expect(src).toMatch(/const\s+hasHeader\s*=\s*title\s*\|\|\s*actions/);
        expect(src).toMatch(/\{hasHeader\s*&&/);
    });
});
