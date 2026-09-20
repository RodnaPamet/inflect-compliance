/**
 * Roadmap-2 PR-10 — skeleton-shape parity.
 *
 * Skeletons should be the page in negative — a list page shows
 * row skeletons of the right column widths, a detail page shows
 * hero + tab-bar + body skeleton. Several skeleton primitives
 * already exist (`SkeletonDetailPage`, `SkeletonTable`,
 * `SkeletonCard`, `ShimmerDots`); they were correct in pieces and
 * inconsistent in composition. This PR locks the WIRING so the
 * layout primitives own the choice — pages don't decide the
 * skeleton shape per call site.
 *
 * What this ratchet locks in
 *
 *   1. `<EntityDetailLayout loading>` renders the canonical
 *      `DetailLoadingSkeleton` body shape (hero + tab-bar +
 *      content card) — never a generic spinner. Removing the
 *      skeleton-render path from the shell would silently
 *      regress every detail page's loading state.
 *
 *   2. `<DataTable loading>` exposes the `loading` prop so the
 *      table draws its own skeleton rows of the right column
 *      widths. Pages that own a list view don't reach for
 *      `<SkeletonTable>` directly — they pass `loading={true}`
 *      through to the table, which paints the negative shape.
 *
 *   3. The `loading` slot is documented in `EntityListPage`'s
 *      table prop pick — passing `loading` flows through to
 *      DataTable. Pages that DO want a custom skeleton (rare,
 *      e.g. multi-section dashboards) opt out by simply not
 *      passing `loading` and rendering their own.
 *
 * What this ratchet does NOT police
 *
 *   Custom dashboards (Coverage, admin/api-keys, admin/notifications,
 *   admin/integrations) compose multiple sections — they render
 *   their own skeletons because the layout primitives can't
 *   predict the multi-section shape. They're explicitly out of
 *   scope and not on this ratchet's adoption list.
 *
 *   Dynamic-imported components (e.g. RiskTreatmentPlanCard,
 *   TraceabilityPanel) legitimately pass `<SkeletonCard>` /
 *   `<SkeletonRow>` as their `loading:` placeholder. That's the
 *   right pattern — the chunk hasn't loaded yet so the parent
 *   layout can't paint the right shape.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const ENTITY_DETAIL_LAYOUT = 'src/components/layout/EntityDetailLayout.tsx';
const ENTITY_LIST_PAGE = 'src/components/layout/EntityListPage.tsx';
const DATA_TABLE = 'src/components/ui/table/data-table.tsx';

describe('Skeleton-shape parity (Roadmap-2 PR-10)', () => {
    it('EntityDetailLayout exposes a `loading` prop in its public type', () => {
        const src = read(ENTITY_DETAIL_LAYOUT);
        // The slot must be in the exported props interface so call
        // sites compile-check against it.
        expect(src).toMatch(/loading\?:\s*boolean/);
    });

    it('EntityDetailLayout renders DetailLoadingSkeleton when loading=true', () => {
        const src = read(ENTITY_DETAIL_LAYOUT);
        // Two things must be true:
        //   - There is a guarded `if (loading) { return … }` block.
        //   - That block mounts `<DetailLoadingSkeleton …>`.
        expect(src).toMatch(/if\s*\(\s*loading\s*\)/);
        expect(src).toMatch(/<DetailLoadingSkeleton\b/);
    });

    it('DetailLoadingSkeleton paints the page-shape (hero + tabs + body), not a spinner', () => {
        const src = read(ENTITY_DETAIL_LAYOUT);
        // The skeleton has a tab-strip placeholder (loop over
        // `tabCount`) and a content card. A regression that
        // collapses it into a single spinner would lose the
        // shape-parity property the ratchet is named after.
        expect(src).toMatch(/function\s+DetailLoadingSkeleton/);
        expect(src).toMatch(/Array\.from\(\{\s*length:\s*tabCount\s*\}\)/);
    });

    it('EntityListPage forwards `loading` through to DataTable', () => {
        const src = read(ENTITY_LIST_PAGE);
        // The Pick<DataTableProps, …> union must include 'loading'
        // so EntityListPage callers can pass it through.
        expect(src).toMatch(/['"]loading['"]/);
        // And the union must include error / emptyState too —
        // these three together are the lifecycle slots a list
        // page hands to the layout.
        expect(src).toMatch(/['"]error['"]/);
        expect(src).toMatch(/['"]emptyState['"]/);
    });

    it('DataTable owns its `loading` prop on the public surface', () => {
        const src = read(DATA_TABLE);
        expect(src).toMatch(/loading\?:\s*boolean/);
    });
});
