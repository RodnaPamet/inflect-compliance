/**
 * UI roadmap 20 — canonical tooltips on the table/filter chrome.
 *
 * The column-toggle + filter-card + edit-columns gear buttons used native
 * `title=` because naively wrapping a Popover trigger in <Tooltip> swallowed the
 * open onClick. They now use the canonical Tooltip via the Popover's
 * `triggerTooltip` prop (Tooltip OUTER → Popover.Trigger INNER), proven to still
 * open by tests/rendered/popover-trigger-tooltip.test.tsx.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('UI-20 — Popover supports a canonical triggerTooltip', () => {
    const pop = read('src/components/ui/popover.tsx');
    it('Popover exposes triggerTooltip and wraps the Trigger element in <Tooltip>', () => {
        expect(pop).toMatch(/triggerTooltip\?:\s*string/);
        expect(pop).toMatch(/<Tooltip content=\{triggerTooltip\}>/);
    });
});

describe('UI-20 — gear buttons use the canonical tooltip, not native title', () => {
    it('ChecklistGearButton passes triggerTooltip and drops native title', () => {
        const src = read('src/components/ui/checklist-gear-button.tsx');
        expect(src).toMatch(/triggerTooltip=\{title\}/);
        expect(src).not.toMatch(/\btitle=\{title\}/);
    });
    it('EditColumnsButton passes triggerTooltip and drops native title', () => {
        const src = read('src/components/ui/table/edit-columns-button.tsx');
        expect(src).toMatch(/triggerTooltip=\{title\}/);
        expect(src).not.toMatch(/\btitle=\{title\}/);
    });
});
