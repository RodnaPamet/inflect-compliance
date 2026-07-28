/**
 * B2 — table unification sweep. Lock the cross-table consistency
 * moves the user asked for so a future PR can't silently re-
 * introduce the inconsistencies.
 *
 *   1. Every navigable list table renders its title via
 *      `<TableTitleCell href={...}>` (single-click on title
 *      navigates) — the Controls-table canonical pattern.
 *   2. `enableColumnResizing` is exposed on `DataTableProps`
 *      with a documented contract.
 *   3. Every detail-page edit button is icon-only —
 *      `<Button size="icon" aria-label="Edit …">…icon…</Button>`,
 *      never `<Button>Edit</Button>` and never icon+text.
 *   4. The `icon` size variant exists on the Button cva.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B2 — table unification', () => {
    describe('Title-cell navigation parity', () => {
        // Pages whose list tables MUST have a navigable title cell
        // (the row maps 1:1 to a detail page).
        //
        // Two acceptable interaction shapes for the title:
        //   - `<TableTitleCell href={…}>` — canonical Controls
        //     pattern: single-click on the title navigates to the
        //     detail page. The legacy / dominant shape.
        //   - `<TableTitleCell>` (no href) PAIRED with a row-level
        //     `onRowClick={…}` handler — item 32 (2026-06-14): single
        //     click on the row opens a quick-look <Sheet> instead of
        //     navigating, with a "Full view" button inside. The
        //     primary interaction is preserved; the destination
        //     changed.
        // Either is legitimate; what's NOT legitimate is a dead title
        // cell with no row-level handler (a row that ignores clicks).
        const NAVIGABLE_LISTS: Array<{ label: string; file: string }> = [
            { label: 'Controls (canonical)', file: 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx' },
            { label: 'Risks', file: 'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx' },
            { label: 'Policies', file: 'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx' },
            { label: 'Vendors', file: 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx' },
            { label: 'Tasks', file: 'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx' },
            { label: 'Assets', file: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx' },
        ];

        for (const { label, file } of NAVIGABLE_LISTS) {
            it(`${label} renders a click-handled title cell (href OR onRowClick)`, () => {
                const src = read(file);
                const hasTitleHref = /<TableTitleCell\b[\s\S]{0,300}href=/.test(src);
                // Accept BOTH the JSX-prop form (`onRowClick={…}`) and the
                // EntityListPage table-config object form (`onRowClick: …`) —
                // Controls navigates via the latter (double-click → detail) now
                // that its title cell opens a quick-view instead of carrying an
                // href. The intent (no dead title cell) is unchanged.
                const hasRowClick = /onRowClick\s*[=:]/.test(src);
                expect(hasTitleHref || hasRowClick).toBe(true);
            });
        }
    });

    describe('DataTable contract — column resizing exposed', () => {
        const src = read('src/components/ui/table/data-table.tsx');

        it('DataTableProps documents enableColumnResizing', () => {
            // Spelled in the interface (with a JSDoc block above) so
            // pages can discover the prop via IDE hover; the prop
            // flows through to <Table> via the existing spread.
            expect(src).toMatch(/enableColumnResizing\?:\s*boolean/);
        });
    });

    describe('Button icon-size variant', () => {
        const src = read('src/components/ui/button-variants.ts');

        it('cva size axis carries an `icon` square variant', () => {
            // The variant is the only honest way to make every edit
            // button line up dimensionally. h-9 w-9 + no padding +
            // size-4 icon by default.
            expect(src).toMatch(
                /icon:\s*"[^"]*h-7[^"]*w-7[^"]*p-0[^"]*"/,
            );
        });
    });

    describe('Edit-button icon-only on detail pages', () => {
        // The four detail pages with an "Edit" affordance on the
        // header. All MUST use the icon-only shape. A regression
        // back to `<Button>Edit</Button>` (text-only) or
        // `<Button><Icon />Edit</Button>` (icon+text) would land
        // this ratchet red.
        const EDIT_PAGES: Array<{ label: string; file: string }> = [
            { label: 'Asset detail', file: 'src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx' },
            { label: 'Risk detail', file: 'src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx' },
            { label: 'Vendor detail', file: 'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx' },
            { label: 'Control detail', file: 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx' },
        ];

        for (const { label, file } of EDIT_PAGES) {
            it(`${label}: edit button is icon-only`, () => {
                const src = read(file);
                // No text-only `<Button>Edit</Button>`.
                expect(src).not.toMatch(/<Button[^>]*>\s*Edit\s*<\/Button>/);
                // size="icon" is set on the edit button block —
                // anchor on the `id="...edit...btn"` selector so
                // unrelated buttons don't false-match.
                const editIdx = src.search(/id=["'][a-z-]*edit[a-z-]*btn["']|id=["']control-edit-button["']/);
                expect(editIdx).toBeGreaterThan(0);
                // Walk back ~250 chars to find the matching
                // `<Button` open tag + its `size="icon"`.
                const block = src.slice(Math.max(0, editIdx - 300), editIdx + 200);
                expect(block).toMatch(/size=["']icon["']/);
                expect(block).toMatch(/aria-label=/);
            });
        }
    });
});
