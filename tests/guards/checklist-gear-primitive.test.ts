/**
 * checklist-gear-primitive (2026-06-07) — structural locks on the shared
 * <ChecklistGearButton> that BOTH toolbar gears (Edit filter cards +
 * Toggle columns) trigger through. The rendered behaviour (trigger
 * test-id, ring, two-gear render) is in
 * `tests/rendered/checklist-gear-primitive.test.tsx`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const PRIMITIVE = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/ui/checklist-gear-button.tsx'),
    'utf8',
));

describe('ChecklistGearButton — structural locks', () => {
    it('forwards test-id + aria-label + icon to the trigger; hint via triggerTooltip', () => {
        expect(PRIMITIVE).toMatch(/data-testid=\{testId\}/);
        // UI-20: the hover hint is now the canonical Tooltip, composed via the
        // Popover's `triggerTooltip` prop (not a native `title=` on the button).
        expect(PRIMITIVE).toMatch(/triggerTooltip=\{title\}/);
        expect(PRIMITIVE).not.toMatch(/title=\{title\}/);
        expect(PRIMITIVE).toMatch(/aria-label=\{title\}/);
        expect(PRIMITIVE).toMatch(/icon=\{icon\}/);
    });
    it('rings the trigger when modified', () => {
        expect(PRIMITIVE).toMatch(/someModified/);
        expect(PRIMITIVE).toMatch(/ring-1 ring-\[var\(--brand-default\)\]\/30/);
    });
    it('renders a numbered order badge per row', () => {
        expect(PRIMITIVE).toMatch(/\{item\.order \?\? ''\}/);
    });
    it('has a reset row gated on onReset + someModified', () => {
        expect(PRIMITIVE).toMatch(/onReset && someModified/);
        expect(PRIMITIVE).toMatch(/data-testid="checklist-reset"/);
    });
    it('does NOT import or render a Tooltip (Popover.Trigger prop-swallow trap)', () => {
        // Strip comments first — the doc-comment legitimately MENTIONS
        // <Tooltip> to explain why the trigger avoids it.
        const code = PRIMITIVE.replace(/\/\*[\s\S]*?\*\//g, '').replace(
            /\/\/[^\n]*/g,
            '',
        );
        expect(code).not.toMatch(/import[^;]*\bTooltip\b[^;]*from/);
        expect(code).not.toMatch(/<Tooltip\b/);
    });

    it('supports drag-to-reorder via a drag handle on visible rows', () => {
        expect(PRIMITIVE).toMatch(/onReorder\?:/);
        expect(PRIMITIVE).toMatch(/onReorder && item\.visible/);
        expect(PRIMITIVE).toMatch(/draggable/);
        expect(PRIMITIVE).toMatch(/onDrop=/);
        expect(PRIMITIVE).toMatch(/GripVertical/);
    });
});
