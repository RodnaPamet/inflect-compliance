/**
 * Roadmap-12 PR-2 — DataTable uniform row height.
 *
 * Pre-R12 the DataTable primitive set `py-2.5 leading-6 text-sm` on
 * every `<td>`, giving a uniform 44-px row height baseline. But two
 * pages broke uniformity by rendering BLOCK elements inside their
 * title cell — Policies had a `<p>` description below the title
 * link, pushing rows to ~60px. Users compared Policies side-by-side
 * with Controls and saw "the tables look different."
 *
 * R12-PR2 fixes the visible drift (Policies title cell drops the
 * block-level description) and locks two invariants:
 *
 *   1. **Primitive baseline.** The cell base class string contains
 *      the canonical `py-2.5 leading-6 text-sm` triplet. A future
 *      tidy-up that reduces padding or bumps line-height would
 *      reshape every row by accident.
 *
 *   2. **No block-level descriptions under title cells.** A title-
 *      cell render that introduces a `<p>` or `<div>` block below
 *      the title link breaks row uniformity. The ratchet scans for
 *      the prior Policies-style anti-pattern.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

describe('DataTable uniform row height (R12-PR2)', () => {
    test('Table primitive preserves the canonical cell baseline (py-2.5 leading-6 text-sm)', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/table.tsx'),
            'utf-8',
        ));
        // The base cell-class array contains the three load-bearing
        // tokens that together determine row height (~44px):
        //   py-2.5      → 10px vertical padding (top+bottom)
        //   leading-6   → 24px line-height
        //   text-sm     → 14px font size (controls actual line box)
        expect(src).toMatch(/py-2\.5/);
        expect(src).toMatch(/leading-6/);
        expect(src).toMatch(/text-sm/);
    });

    test('the cell baseline string carries all three tokens TOGETHER (one block)', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/table.tsx'),
            'utf-8',
        ));
        // Stricter: the three must appear in the same className
        // string. A future PR that pulls one out into a different
        // class array would fail this assertion.
        expect(src).toMatch(/py-2\.5\s+text-left\s+text-sm\s+leading-6/);
    });

    /**
     * The scroll padding covers the sticky header (#3524).
     *
     * This belongs in a row-HEIGHT guard because it is the same arithmetic. The
     * header cells are `sticky top-0 z-20`, so anything that scrolls a row into
     * view inside the clamped region parks that row flush against the container
     * top — which is UNDERNEATH the header — unless the container carries scroll
     * padding at least as tall as the header.
     *
     * The failure is silent, which is why it needs a guard. The row is genuinely
     * visible, enabled and stable; the header merely sits on top of it and takes
     * the click. Nothing throws. In the E2E run that found this, Playwright
     * reported the intercepting `<th>` 373 times in a single attempt and then
     * timed out at 180s, and three specs failed that way with 213 passing.
     *
     * ASSERTED AS AN INEQUALITY, not as a literal. `scroll-pt-[45px]` written as
     * a string would pass while somebody changed `py-2.5` to `py-4` and made the
     * header taller than the padding — the exact way the previous attempt went
     * wrong. That one was `scroll-pt-[37px]` against a 45px header: 8px short,
     * recorded in `table.tsx`'s own comment, and then removed along with the
     * scroll-snap it was grouped with. So both numbers are DERIVED from the
     * classes that produce them and compared.
     */
    test('the scroll container clears the sticky header it scrolls rows under', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/table.tsx'),
            'utf-8',
        ));

        // The header must actually be sticky, or there is nothing to clear and
        // this test would pass over a changed design without saying so.
        expect(src).toMatch(/sticky\s+top-0/);

        // Header height, from the classes that set it. Tailwind: py-N is
        // N*0.25rem per side, leading-N is N*0.25rem, border-b is 1px.
        const headerPadY = /py-2\.5/.test(src) ? 2.5 * 4 * 2 : NaN;
        const headerLeading = /leading-6/.test(src) ? 6 * 4 : NaN;
        expect(Number.isNaN(headerPadY)).toBe(false);
        expect(Number.isNaN(headerLeading)).toBe(false);
        const headerHeight = headerPadY + headerLeading + 1; // + border-b

        // The scroll padding actually present on the scrolling region.
        const m = /scroll-pt-\[(\d+)px\]/.exec(src);
        expect(m).not.toBeNull();
        const scrollPad = Number(m![1]);

        expect({ scrollPad, headerHeight }).toEqual({
            scrollPad: expect.any(Number),
            headerHeight: 45,
        });
        expect(scrollPad).toBeGreaterThanOrEqual(headerHeight);
    });

    test('no entity list page renders a multi-line title cell via block-level description', () => {
        // Catches the Policies-style anti-pattern: title-cell renders
        // a `<p>` description below the title link. The block element
        // pushes row height past the primitive's 44px baseline.
        //
        // Heuristic: a title-cell `cell: ({ ... }) => <div>...<Link>...
        // </Link>...<p` shape is the regression we lock against.
        const titleCellPages = [
            'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
            'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
            'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
            'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
            'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx',
            'src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx',
            'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
        ];
        const offenders: string[] = [];
        // Anti-pattern: title cell renders `</Link>...<p` (a `<p>` block
        // following the title `<Link>` in the same cell). Stripped of
        // comments first so doc-block examples don't false-positive.
        const stripComments = (s: string) =>
            s
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
        const ANTI_PATTERN = /<\/Link>[\s\S]{0,200}<p\b/;
        for (const rel of titleCellPages) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) continue;
            const src = stripComments(codeOf(fs.readFileSync(abs, 'utf-8')));
            // Narrow to a window around the title cell — find the
            // `accessorKey: 'title'` or `id: 'title'` cell function
            // and search within the next ~600 chars.
            const titleCellMatch = src.match(
                /(?:accessorKey|id):\s*['"](title|name|code)['"][\s\S]{0,600}/,
            );
            if (!titleCellMatch) continue;
            if (ANTI_PATTERN.test(titleCellMatch[0])) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} list page(s) render a block-level <p> below the title cell — this breaks row-height uniformity:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: drop the description from the title cell (Policies R12-PR2 pattern) OR move it to its own column. The DataTable primitive guarantees uniform row height only when cells stay single-line.',
            );
        }
    });
});
