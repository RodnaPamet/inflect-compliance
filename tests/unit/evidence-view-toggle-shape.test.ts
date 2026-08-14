/**
 * Structural ratchet: Epic 43.2 view toggle preserves filter state.
 *
 * The toggle is in URL-only state via `useUrlFilters`, NOT in
 * `filterCtx`. Switching list ↔ gallery therefore cannot disturb the
 * filter state (`q` / `type` / `status` / `controlId` / retention)
 * because both renderers consume the SAME `displayEvidence` array
 * which is computed off `filterCtx`.
 *
 * This test locks in that wiring shape so a future refactor can't
 * silently re-introduce per-view filter state and reset filters on
 * toggle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
const EVIDENCE_CLIENT =
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';

describe('Epic 43.2 — view toggle wiring', () => {
    const src = read(EVIDENCE_CLIENT);

    it('imports the gallery + toggle primitives from canonical paths', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\bEvidenceGallery\b[^}]*\}\s*from\s*['"]@\/components\/ui\/EvidenceGallery['"]/,
        );
        expect(src).toMatch(
            /import\s*\{[^}]*\bToggleGroup\b[^}]*\}\s*from\s*['"]@\/components\/ui\/toggle-group['"]/,
        );
        expect(src).toMatch(
            /import\s*\{[^}]*\bFreshnessBadge\b[^}]*\}\s*from\s*['"]@\/components\/ui\/FreshnessBadge['"]/,
        );
    });

    it('keeps the view selector in useUrlFilters, not in filter context', () => {
        // The invariant is about `view` ALONE: it flips the renderer, so it
        // must stay out of `filterCtx` or toggling the view would churn
        // filter state. What ELSE useUrlFilters manages is not this test's
        // business — R1-2b moved `tab` into `filterCtx`, where it belongs
        // now that the retention bucket is a real filter category, and
        // pinning the exact array contents failed that correct change.
        expect(src).toMatch(/useUrlFilters\(\[[^\]]*['"]view['"][^\]]*\]\)/);
        // The retention bucket reads from filter state, not from here.
        expect(src).not.toMatch(/useUrlFilters\(\[[^\]]*['"]tab['"][^\]]*\]\)/);
    });

    it('derives a `viewMode` of list | gallery from the URL', () => {
        expect(src).toContain("filters.view === 'gallery'");
    });

    it('mounts the ToggleGroup with list and gallery options + ids', () => {
        expect(src).toContain(
            "id: 'evidence-view-list'",
        );
        expect(src).toContain(
            "id: 'evidence-view-gallery'",
        );
    });

    it('wires the toggle into setFilter, NOT into filter context', () => {
        // Locks the architecture: filter state stays in filterCtx,
        // view state stays in useUrlFilters.
        expect(src).toMatch(/selectAction=\{\(v\)\s*=>\s*setFilter\(['"]view['"]/);
    });

    it('renders <EvidenceGallery> when viewMode === gallery, <DataTable> otherwise', () => {
        // EP-3 — the gallery branch now opens with a fragment + comment +
        // an optional in-branch <BulkActionBar> before <EvidenceGallery>,
        // so allow intervening JSX/whitespace between the `? (` and the
        // gallery element while still asserting the gallery lives in the
        // `viewMode === 'gallery'` branch.
        expect(src).toMatch(/viewMode === ['"]gallery['"]\s*\?\s*\([\s\S]{0,1200}<EvidenceGallery/);
        expect(src).toMatch(/<DataTable/);
    });

    it('passes the SAME `displayEvidence` array to both renderers', () => {
        // Both views read from displayEvidence — the filtered list.
        // If a future refactor introduced separate per-view state
        // (e.g. galleryRows / tableRows) that would BREAK filter
        // preservation. This test fails CI on that regression.
        // EP-2/EP-3 — the gallery binds the freshness-refined slice
        // `displayEvidenceFresh` (a view refinement over `displayEvidence`);
        // accept either binding so the gallery↔table filter-preservation
        // regression class stays covered.
        expect(src).toMatch(
            /<EvidenceGallery[\s\S]{0,300}rows=\{(displayEvidenceFresh|displayEvidence)\}/,
        );
        // PR-1 — the table view binds `data` to the
        // `useThresholdLoadMore`-windowed `visibleEvidence` slice,
        // not the full `displayEvidence` array. The slice is the
        // same source filtered through a window — filter preservation
        // is unaffected (the hook narrows on the same array). Match
        // either binding so the gallery↔table regression class stays
        // covered.
        expect(src).toMatch(
            /<DataTable[\s\S]{0,300}data=\{(visibleEvidence|displayEvidence)\}/,
        );
    });

    it('keeps the columns dropdown out of the gallery view', () => {
        // The columns dropdown is only meaningful for the list view —
        // hiding it under viewMode === 'list' is the correct shape.
        // R10-PR6 unified the mount via `useColumnsDropdown` returning a
        // `dropdown` node; R-filter-gear (2026-06-07) renders BOTH gears
        // (filter + columns) as a fragment under the same list guard.
        // Accept any of those shapes — the invariant is `columnsDropdown`
        // stays gated behind `viewMode === 'list'`.
        expect(src).toMatch(
            /viewMode === ['"]list['"][\s\S]{0,300}columnsDropdown/,
        );
    });

    it('adds a freshness column to the list view', () => {
        // `id: 'freshness'` was added to evidenceColumnConfig.all and
        // evidenceColumnDropdown so the column reads cleanly through
        // the existing visibility plumbing.
        expect(src).toContain("id: 'freshness'");
        expect(src).toMatch(/<FreshnessBadge[\s\S]{0,400}lastRefreshedAt=/);
    });

    it('passes a fileUrl resolver that pins to the existing download route', () => {
        // The gallery must NOT invent a parallel preview API. It
        // re-uses the tenant-scoped download endpoint that already
        // serves images inline + redirects S3-hosted files.
        expect(src).toContain('/evidence/files/');
        expect(src).toContain('/download');
    });
});
