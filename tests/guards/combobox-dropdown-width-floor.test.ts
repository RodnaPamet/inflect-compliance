/**
 * Combobox dropdown width must be a FLOOR, never an exact match.
 *
 * Recurring bug (reported repeatedly): `matchTriggerWidth` pinned the
 * dropdown to the trigger's EXACT width
 * (`w-[var(--radix-popover-trigger-width)]`), so a tiny trigger like
 * "Select…" clipped its option text (e.g. "1–50 employees" rendered as a
 * wrapped, cut-off "1–50 employee").
 *
 * The fix makes `matchTriggerWidth` a MINIMUM width
 * (`min-w-[var(--radix-popover-trigger-width)]`) AND lets the size
 * container measure content width on desktop, so EVERY combobox dropdown
 * (the shared primitive behind UserCombobox / AsyncCombobox / EntityPicker
 * / every form select) grows to fit its options — capped to the viewport.
 *
 * This ratchet locks that in: the dropdown may pin a MINIMUM to the trigger
 * width, but must never re-introduce an exact `w-[trigger-width]`.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const SRC = codeOf(fs.readFileSync(
    path.resolve(__dirname, '../../src/components/ui/combobox/index.tsx'),
    'utf8',
));

describe('combobox dropdown width is a floor, not an exact trigger match', () => {
    it('uses min-w (a floor) for matchTriggerWidth', () => {
        expect(SRC).toMatch(/min-w-\[var\(--radix-popover-trigger-width\)\]/);
    });

    it('never pins the dropdown to the EXACT trigger width', () => {
        // `w-[var(--radix-popover-trigger-width)]` NOT preceded by `min-`
        // is the exact-width form that clips narrow dropdowns.
        const exactWidth = /(?<!min-)\bw-\[var\(--radix-popover-trigger-width\)\]/;
        expect(SRC).not.toMatch(exactWidth);
    });

    it('measures content width on desktop so the dropdown grows to fit options', () => {
        // The AnimatedSizeContainer must size to content (not be disabled
        // when matchTriggerWidth is set) — that growth + the min-w floor is
        // what stops the truncation.
        expect(SRC).toMatch(/width=\{!isMobile\}/);
    });

    it('floors the MEASURED content (Command) to the trigger width so the row highlight spans the full dropdown', () => {
        // AnimatedSizeContainer sizes to the natural CONTENT width. The popover
        // wrapper carries the trigger-width floor, but the measured <Command>
        // did not — so the option rows + selected/hover highlight rendered only
        // as wide as the longest label, covering ~half of a wider
        // matchTriggerWidth dropdown. The <Command> root must carry the same
        // floor so the list (and its highlight) fills the full popover width.
        const commandFloor =
            /<Command\s+loop[\s\S]{0,1300}?min-w-\[var\(--radix-popover-trigger-width\)\]/;
        expect(SRC).toMatch(commandFloor);
    });
});
