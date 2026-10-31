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
import { twMerge } from 'tailwind-merge';

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
     * timed out at 180s — three specs failed that way, 213 passed.
     *
     * THE HEIGHT IS RESOLVED WITH `twMerge`, NOT GUESSED FROM THE SOURCE, and
     * that is the whole point of this test's shape. The first version of it read
     * the file for `/leading-6/` and multiplied — which was wrong twice over:
     * `leading-6` occurs twice in this file (the shared cell base and the
     * footer), so a boolean `.test()` could not tell which it had found; and the
     * header does not end up with `leading-6` AT ALL. `cn` is
     * `twMerge(clsx(...))`, Tailwind's `text-*` utilities set line-height as well
     * as font-size, and tailwind-merge therefore DROPS an earlier `leading-6`
     * when the th adds `text-xs`. The merged class is
     *
     *     py-2.5 text-left whitespace-nowrap … sticky top-0 z-20 group/th text-xs …
     *
     * with no leading class, which matches the rendered `<th>` in the E2E log
     * exactly. So the header is `py-2.5` (20px) + text-xs's 16px line-height +
     * `border-b` (1px) = 37px, and the ~45px figure in `table.tsx`'s older
     * comment is the CELL height (text-sm/leading-6), not the header's.
     *
     * Which also means the long-removed `scroll-pt-[37px]` was RIGHT for this
     * header, and the note calling it "8px short" was comparing against the
     * wrong element.
     */
    test('the scroll container clears the sticky header it scrolls rows under', () => {
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/table/table.tsx'),
            'utf-8',
        ));

        // BOUNDED READS of the two specific literals, not whole-file needles.
        // The shared cell base is the one carrying the py/text/leading triplet;
        // the header's own additions are the literal carrying `sticky top-0`.
        const baseLit = /"(py-2\.5 text-left[^"]*)"/.exec(src);
        const thLit = /"(sticky top-0[^"]*)"/.exec(src);
        const thFont = /"(text-xs[^"]*)"/.exec(src);
        expect(baseLit).not.toBeNull();
        expect(thLit).not.toBeNull();
        expect(thFont).not.toBeNull();

        // Resolved by the SAME function production uses, so this test cannot
        // disagree with the browser about which utilities survive.
        const merged = twMerge(baseLit![1], 'border-l border-b px-4', thLit![1], thFont![1]);

        // The header must still be sticky, or there is nothing to clear and this
        // test would pass over a changed design without saying so.
        expect(merged).toMatch(/\bsticky\b/);
        expect(merged).toMatch(/\btop-0\b/);

        // Height, from what actually survives the merge.
        const padM = /\bpy-(\d+(?:\.\d+)?)\b/.exec(merged);
        expect(padM).not.toBeNull();
        const padY = Number(padM![1]) * 4 * 2; // Tailwind: py-N = N*0.25rem per side

        // Line-height: an explicit `leading-N` if one survives, otherwise the
        // one implied by the surviving font-size utility.
        const leadM = /\bleading-(\d+)\b/.exec(merged);
        const FONT_LINE_HEIGHT: Record<string, number> = {
            'text-xs': 16, 'text-sm': 20, 'text-base': 24, 'text-lg': 28,
        };
        const fontM = /\btext-(xs|sm|base|lg)\b/.exec(merged);
        const lineHeight = leadM
            ? Number(leadM[1]) * 4
            : FONT_LINE_HEIGHT[`text-${fontM?.[1]}`];
        expect(lineHeight).toBeGreaterThan(0);

        const headerHeight = padY + lineHeight + 1; // + border-b

        // What the scrolling region actually declares.
        const m = /scroll-pt-\[(\d+)px\]/.exec(src);
        expect(m).not.toBeNull();
        const scrollPad = Number(m![1]);

        // THE INEQUALITY is the assertion. A literal would pass while somebody
        // made the header taller than its padding — which is exactly how the
        // 37px version came to be described as short.
        expect({ scrollPad, headerHeight, clears: scrollPad >= headerHeight })
            .toEqual({ scrollPad, headerHeight, clears: true });

        // And the inputs are pinned, so a change to either recomputes rather
        // than silently shifting the floor under the inequality.
        expect({ padY, lineHeight }).toEqual({ padY: 20, lineHeight: 16 });
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
            codeOf(s);
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
