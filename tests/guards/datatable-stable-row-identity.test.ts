/**
 * Double-click-to-open depends on STABLE table-model identities.
 *
 * ─── The failure mode ───────────────────────────────────────────────
 *
 * DataTable's click model (R13-PR14): a single click toggles row
 * selection, a double-click navigates. So a real double-click fires
 * `onClick` twice (select → deselect) and `onDoubleClick` once — which
 * means the row RE-RENDERS between the two clicks.
 *
 * If the page hands DataTable a fresh `columns` / `onRowClick` /
 * `getRowId` identity on that re-render, the table model is rebuilt
 * mid-double-click, the row's DOM node is replaced, and the browser
 * never fires `dblclick` at all — because the two clicks no longer
 * share a live common ancestor. Navigation silently dies.
 *
 * The sharpest version of this is indirect: a page whose column `useMemo`
 * lists an UNSTABLE value in its dep array (e.g. a `tenantHref` defined
 * as a bare arrow instead of a `useCallback`) rebuilds its columns on
 * every render, not just on selection changes.
 *
 * That is exactly how `PoliciesClient` regressed — `tenantHref` was a
 * plain arrow, it sat in `policyColumns`' dep array, so the memo never
 * held. `tests/e2e/data-table-platform.spec.ts` ("Policies row
 * double-click navigates to detail") was red on main for it.
 *
 * ─── Why a guard ────────────────────────────────────────────────────
 *
 * Nothing below the E2E layer catches this: tsc is happy, the component
 * renders fine, and unit/rendered tests don't perform a real two-click
 * gesture against a live table model. The E2E is a slow, expensive net.
 * This is the cheap one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Every list client that hands `DataTable` a row action.
 *
 * Originally this listed only the two pages the E2E asserts. That was
 * too narrow: a survey after the PoliciesClient fix found ELEVEN more
 * clients carrying the same shape, two of them (`TasksClient`,
 * `VendorsClient`) byte-for-byte identical to the regression — a bare
 * `tenantHref` arrow sitting inside the column memo's dep array. They
 * were invisible only because no E2E exercised them.
 *
 * The list is now the full population rather than the E2E-covered
 * subset, so "has a test" and "is protected" stop being different
 * things. A new list client must be added here.
 */
const DBLCLICK_LIST_CLIENTS = [
    'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx',
    'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
    'src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx',
    'src/app/t/[tenantSlug]/(app)/incidents/IncidentsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
    'src/app/t/[tenantSlug]/(app)/processes/RulesTab.tsx',
    'src/app/t/[tenantSlug]/(app)/risks/ai-systems/AiSystemsClient.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/business-continuity/BusinessContinuityClient.tsx',
    'src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx',
] as const;

/**
 * Both ways a page can hand DataTable a prop:
 *   • JSX          — `<DataTable onRowClick={(row) => …} />`
 *   • object form  — `table={{ onRowClick: (row) => … }}` via
 *                    `EntityListPage`, which spreads `table` straight
 *                    into `<DataTable {...table} />`.
 * The original guard only checked the object form, so every JSX-form
 * page passed while broken. Check both.
 */
function inlineArrowPatterns(prop: string): RegExp[] {
    return [
        new RegExp(`${prop}=\\{\\s*\\(`), // JSX:    onRowClick={(row) => …
        new RegExp(`${prop}:\\s*\\(`), //   object: onRowClick: (row) => …
        new RegExp(`${prop}=\\{\\s*async\\s*\\(`),
        new RegExp(`${prop}:\\s*async\\s*\\(`),
    ];
}

describe('DataTable double-click — stable row identities', () => {
    for (const rel of DBLCLICK_LIST_CLIENTS) {
        describe(path.basename(rel), () => {
            const src = read(rel);

            for (const prop of ['onRowClick', 'getRowId', 'onRowPrefetch'] as const) {
                it(`does not pass an inline arrow as ${prop}`, () => {
                    // An inline arrow mints a new function identity per
                    // render, which rebuilds the table model.
                    for (const re of inlineArrowPatterns(prop)) {
                        expect({ prop, pattern: String(re), matched: re.test(src) })
                            .toEqual({ prop, pattern: String(re), matched: false });
                    }
                });
            }

            it('does not call orderColumns inline where the result is a prop', () => {
                // `orderColumns` spreads its input (`checklist-order.ts`:
                // `const result = [...columns]`), so it returns a NEW array
                // on every call — even when the inner column `useMemo`
                // holds perfectly. `columns={orderColumns(cols)}` therefore
                // rebuilds the table model every render, and no amount of
                // memoising the columns themselves helps.
                //
                // This one is invisible to the dep-array check below,
                // because the instability is introduced at the CALL SITE.
                expect(src).not.toMatch(/columns=\{\s*orderColumns\(/);
                expect(src).not.toMatch(/columns:\s*orderColumns\(/);
            });

            it('defines tenantHref as a stable callback, not a bare arrow', () => {
                // The regression: `const tenantHref = (path: string) => …`
                // is recreated every render, and it sits in the column
                // memo's dep array — so the memo never holds.
                //
                // Not every list client needs a `tenantHref` (some open a
                // sheet rather than navigate), so this is conditional —
                // but if one exists it must be the stable form.
                if (!/const\s+tenantHref\s*=/.test(src)) return;
                expect(src).not.toMatch(/const\s+tenantHref\s*=\s*\(/);
                expect(src).toMatch(
                    /const\s+tenantHref\s*=\s*(useCallback\(|useTenantHref\(\))/,
                );
            });

            it('memoises anything it lists as a column-memo dependency', () => {
                // Every identifier in the columns `useMemo` dep array must
                // itself be stable. We can't prove that statically in
                // general, but we CAN require that the dep array contains
                // no bare arrow-defined local — which is the shape that bit
                // us. Assert each dep resolves to a const declared with
                // useMemo / useCallback / a hook call, or is a primitive
                // like a state value.
                const depMatch = src.match(
                    /\]\)\s*,\s*\[([^\]]*)\]\)\s*;/,
                );
                // Not every page shapes its memo identically; when we can't
                // find the dep array, the assertions above still hold.
                if (!depMatch) return;
                const deps = depMatch[1]
                    .split(',')
                    .map((d) => d.trim())
                    .filter(Boolean);
                for (const dep of deps) {
                    const bareArrow = new RegExp(
                        `const\\s+${dep.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=\\s*\\([^)]*\\)\\s*=>`,
                    );
                    expect(src).not.toMatch(bareArrow);
                }
            });
        });
    }

    it('the E2E that catches this at runtime still exists', () => {
        // If someone deletes the spec, this guard is the only remaining
        // protection — and it should not be silently load-bearing.
        const spec = read('tests/e2e/data-table-platform.spec.ts');
        expect(spec).toMatch(/Policies row double-click navigates to detail/);
        expect(spec).toMatch(/Controls row double-click navigates to detail/);
    });
});
