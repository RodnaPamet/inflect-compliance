/**
 * Elevation PR-10 — Sortable-column affordance ratchet.
 *
 * The convention
 *   Every sortable column header MUST render a sort indicator at all
 *   times — faint when the column is inactive, full-opacity when it
 *   is the current sort. Without this, users cannot tell which
 *   columns are sortable until they already clicked one. The icon
 *   itself MUST use a semantic content token (`text-content-emphasis`,
 *   `text-content-muted`, `text-content-subtle`), not raw palette
 *   classes that don't re-tone with the theme.
 *
 * What this ratchet detects
 *   1. `packages/ui/src/components/ui/icons/sort-order.tsx` — colour token.
 *      Bans `text-neutral-*` / `text-slate-*` / `text-gray-*` / hex
 *      colour literals on the SVG. Forces `text-content-*` use.
 *
 *   2. `src/components/ui/table/table.tsx` — render shape.
 *      The `<SortOrder …>` invocation must NOT be guarded by an
 *      equality check on the column id alone. The renderer must
 *      pass `null` when inactive (handled inside SortOrder), so the
 *      indicator is always visible at low opacity.
 *
 * What this ratchet does NOT police
 *   App-level table headers that bypass `<DataTable>` / `<Table>`
 *   (none today — Epic 52 ratchet keeps that surface zero).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SORT_ICON = 'packages/ui/src/components/ui/icons/sort-order.tsx';
const TABLE = 'src/components/ui/table/table.tsx';

const PALETTE_RE = /\btext-(neutral|slate|gray)-/;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;

describe('Sortable-column affordance (Elevation PR-10)', () => {
    it('SortOrder uses semantic content tokens (no palette / hex)', () => {
        const abs = path.resolve(ROOT, SORT_ICON);
        expect(fs.existsSync(abs)).toBe(true);
        const content = fs.readFileSync(abs, 'utf8');
        const offenders: string[] = [];
        content.split('\n').forEach((line, i) => {
            const trimmed = line.trim();
            if (
                trimmed.startsWith('//') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('/*')
            )
                return;
            if (PALETTE_RE.test(line)) {
                offenders.push(`${SORT_ICON}:${i + 1} [palette] ${trimmed}`);
            }
            if (HEX_RE.test(line)) {
                offenders.push(`${SORT_ICON}:${i + 1} [hex] ${trimmed}`);
            }
        });
        if (offenders.length > 0) {
            throw new Error(
                `SortOrder must use semantic content tokens (text-content-emphasis / -muted / -subtle). Offenders:\n${offenders.join('\n')}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('table.tsx renders SortOrder on every sortable column, not only the active one', () => {
        const abs = path.resolve(ROOT, TABLE);
        expect(fs.existsSync(abs)).toBe(true);
        const content = fs.readFileSync(abs, 'utf8');

        // The renderer must guard ONLY on `isSortableColumn`. The
        // legacy form `isSortableColumn && sortBy === header.column.id`
        // hides the affordance from inactive sortable columns and
        // re-introduces the regression PR-10 fixes.
        const legacy =
            /isSortableColumn\s*&&\s*\n?\s*sortBy\s*===\s*header\.column\.id\s*&&\s*\(\s*\n?\s*<SortOrder/;
        expect(legacy.test(content)).toBe(false);

        // Positive proof — the `<SortOrder` element exists and is
        // wrapped in a single isSortableColumn guard.
        const positive =
            /isSortableColumn\s*&&\s*\(\s*\n?\s*<SortOrder/;
        expect(positive.test(content)).toBe(true);
    });
});
